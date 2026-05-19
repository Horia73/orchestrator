import {
  getConfig,
  getApiKey,
  isFileSupportedByProvider,
  getEffectiveAgentSettings,
} from "@/lib/config"
import { getProvider } from "@/lib/ai/providers"
import {
  addMessage,
  updateConversationContextUsage,
  updateInteractionId,
  getInteractionId,
  getConversation,
  createConversation,
} from "@/lib/db"
import type {
  Attachment,
  ContextCompactionReasoningEntry,
  ContextUsageSnapshot,
  Conversation,
  Message,
} from "@/lib/types"
import type {
  AgentRunEvent,
  MessageAttachment,
  ToolStreamDelta,
} from "@/lib/ai/agents/types"
import { orchestrator } from "@/lib/ai/agents/orchestrator"
import { getAgent } from "@/lib/ai/agents/registry"
import type { AgentConfig } from "@/lib/ai/agents/types"
import { MAX_AGENT_DEPTH } from "@/lib/ai/agents/types"
import {
  getToolsForAgent,
  getToolsForBuiltins,
  resolveProviderToolSurface,
} from "@/lib/ai/tools/registry"
import { clearChatStream, registerChatStream } from "@/lib/chat-streams"
import { isUpdateMaintenanceActive } from "@/lib/update/manager"
import {
  logRequestStart,
  logRequestComplete,
  logRequestFail,
  logRequestAbort,
  logToolCall,
} from "@/lib/observability/store"
import { ArtifactParser } from "@/lib/artifacts/parser"
import type { ArtifactOpenAttrs } from "@/lib/artifacts/schema"
import { insertArtifact } from "@/lib/artifacts/store"
import { stripWrappingCodeFence } from "@/lib/artifacts/sanitize"
import { redactToolArgs } from "@/lib/ai/tools/redaction"
import { filterIntegrationToolExposure } from "@/lib/integrations/exposure"
import { resolveExistingUploadPath } from "@/lib/uploads"
import { getEffectiveRegistry } from "@/lib/models/registry"
import { normalizeUsage } from "@/lib/observability/usage-mapper"
import { generateTitle } from "@/lib/utils-chat"
import { getProviderReadiness } from "@/lib/provider-readiness"
import { resolveRequestOrigin } from "@/lib/app-origin"

/** Persist in-progress assistant output periodically so reloads can catch up */
const STREAM_PROGRESS_PERSIST_INTERVAL_MS = 250

/** Format a path for display — relative to cwd when inside, basename for deep absolutes. */
function displayPath(p: string): string {
  if (!p) return ""
  const cwd = process.cwd()
  if (p === cwd) return "."
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1)
  return p
}

/** Build a human-readable title for a tool call from its name + args. */
function buildToolTitle(
  toolName: string,
  args: Record<string, unknown> | undefined
): string {
  const rawPath =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : ""
  const shown = displayPath(rawPath)
  if (toolName === "read_file") return shown ? `Read ${shown}` : "Read file"
  if (toolName === "Read") return shown ? `Read ${shown}` : "Read file"
  if (toolName === "list_dir") return shown ? `List ${shown}` : "List directory"
  if (toolName === "Write") return shown ? `Write ${shown}` : "Write file"
  if (toolName === "Edit") return shown ? `Edit ${shown}` : "Edit file"
  if (toolName === "Bash" || toolName === "shell")
    return typeof args?.command === "string"
      ? `Run ${args.command.slice(0, 80)}`
      : "Run command"
  if (toolName === "Glob")
    return typeof args?.pattern === "string" ? `Glob ${args.pattern}` : "Glob"
  if (toolName === "Grep")
    return typeof args?.pattern === "string" ? `Grep ${args.pattern}` : "Grep"
  if (toolName === "WebFetch")
    return typeof args?.url === "string" ? `Fetch ${args.url}` : "Fetch URL"
  if (toolName === "SetEnv")
    return typeof args?.key === "string" ? `Set env ${args.key}` : "Set env"
  if (toolName === "web_search" || toolName === "WebSearch") {
    const queries = Array.isArray(args?.queries)
      ? args.queries.filter((q) => typeof q === "string")
      : []
    if (queries.length > 0) return `Search ${queries.join(", ").slice(0, 90)}`
    return typeof args?.query === "string"
      ? `Search ${args.query}`
      : "Search web"
  }
  if (toolName === "TodoWrite") return "Update todos"
  if (toolName === "delegate_to") {
    const agentId = typeof args?.agent_id === "string" ? args.agent_id : "agent"
    return `Delegate to ${agentId}`
  }
  if (toolName === "delegate_parallel") {
    const count = Array.isArray(args?.jobs) ? args.jobs.length : 0
    return count > 0
      ? `Delegate ${count} jobs in parallel`
      : "Delegate in parallel"
  }
  if (toolName === "RunActivatedIntegrationTool") {
    return typeof args?.tool_id === "string"
      ? `Run ${args.tool_id}`
      : "Run integration tool"
  }
  return toolName
}

function dedupeTools<T extends { id: string }>(tools: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const tool of tools) {
    if (seen.has(tool.id)) continue
    seen.add(tool.id)
    out.push(tool)
  }
  return out
}

function buildFinalContextUsageSnapshot(args: {
  provider: string
  model: string
  rawUsage: unknown
  contextWindow?: number | null
  requestId: string
  interactionId?: string | null
}): ContextUsageSnapshot | null {
  const usage = normalizeUsage(args.provider, args.rawUsage)
  if (
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.thinkingTokens === null &&
    usage.cachedTokens === null &&
    usage.totalTokens === null
  ) {
    return null
  }
  const visibleOutputTokens =
    args.provider === "openai" &&
    usage.outputTokens !== null &&
    usage.thinkingTokens !== null
      ? Math.max(0, usage.outputTokens - usage.thinkingTokens)
      : usage.outputTokens
  return {
    provider: args.provider,
    model: args.model,
    source: "provider-final",
    accuracy: "actual",
    updatedAt: Date.now(),
    requestId: args.requestId,
    interactionId: args.interactionId ?? undefined,
    contextWindow: args.contextWindow ?? null,
    contextTokens: sumNumbers(usage.inputTokens, visibleOutputTokens),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    cachedTokens: usage.cachedTokens,
    totalTokens: usage.totalTokens,
  }
}

function mergeContextUsage(
  previous: ContextUsageSnapshot | null,
  next: ContextUsageSnapshot
): ContextUsageSnapshot {
  const sameSource = Boolean(
    previous &&
    previous.provider === next.provider &&
    previous.model === next.model
  )
  return {
    ...(sameSource ? (previous ?? {}) : {}),
    ...next,
    last: next.last ?? (sameSource ? previous?.last : null) ?? null,
    total: next.total ?? (sameSource ? previous?.total : null) ?? null,
    threadTokens:
      next.threadTokens ?? (sameSource ? previous?.threadTokens : null) ?? null,
    lastCompactedAt:
      next.lastCompactedAt ??
      (sameSource ? previous?.lastCompactedAt : null) ??
      null,
    compactedCount:
      next.compactedCount ??
      (sameSource ? previous?.compactedCount : undefined),
  }
}

function contextUsageKey(snapshot: ContextUsageSnapshot): string {
  return JSON.stringify({
    provider: snapshot.provider,
    model: snapshot.model,
    source: snapshot.source,
    requestId: snapshot.requestId ?? null,
    interactionId: snapshot.interactionId ?? null,
    threadId: snapshot.threadId ?? null,
    turnId: snapshot.turnId ?? null,
    contextWindow: snapshot.contextWindow ?? null,
    contextTokens: snapshot.contextTokens ?? null,
    inputTokens: snapshot.inputTokens ?? null,
    outputTokens: snapshot.outputTokens ?? null,
    thinkingTokens: snapshot.thinkingTokens ?? null,
    cachedTokens: snapshot.cachedTokens ?? null,
    totalTokens: snapshot.totalTokens ?? null,
    threadTokens: snapshot.threadTokens ?? null,
    lastCompactedAt: snapshot.lastCompactedAt ?? null,
    compactedCount: snapshot.compactedCount ?? null,
  })
}

function sumNumbers(
  ...values: Array<number | null | undefined>
): number | null {
  let total = 0
  let seen = false
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      continue
    total += value
    seen = true
  }
  return seen ? total : null
}

function canProviderReadLocalUploads(providerId: string): boolean {
  return providerId === "codex" || providerId === "claude-code"
}

function formatAttachmentSize(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return "unknown size"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
}

function buildAttachmentContext(
  attachments: Attachment[],
  options: { includeLocalPath: boolean }
): string {
  const lines: string[] = []

  for (const att of attachments) {
    if (!att || typeof att.id !== "string") continue

    const filename =
      typeof att.filename === "string" && att.filename.trim()
        ? att.filename.trim()
        : att.id
    const mimeType =
      typeof att.mimeType === "string" && att.mimeType.trim()
        ? att.mimeType.split(";")[0].trim()
        : "application/octet-stream"
    const filePath = resolveExistingUploadPath(att.id)
    const location = options.includeLocalPath && filePath
      ? `local path: ${filePath}`
      : filePath
        ? `upload_id: ${att.id}`
        : `upload_id: ${att.id}; local upload file is no longer available`

    lines.push(
      `- ${filename} (${mimeType}, ${formatAttachmentSize(att.size)}); ${location}`
    )
  }

  if (!lines.length) return ""

  return [
    `The user attached ${lines.length === 1 ? "this file" : "these files"}:`,
    ...lines,
    `Use upload_id when a tool asks for one of these uploaded attachments. Use local paths only when filesystem inspection is available.`,
  ].join("\n")
}

function appendPromptContext(content: string, context: string): string {
  if (!context) return content
  return content.trim() ? `${content}\n\n${context}` : context
}

function mergeMessagesForProvider(
  dbMessages: Message[],
  requestMessages: Message[]
): Message[] {
  const byId = new Map<string, Message>()
  for (const message of dbMessages) byId.set(message.id, message)
  for (const message of requestMessages) byId.set(message.id, message)
  return Array.from(byId.values()).sort((a, b) => {
    const timeDelta = a.timestamp - b.timestamp
    return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id)
  })
}

export async function POST(request: Request) {
  const requestOrigin = resolveRequestOrigin(request)

  if (isUpdateMaintenanceActive()) {
    return new Response(
      JSON.stringify({
        error: "Update in progress. The app will reconnect after restart.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Retry-After": "30",
        },
      }
    )
  }

  const enc = new TextEncoder()
  const config = getConfig()

  // Resolve effective per-agent settings (orchestrator is the entry point for now).
  const resolvedOrchestratorSettings = getEffectiveAgentSettings(
    orchestrator.id
  )
  const agentSettings = resolvedOrchestratorSettings.fromOverride
    ? resolvedOrchestratorSettings
    : {
        ...resolvedOrchestratorSettings,
        provider:
          orchestrator.provider ?? resolvedOrchestratorSettings.provider,
        model: orchestrator.model ?? resolvedOrchestratorSettings.model,
        thinkingLevel:
          orchestrator.thinkingLevel ??
          resolvedOrchestratorSettings.thinkingLevel,
      }
  const apiKey = getApiKey(agentSettings.provider)
  const registry = getEffectiveRegistry()
  const providerDef = registry[agentSettings.provider]
  const modelContextWindow =
    registry[agentSettings.provider]?.models[agentSettings.model]
      ?.contextWindow ?? null

  let body: { conversationId: string; messageId: string; messages: Message[] }
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
    })
  }

  const { conversationId, messageId, messages } = body
  if (!conversationId || !messageId || !messages?.length) {
    return new Response(
      JSON.stringify({
        error: "Missing conversationId, messageId, or messages",
      }),
      { status: 400 }
    )
  }

  // Ensure conversation exists (race condition: frontend fires POST /api/conversations
  // in parallel, but /api/chat may arrive first). Do this before runtime
  // validation so setup failures still persist as normal assistant messages.
  const existingConversation = getConversation(conversationId)
  const messagesForProvider = mergeMessagesForProvider(
    existingConversation?.messages ?? [],
    messages
  )

  if (!existingConversation) {
    const firstUserMsg =
      messagesForProvider.find((m) => m.role === "user") ??
      messagesForProvider[0]
    const conv: Conversation = {
      id: conversationId,
      title: generateTitle(
        firstUserMsg?.content ?? "",
        firstUserMsg?.attachments
      ),
      messages: messagesForProvider.map((m) => ({ ...m })),
      createdAt: Date.now(),
    }
    createConversation(conv)
  }

  const setupErrorResponse = (
    payload: { error: string; chatMessage: string; code: string },
    status: number
  ) => {
    addMessage(conversationId, {
      id: messageId,
      role: "assistant",
      content: payload.chatMessage,
      status: "error",
      contentSegments: [{ phase: 0, content: payload.chatMessage }],
      timestamp: Date.now(),
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  const readiness = await getProviderReadiness(
    agentSettings.provider,
    providerDef
  )
  if (!readiness.available) {
    return setupErrorResponse(
      {
        error: readiness.unavailableReason ?? "No model loaded.",
        chatMessage:
          readiness.chatMessage ??
          "No model loaded. Configure a provider in Settings, then try again.",
        code: "provider_unavailable",
      },
      401
    )
  }

  if (!providerDef?.models[agentSettings.model]) {
    return setupErrorResponse(
      {
        error: `Model ${agentSettings.model} is not available for ${providerDef?.name ?? agentSettings.provider}.`,
        chatMessage:
          "No model loaded. Choose a valid model in Settings, then try again.",
        code: "model_unavailable",
      },
      400
    )
  }

  const provider = getProvider(agentSettings.provider, apiKey ?? "")
  const providerStream = provider.stream
  if (!providerStream) {
    return new Response(
      JSON.stringify({
        error: `Provider ${agentSettings.provider} doesn't support text streaming`,
      }),
      { status: 501, headers: { "Content-Type": "application/json" } }
    )
  }

  // Resolve agent tools, gate integration operational tools, then remove
  // custom schemas that duplicate this provider's native built-ins. The final
  // surface feeds both the prompt builder and provider, so visible schemas and
  // callable tools stay in sync.
  const candidateTools = filterIntegrationToolExposure(
    dedupeTools([
      ...getToolsForAgent(orchestrator.tools),
      ...getToolsForBuiltins(orchestrator.builtins),
    ]),
    { conversationId, origin: requestOrigin }
  )
  const toolSurface = resolveProviderToolSurface(
    candidateTools,
    orchestrator.builtins,
    provider.capabilities
  )
  const agentTools = toolSurface.tools
  const agentBuiltins = toolSurface.builtins

  // Build system prompt from orchestrator agent. For text-kind agents
  // buildPrompt must exist; image/video/speech agents won't reach this path.
  if (!orchestrator.buildPrompt) {
    return new Response(
      JSON.stringify({
        error: `Agent ${orchestrator.id} is missing buildPrompt`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
  // Resolve sub-callable agent configs so the prompt's <runtime_agents>
  // section actually lists who the orchestrator can delegate to.
  const availableAgents: AgentConfig[] = (orchestrator.canCallAgents ?? [])
    .map((id) => getAgent(id))
    .filter((a): a is AgentConfig => a !== undefined)

  const systemPrompt = orchestrator.buildPrompt({
    agentId: orchestrator.id,
    userName: config.userName,
    assistantName: config.assistantName,
    availableTools: agentTools,
    availableBuiltins: agentBuiltins,
    availableAgents,
    conversationId,
    declaredToolIds: orchestrator.tools,
    delegationDepth: 0,
    maxDelegationDepth: MAX_AGENT_DEPTH,
    extra: { appOrigin: requestOrigin },
  })

  // Look up prior session for this exact provider/model. If the user switched
  // provider or model, we start a fresh provider session and send portable
  // history instead of handing the new runtime an opaque old session id.
  const prevSession = getInteractionId(
    conversationId,
    agentSettings.provider,
    agentSettings.model
  )

  // Create placeholder assistant message in DB
  const assistantMsg: Message = {
    id: messageId,
    role: "assistant",
    content: "",
    contentSegments: [],
    reasoning: [],
    thinking: "",
    timestamp: Date.now(),
  }
  addMessage(conversationId, assistantMsg)

  const serverAbortController = new AbortController()
  registerChatStream(conversationId, messageId, serverAbortController)

  const requestStartedAt = Date.now()
  // The "input" for the orchestrator row is the latest user turn.
  // History stays implicit (we already capture it on each message row).
  const latestUserMessage = [...messagesForProvider]
    .reverse()
    .find((m) => m.role === "user")
  logRequestStart({
    requestId: messageId,
    conversationId,
    agentId: orchestrator.id,
    provider: agentSettings.provider,
    model: agentSettings.model,
    thinkingLevel: agentSettings.thinkingLevel,
    // Stateful mode is provider-decided now; we record whether we passed
    // a prior session id (provider may still drop it internally).
    statefulMode: Boolean(prevSession),
    startedAt: requestStartedAt,
    inputText: latestUserMessage?.content ?? null,
  })

  // Start time per tool call so we can record durationMs in tool_logs.
  const toolStartTimes = new Map<string, number>()

  // Per-request artifact parser. Accumulates per-token buffers so we can
  // persist the finished artifact to SQLite on close. The full assistant
  // text (including tags) still goes to messages.content so reload works
  // even before the artifact-aware renderer ships.
  const artifactParser = new ArtifactParser()
  interface PendingArtifact {
    attrs: ArtifactOpenAttrs
    content: string
  }
  const pendingArtifacts = new Map<string, PendingArtifact>()

  // Accumulators for the final DB update
  let accThinking = ""
  let accContent = ""
  const accContentSegments: NonNullable<Message["contentSegments"]> = []
  const accToolCalls: { text: string; content: string }[] = []
  const accReasoning: NonNullable<Message["reasoning"]> = []
  let reasoningPhase = 0
  let streamMode: "reasoning" | "content" = "reasoning"
  let lastProgressPersistAt = 0
  let accAttachments: Attachment[] = []
  let latestContextUsage: ContextUsageSnapshot | null =
    existingConversation?.contextUsage ?? null
  let lastPublishedContextUsageKey = latestContextUsage
    ? contextUsageKey(latestContextUsage)
    : ""

  const persistAssistantProgress = (opts?: {
    force?: boolean
    thinkingDuration?: number
    status?: Message["status"]
  }) => {
    const force = opts?.force ?? false
    const now = Date.now()
    if (
      !force &&
      now - lastProgressPersistAt < STREAM_PROGRESS_PERSIST_INTERVAL_MS
    )
      return
    lastProgressPersistAt = now

    addMessage(conversationId, {
      id: messageId,
      role: "assistant",
      content: accContent || "",
      status: opts?.status,
      contentSegments: accContentSegments,
      reasoning: accReasoning,
      thinking: accThinking || "",
      thinkingDuration: opts?.thinkingDuration,
      toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
      attachments: accAttachments.length > 0 ? accAttachments : undefined,
      // Keep stable ordering for this assistant message.
      timestamp: assistantMsg.timestamp,
    })
  }

  const appendThinkingChunk = (chunk: string) => {
    const last = accReasoning[accReasoning.length - 1]
    if (last?.type === "thought" && last.phase === reasoningPhase) {
      last.content += chunk
      return
    }

    accReasoning.push({
      type: "thought",
      id: `thought_${accReasoning.length + 1}`,
      phase: reasoningPhase,
      content: chunk,
    })
  }

  const appendContentChunk = (chunk: string) => {
    const last = accContentSegments[accContentSegments.length - 1]
    if (last && last.phase === reasoningPhase) {
      last.content += chunk
      return
    }

    accContentSegments.push({
      phase: reasoningPhase,
      content: chunk,
    })
  }

  const findAgentEntry = (runId: string) =>
    accReasoning.find(
      (entry) => entry.type === "agent_call" && entry.runId === runId
    )

  const appendAgentThinking = (runId: string, chunk: string) => {
    const entry = findAgentEntry(runId)
    if (!entry || entry.type !== "agent_call") return
    const reasoning = entry.reasoning ?? []
    const phase = entry.contentSegments?.at(-1)?.phase ?? 0
    const last = reasoning[reasoning.length - 1]
    if (last?.type === "thought" && last.phase === phase) {
      last.content += chunk
    } else {
      reasoning.push({
        type: "thought",
        id: `thought_${reasoning.length + 1}`,
        phase,
        content: chunk,
      })
    }
    entry.reasoning = reasoning
  }

  const appendAgentContent = (runId: string, chunk: string) => {
    const entry = findAgentEntry(runId)
    if (!entry || entry.type !== "agent_call") return
    entry.content += chunk
    const segments = entry.contentSegments ?? []
    const phase = segments.at(-1)?.phase ?? 0
    const last = segments[segments.length - 1]
    if (last) {
      last.content += chunk
    } else {
      segments.push({ phase, content: chunk })
    }
    entry.contentSegments = segments
  }

  const stringifyAgentToolResult = (result: {
    success: boolean
    data?: unknown
    error?: string
  }) => {
    if (!result.success) return `Error: ${result.error}`
    if (typeof result.data === "object")
      return JSON.stringify(result.data, null, 2)
    return String(result.data ?? "")
  }

  const appendToolDelta = (
    toolCallId: string,
    toolName: string,
    delta: ToolStreamDelta,
    send: (data: Record<string, unknown>) => void
  ) => {
    const entry = accReasoning.find(
      (item) => item.type === "tool_call" && item.toolCallId === toolCallId
    )
    if (entry?.type === "tool_call") {
      entry.deltas = [...(entry.deltas ?? []), delta]
      entry.status = "running"
    }
    send({ type: "tool_delta", toolCallId, toolName, delta })
    persistAssistantProgress({ force: true })
  }

  const appendContextCompaction = (
    event: { threadId?: string; turnId?: string; itemId?: string; at: number },
    send: (data: Record<string, unknown>) => void
  ) => {
    if (streamMode === "content") {
      reasoningPhase += 1
      streamMode = "reasoning"
    }
    const entryId = `context_compaction_${event.itemId ?? event.turnId ?? Date.now()}`
    if (
      !accReasoning.some(
        (entry) => entry.type === "context_compaction" && entry.id === entryId
      )
    ) {
      const entry: ContextCompactionReasoningEntry = {
        type: "context_compaction",
        id: entryId,
        phase: reasoningPhase,
        title: "Context compacted",
        at: event.at,
      }
      accReasoning.push(entry)
      send({ type: "context_compaction", entry })
      persistAssistantProgress({ force: true })
    }
  }

  const handleAgentEvent = (
    event: AgentRunEvent,
    send: (data: Record<string, unknown>) => void
  ) => {
    if (event.type === "agent_start") {
      if (streamMode === "content") {
        reasoningPhase += 1
        streamMode = "reasoning"
      }
      const existing = findAgentEntry(event.runId)
      if (!existing) {
        accReasoning.push({
          type: "agent_call",
          id: `agent_${event.runId}`,
          phase: reasoningPhase,
          toolCallId: event.toolCallId,
          runId: event.runId,
          parentRunId: event.parentRunId,
          agentId: event.agentId,
          agentName: event.agentName,
          kind: event.kind,
          agentThreadId: event.agentThreadId,
          title: `${event.agentName}`,
          prompt: event.prompt,
          status: "running",
          startedAt: event.startedAt,
          content: "",
          contentSegments: [],
          reasoning: [],
        })
      }
    } else if (event.type === "agent_thinking") {
      appendAgentThinking(event.runId, event.content)
    } else if (event.type === "agent_content") {
      appendAgentContent(event.runId, event.content)
    } else if (event.type === "agent_tool_call") {
      const entry = findAgentEntry(event.runId)
      if (entry?.type === "agent_call") {
        const reasoning = entry.reasoning ?? []
        const exists = reasoning.some(
          (item) =>
            item.type === "tool_call" && item.toolCallId === event.toolCall.id
        )
        if (!exists) {
          reasoning.push({
            type: "tool_call",
            id: `tool_${event.toolCall.id}`,
            phase: entry.contentSegments?.at(-1)?.phase ?? 0,
            toolCallId: event.toolCall.id,
            title:
              event.toolCall.title ??
              buildToolTitle(event.toolCall.name, event.toolCall.arguments),
            content: "",
            toolName: event.toolCall.name,
            args: event.toolCall.arguments,
            status: "running",
            startedAt: Date.now(),
          })
          entry.reasoning = reasoning
        }
      }
    } else if (event.type === "agent_tool_delta") {
      const entry = findAgentEntry(event.runId)
      const toolEntry =
        entry?.type === "agent_call"
          ? entry.reasoning?.find(
              (item) =>
                item.type === "tool_call" &&
                item.toolCallId === event.toolCallId
            )
          : undefined
      if (toolEntry?.type === "tool_call") {
        toolEntry.deltas = [...(toolEntry.deltas ?? []), event.delta]
        toolEntry.status = "running"
      }
    } else if (event.type === "agent_tool_result") {
      const entry = findAgentEntry(event.runId)
      const toolEntry =
        entry?.type === "agent_call"
          ? entry.reasoning?.find(
              (item) =>
                item.type === "tool_call" &&
                item.toolCallId === event.toolCallId
            )
          : undefined
      if (toolEntry?.type === "tool_call") {
        toolEntry.content = stringifyAgentToolResult(event.result)
        toolEntry.success = event.result.success
        toolEntry.status = event.result.success ? "ok" : "error"
        toolEntry.endedAt = Date.now()
      }
    } else if (event.type === "agent_done") {
      const entry = findAgentEntry(event.runId)
      if (entry?.type === "agent_call") {
        entry.status = event.status
        entry.endedAt = event.endedAt
        if (typeof event.content === "string") entry.content = event.content
        if (event.contentSegments) entry.contentSegments = event.contentSegments
        if (event.reasoning) entry.reasoning = event.reasoning
        if (event.attachments) entry.attachments = event.attachments
        if (event.error) entry.error = event.error
        if (event.thinkingDuration)
          entry.thinkingDuration = event.thinkingDuration
      }
    }

    send(event as unknown as Record<string, unknown>)
    persistAssistantProgress({ force: true })
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          /* controller closed */
        }
      }

      const publishContextUsage = (
        snapshot: ContextUsageSnapshot,
        opts?: { force?: boolean }
      ) => {
        const enriched = mergeContextUsage(latestContextUsage, {
          ...snapshot,
          provider: snapshot.provider || agentSettings.provider,
          model: snapshot.model || agentSettings.model,
          requestId: snapshot.requestId ?? messageId,
          contextWindow: snapshot.contextWindow ?? modelContextWindow,
          updatedAt: snapshot.updatedAt || Date.now(),
        })
        const key = contextUsageKey(enriched)
        if (!opts?.force && key === lastPublishedContextUsageKey) return
        latestContextUsage = enriched
        lastPublishedContextUsageKey = key
        const persisted = updateConversationContextUsage(
          conversationId,
          enriched
        )
        send({ type: "context_usage", contextUsage: persisted })
      }

      try {
        // Build messages with file attachments resolved from disk
        const includeLocalAttachmentContext = canProviderReadLocalUploads(
          agentSettings.provider
        )

        const resolvedMessages = messagesForProvider.map((m) => {
          const messageAttachments = Array.isArray(m.attachments)
            ? m.attachments
            : []
          const localAttachmentContext =
            m.role === "user"
              ? buildAttachmentContext(messageAttachments, {
                  includeLocalPath: includeLocalAttachmentContext,
                })
              : ""
          const messageContent = typeof m.content === "string" ? m.content : ""
          const result: {
            role: string
            content: string
            attachments?: MessageAttachment[]
          } = {
            role: m.role,
            content: appendPromptContext(
              messageContent,
              localAttachmentContext
            ),
          }

          if (messageAttachments.length) {
            const atts: MessageAttachment[] = []
            for (const att of messageAttachments) {
              if (
                !att ||
                typeof att.id !== "string" ||
                typeof att.mimeType !== "string"
              )
                continue
              // Only include files the provider supports natively
              if (
                !isFileSupportedByProvider(agentSettings.provider, att.mimeType)
              )
                continue
              const filePath = resolveExistingUploadPath(att.id)
              if (!filePath) continue
              atts.push({
                filePath,
                mimeType: att.mimeType.split(";")[0].trim(),
              })
            }
            if (atts.length) result.attachments = atts
          }

          return result
        })

        await providerStream.call(
          provider,
          {
            model: agentSettings.model,
            messages: resolvedMessages,
            systemPrompt,
            thinkingLevel: agentSettings.thinkingLevel,
            modelOptions: agentSettings.modelOptions,
            tools: agentTools.length > 0 ? agentTools : undefined,
            builtins: agentBuiltins,
            prevSession,
            toolContext: {
              callerAgentId: orchestrator.id,
              depth: 0,
              conversationId,
              parentRequestId: messageId,
              signal: serverAbortController.signal,
              onAgentEvent: (event) => handleAgentEvent(event, send),
              onToolDelta: (toolCallId, toolName, delta) =>
                appendToolDelta(toolCallId, toolName, delta, send),
              appOrigin: requestOrigin,
            },
            signal: serverAbortController.signal,
          },
          {
            onThinking(text) {
              if (streamMode === "content") {
                reasoningPhase += 1
                streamMode = "reasoning"
              }
              accThinking += text
              appendThinkingChunk(text)
              send({ type: "thinking", content: text })
              persistAssistantProgress()
            },
            onThinkingDone(seconds) {
              send({ type: "thinking_done", seconds })
            },
            onContent(text) {
              // Always preserve raw text in DB so the message is
              // reload-safe regardless of artifact-renderer support.
              accContent += text
              appendContentChunk(text)
              if (text.length > 0) streamMode = "content"

              // Send raw text to the client. The live UI runs its
              // own ArtifactParser to interleave prose with
              // artifact cards — keeping the wire as raw text
              // means StreamingBubble and MessageBubble render
              // identically whether the message is mid-stream,
              // just-finished, or reloaded from the DB.
              if (text.length > 0) send({ type: "content", content: text })

              // Server-side parse stays — it's how we persist
              // artifact rows to SQLite and surface artifact_*
              // signals (draft placeholders, error fallback).
              for (const ev of artifactParser.feed(text)) {
                switch (ev.kind) {
                  case "prose":
                    // Already in the raw content event above.
                    break
                  case "artifact_start":
                    pendingArtifacts.set(ev.clientToken, {
                      attrs: ev.attrs,
                      content: "",
                    })
                    send({
                      type: "artifact_start",
                      clientToken: ev.clientToken,
                      attrs: ev.attrs,
                    })
                    break
                  case "artifact_chunk": {
                    // Accumulate locally for the DB row at
                    // artifact_end. Body bytes are already
                    // on the wire via the raw content
                    // stream, so no SSE event here.
                    const p = pendingArtifacts.get(ev.clientToken)
                    if (p) p.content += ev.text
                    break
                  }
                  case "artifact_end": {
                    const p = pendingArtifacts.get(ev.clientToken)
                    pendingArtifacts.delete(ev.clientToken)
                    if (p) {
                      try {
                        const row = insertArtifact({
                          conversationId,
                          messageId,
                          identifier: p.attrs.identifier,
                          type: p.attrs.type,
                          title: p.attrs.title,
                          language: p.attrs.language ?? null,
                          display: p.attrs.display ?? null,
                          // Strip wrapping ```lang ... ``` fence if the model added one.
                          content: stripWrappingCodeFence(p.content),
                        })
                        send({
                          type: "artifact_end",
                          clientToken: ev.clientToken,
                          artifact: row,
                        })
                      } catch (err) {
                        send({
                          type: "artifact_error",
                          clientToken: ev.clientToken,
                          message:
                            err instanceof Error
                              ? err.message
                              : "persist failed",
                        })
                      }
                    } else {
                      send({
                        type: "artifact_end",
                        clientToken: ev.clientToken,
                      })
                    }
                    break
                  }
                  case "artifact_error":
                    // Malformed tag — surface to UI and fall back to prose (the
                    // parser already feeds the raw literal to the prose stream).
                    send({ type: "artifact_error", message: ev.message })
                    break
                }
              }
              persistAssistantProgress()
            },
            onToolCall(toolCall) {
              if (streamMode === "content") {
                reasoningPhase += 1
                streamMode = "reasoning"
              }
              const safeArgs =
                redactToolArgs(toolCall.name, toolCall.arguments) ?? {}
              const title = buildToolTitle(toolCall.name, safeArgs)
              accReasoning.push({
                type: "tool_call",
                id: `tool_${toolCall.id}`,
                phase: reasoningPhase,
                toolCallId: toolCall.id,
                title,
                content: "",
                toolName: toolCall.name,
                args: safeArgs,
                status: "running",
                startedAt: Date.now(),
              })

              toolStartTimes.set(toolCall.id, Date.now())

              send({
                type: "tool_call",
                toolCall: {
                  id: toolCall.id,
                  name: toolCall.name,
                  title,
                  arguments: safeArgs,
                },
              })
              persistAssistantProgress({ force: true })
            },
            onToolDelta(toolCallId, toolName, delta) {
              appendToolDelta(toolCallId, toolName, delta, send)
            },
            onToolResult(toolCallId, toolName, result) {
              const displayContent = result.success
                ? typeof result.data === "object"
                  ? JSON.stringify(result.data, null, 2)
                  : String(result.data ?? "")
                : `Error: ${result.error}`

              const reasoningToolCall = accReasoning.find(
                (entry) =>
                  entry.type === "tool_call" && entry.toolCallId === toolCallId
              )
              const fallbackArgs =
                (reasoningToolCall?.type === "tool_call"
                  ? reasoningToolCall.args
                  : undefined) ??
                ((result.data as Record<string, unknown>)?.path
                  ? { path: (result.data as Record<string, unknown>).path }
                  : {})
              const displayText =
                reasoningToolCall?.type === "tool_call"
                  ? reasoningToolCall.title
                  : buildToolTitle(toolName, fallbackArgs)

              if (reasoningToolCall && reasoningToolCall.type === "tool_call") {
                reasoningToolCall.content = displayContent
                reasoningToolCall.success = result.success
                reasoningToolCall.status = result.success ? "ok" : "error"
                reasoningToolCall.endedAt = Date.now()
              }

              accToolCalls.push({ text: displayText, content: displayContent })
              persistAssistantProgress({ force: true })

              const toolStart = toolStartTimes.get(toolCallId)
              const toolEnd = Date.now()
              toolStartTimes.delete(toolCallId)
              logToolCall({
                requestId: messageId,
                toolName,
                success: result.success,
                startedAt: toolStart ?? toolEnd,
                durationMs: toolStart ? toolEnd - toolStart : null,
                errorMessage: result.success ? null : (result.error ?? null),
              })

              send({
                type: "tool_result",
                toolCallId,
                toolName,
                result: {
                  success: result.success,
                  text: displayText,
                  content: displayContent,
                },
              })
            },
            onUsage(usage) {
              publishContextUsage(usage)
            },
            onContextCompaction(event) {
              appendContextCompaction(event, send)
              publishContextUsage(
                {
                  provider: agentSettings.provider,
                  model: agentSettings.model,
                  source: latestContextUsage?.source ?? "provider-live",
                  accuracy: latestContextUsage?.accuracy ?? "live",
                  updatedAt: event.at,
                  requestId: messageId,
                  threadId: event.threadId ?? latestContextUsage?.threadId,
                  turnId: event.turnId ?? latestContextUsage?.turnId,
                  contextWindow:
                    latestContextUsage?.contextWindow ?? modelContextWindow,
                  contextTokens: latestContextUsage?.contextTokens ?? null,
                  inputTokens: latestContextUsage?.inputTokens ?? null,
                  outputTokens: latestContextUsage?.outputTokens ?? null,
                  thinkingTokens: latestContextUsage?.thinkingTokens ?? null,
                  cachedTokens: latestContextUsage?.cachedTokens ?? null,
                  totalTokens: latestContextUsage?.totalTokens ?? null,
                  threadTokens: latestContextUsage?.threadTokens ?? null,
                  last: latestContextUsage?.last ?? null,
                  total: latestContextUsage?.total ?? null,
                  lastCompactedAt: event.at,
                  compactedCount: (latestContextUsage?.compactedCount ?? 0) + 1,
                },
                { force: true }
              )
            },
            onDone(meta) {
              accAttachments = meta.attachments ?? []
              // Flush any trailing parser state (unterminated tags
              // become prose; unterminated artifacts are closed
              // and persisted with whatever content arrived).
              for (const ev of artifactParser.end()) {
                if (ev.kind === "prose") {
                  // Unterminated tag bytes (e.g. '<artifac'
                  // at end-of-stream). The bytes were already
                  // sent to the client via the raw content
                  // stream above — don't duplicate.
                } else if (ev.kind === "artifact_chunk") {
                  // Accumulate for DB persistence only — body
                  // bytes already on the wire as raw content.
                  const p = pendingArtifacts.get(ev.clientToken)
                  if (p) p.content += ev.text
                } else if (ev.kind === "artifact_end") {
                  const p = pendingArtifacts.get(ev.clientToken)
                  pendingArtifacts.delete(ev.clientToken)
                  if (p) {
                    try {
                      const row = insertArtifact({
                        conversationId,
                        messageId,
                        identifier: p.attrs.identifier,
                        type: p.attrs.type,
                        title: p.attrs.title,
                        language: p.attrs.language ?? null,
                        display: p.attrs.display ?? null,
                        content: p.content,
                      })
                      send({
                        type: "artifact_end",
                        clientToken: ev.clientToken,
                        artifact: row,
                      })
                    } catch (err) {
                      send({
                        type: "artifact_error",
                        clientToken: ev.clientToken,
                        message:
                          err instanceof Error ? err.message : "persist failed",
                      })
                    }
                  } else {
                    send({ type: "artifact_end", clientToken: ev.clientToken })
                  }
                }
              }

              // Save final message and emit an add_message sync event.
              persistAssistantProgress({
                force: true,
                thinkingDuration: meta.thinkingDuration,
                status: "ok",
              })

              if (meta.sessionId) {
                updateInteractionId(
                  conversationId,
                  agentSettings.provider,
                  agentSettings.model,
                  meta.sessionId
                )
              }

              const finalContextUsage = buildFinalContextUsageSnapshot({
                provider: agentSettings.provider,
                model: agentSettings.model,
                rawUsage: meta.usage,
                contextWindow: modelContextWindow,
                requestId: messageId,
                interactionId: meta.sessionId ?? null,
              })
              if (finalContextUsage) {
                publishContextUsage(
                  agentSettings.provider === "codex" && latestContextUsage
                    ? {
                        ...finalContextUsage,
                        source: latestContextUsage.source,
                        accuracy: latestContextUsage.accuracy,
                        threadId: latestContextUsage.threadId,
                        turnId: latestContextUsage.turnId,
                        contextWindow:
                          latestContextUsage.contextWindow ??
                          finalContextUsage.contextWindow,
                        threadTokens:
                          latestContextUsage.threadTokens ??
                          finalContextUsage.threadTokens,
                        last: latestContextUsage.last ?? finalContextUsage.last,
                        total:
                          latestContextUsage.total ?? finalContextUsage.total,
                        lastCompactedAt:
                          latestContextUsage.lastCompactedAt ??
                          finalContextUsage.lastCompactedAt,
                        compactedCount:
                          latestContextUsage.compactedCount ??
                          finalContextUsage.compactedCount,
                      }
                    : finalContextUsage,
                  { force: true }
                )
              }

              logRequestComplete({
                requestId: messageId,
                endedAt: Date.now(),
                thinkingMs:
                  typeof meta.thinkingDuration === "number"
                    ? meta.thinkingDuration * 1000
                    : null,
                interactionId: meta.sessionId ?? null,
                usage: meta.usage,
                provider: agentSettings.provider,
                outputText: accContent || null,
              })

              send({
                type: "done",
                messageId,
                status: "ok",
                thinkingDuration: meta.thinkingDuration,
                usage: meta.usage,
                interactionId: meta.sessionId,
                attachments: accAttachments,
              })
            },
            onError(error) {
              console.error("Provider stream error:", error)
              logRequestFail(messageId, error, Date.now(), accContent || null)
              persistAssistantProgress({
                force: true,
                thinkingDuration: 0,
                status: "error",
              })
              send({ type: "error", error })
            },
          }
        )
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error"
        const aborted = serverAbortController.signal.aborted
        console.error("Streaming error:", msg)

        addMessage(conversationId, {
          id: messageId,
          role: "assistant",
          content: aborted
            ? accContent
            : accContent
              ? `${accContent}\n\n[Error: ${msg}]`
              : `[Error: ${msg}]`,
          status: aborted ? "aborted" : "error",
          contentSegments: accContentSegments,
          reasoning: accReasoning,
          thinking: accThinking || "",
          thinkingDuration: 0,
          timestamp: assistantMsg.timestamp,
          toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
          attachments: accAttachments.length > 0 ? accAttachments : undefined,
        })

        if (aborted) {
          logRequestAbort(messageId, Date.now(), accContent || null)
        } else {
          logRequestFail(messageId, msg, Date.now(), accContent || null)
        }

        send(
          aborted
            ? { type: "stopped", messageId }
            : { type: "error", error: msg }
        )
      } finally {
        clearChatStream(conversationId, messageId)
      }

      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
