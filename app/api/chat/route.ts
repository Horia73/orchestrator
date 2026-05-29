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
import {
  getCachedPendingUpdate,
  isUpdateMaintenanceActive,
} from "@/lib/update/manager"
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
import {
  buildAutoArtifactTag,
  getArtifactUpdateData,
  getDirectEmitArtifactData,
  stripArtifactUpdatePayload,
  stripDirectEmitPayload,
} from "@/lib/artifacts/direct-emit"
import { redactToolArgs } from "@/lib/ai/tools/redaction"
import { filterIntegrationToolExposure } from "@/lib/integrations/exposure"
import { activateIntegrations } from "@/lib/integrations/activation-store"
import { resolveExistingUploadPath } from "@/lib/uploads"
import { getEffectiveRegistry } from "@/lib/models/registry"
import { generateTitle } from "@/lib/utils-chat"
import { getProviderReadiness } from "@/lib/provider-readiness"
import { resolveRequestOrigin } from "@/lib/app-origin"
import { sendChatCompletionPushNotification } from "@/lib/push-notifications"
import {
  appendBoundedToolDelta,
  sanitizeMessageForPersistence,
  sanitizeReasoningForPersistence,
  sanitizeToolCallSummaries,
} from "@/lib/ai/reasoning-limits"
import {
  appendPromptContext,
  buildAttachmentContext,
  buildFinalContextUsageSnapshot,
  buildToolTitle,
  canProviderReadLocalUploads,
  contextUsageKey,
  dedupeTools,
  mergeContextUsage,
  mergeMessagesForProvider,
  sanitizeCapabilityActivations,
  sanitizePromptContext,
} from "./route-support"

/** Persist in-progress assistant output periodically so reloads can catch up */
const STREAM_PROGRESS_PERSIST_INTERVAL_MS = 250

type ChatRequestBody = {
  conversationId?: unknown
  messageId?: unknown
  newMessage?: unknown
  messages?: unknown
  promptContext?: unknown
  activateIntegrations?: unknown
}

function isRequestMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<Message>
  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  )
}

function slimRequestMessage(message: Message): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: Array.isArray(message.attachments)
      ? message.attachments
      : undefined,
    timestamp: message.timestamp,
  }
}

function requestMessagesFromBody(body: ChatRequestBody): Message[] {
  if (isRequestMessage(body.newMessage)) {
    return [slimRequestMessage(body.newMessage)]
  }
  if (!Array.isArray(body.messages)) return []
  return body.messages.filter(isRequestMessage).map(slimRequestMessage)
}

function shouldTryModelFallback(error: string | null | undefined): boolean {
  const message = (error ?? "").toLowerCase()
  if (!message || message.includes("aborted")) return false
  return (
    message.includes("api key") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("out of usage") ||
    message.includes("usage limit") ||
    message.includes("resource_exhausted") ||
    message.includes("exhausted") ||
    message.includes("overloaded") ||
    message.includes("capacity") ||
    message.includes("unavailable") ||
    message.includes("expired") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("401") ||
    message.includes("model") ||
    message.includes("streaming")
  )
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
  const primaryAgentSettings = resolvedOrchestratorSettings.fromOverride
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

  let body: ChatRequestBody
  try {
    body = await request.json()
  } catch {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        chatMessage:
          "The chat request was invalid or truncated before it reached the model runtime. Please try sending the message again.",
        code: "invalid_request_body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    )
  }

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : ""
  const messageId = typeof body.messageId === "string" ? body.messageId : ""
  const requestMessages = requestMessagesFromBody(body)
  if (!conversationId || !messageId || requestMessages.length === 0) {
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
  // Merge browser-supplied history with persisted history. The client normally
  // sends the full local conversation; near request-size limits it may strip
  // UI-only metadata while preserving all role/content/attachments context.
  const messagesForProvider = mergeMessagesForProvider(
    existingConversation?.messages ?? [],
    requestMessages
  )
  const promptContext = sanitizePromptContext(body.promptContext)
  const promptContextMessageId = promptContext
    ? [...messagesForProvider].reverse().find((m) => m.role === "user")?.id
    : null
  const requestedActivations = sanitizeCapabilityActivations(
    body.activateIntegrations
  )
  if (requestedActivations.length > 0) {
    activateIntegrations(conversationId, requestedActivations)
  }

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

  const pendingUpdate = getCachedPendingUpdate()

  type ChatModelAttempt = {
    provider: string
    model: string
    thinkingLevel: string
    modelOptions: Record<string, boolean | string | number>
    fallbackIndex?: number
  }

  const buildModelAttempts = (
    primary: typeof primaryAgentSettings
  ): ChatModelAttempt[] => {
    const attempts: ChatModelAttempt[] = [
      {
        provider: primary.provider,
        model: primary.model,
        thinkingLevel: primary.thinkingLevel,
        modelOptions: primary.modelOptions,
      },
    ]
    for (const [index, fallback] of primary.fallbacks.entries()) {
      attempts.push({
        provider: fallback.provider,
        model: fallback.model,
        thinkingLevel: fallback.thinkingLevel ?? primary.thinkingLevel,
        modelOptions: {},
        fallbackIndex: index + 1,
      })
    }

    const seen = new Set<string>()
    return attempts.filter((attempt) => {
      const key = `${attempt.provider}:${attempt.model}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const prepareChatAttempt = async (
    settings: ChatModelAttempt,
    index: number
  ) => {
    const registry = getEffectiveRegistry()
    const providerDef = registry[settings.provider]
    const readiness = await getProviderReadiness(settings.provider, providerDef)
    if (!readiness.available) {
      return {
        ok: false as const,
        index,
        status: 401,
        payload: {
          error: readiness.unavailableReason ?? "No model loaded.",
          chatMessage:
            readiness.chatMessage ??
            "No model loaded. Configure a provider in Settings, then try again.",
          code: "provider_unavailable",
        },
      }
    }

    if (!providerDef?.models[settings.model]) {
      return {
        ok: false as const,
        index,
        status: 400,
        payload: {
          error: `Model ${settings.model} is not available for ${providerDef?.name ?? settings.provider}.`,
          chatMessage:
            "No model loaded. Choose a valid model in Settings, then try again.",
          code: "model_unavailable",
        },
      }
    }

    const apiKey = getApiKey(settings.provider)
    const provider = getProvider(settings.provider, apiKey ?? "")
    const providerStream = provider.stream
    if (!providerStream) {
      return {
        ok: false as const,
        index,
        status: 501,
        payload: {
          error: `Provider ${settings.provider} doesn't support text streaming`,
          chatMessage:
            "No model loaded. Choose a provider that supports chat streaming, then try again.",
          code: "provider_unavailable",
        },
      }
    }

    const candidateTools = filterIntegrationToolExposure(
      dedupeTools([
        ...getToolsForAgent(orchestrator.tools),
        ...getToolsForBuiltins(orchestrator.builtins),
      ]),
      { conversationId, origin: requestOrigin, agentId: orchestrator.id }
    )
    const toolSurface = resolveProviderToolSurface(
      candidateTools,
      orchestrator.builtins,
      provider.capabilities
    )
    const systemPrompt = orchestrator.buildPrompt!({
      agentId: orchestrator.id,
      userName: config.userName,
      assistantName: config.assistantName,
      availableTools: toolSurface.tools,
      availableBuiltins: toolSurface.builtins,
      availableAgents,
      conversationId,
      declaredToolIds: orchestrator.tools,
      declaredTools: getToolsForAgent(orchestrator.tools),
      delegationDepth: 0,
      maxDelegationDepth: MAX_AGENT_DEPTH,
      pendingUpdate: pendingUpdate ?? undefined,
      extra: { appOrigin: requestOrigin },
    })
    const prevSession = getInteractionId(
      conversationId,
      settings.provider,
      settings.model
    )

    return {
      ok: true as const,
      index,
      settings,
      provider,
      providerStream,
      agentTools: toolSurface.tools,
      agentBuiltins: toolSurface.builtins,
      systemPrompt,
      prevSession,
      modelContextWindow:
        registry[settings.provider]?.models[settings.model]?.contextWindow ??
        null,
    }
  }

  const prepareFirstAvailableAttempt = async (attempts: ChatModelAttempt[]) => {
    let lastFailure: Awaited<ReturnType<typeof prepareChatAttempt>> | null =
      null
    for (let index = 0; index < attempts.length; index++) {
      const prepared = await prepareChatAttempt(attempts[index], index)
      if (prepared.ok) return prepared
      lastFailure = prepared
    }
    return (
      lastFailure ?? {
        ok: false as const,
        index: 0,
        status: 400,
        payload: {
          error: "No model loaded.",
          chatMessage:
            "No model loaded. Configure a provider in Settings, then try again.",
          code: "provider_unavailable",
        },
      }
    )
  }

  const modelAttempts = buildModelAttempts(primaryAgentSettings)
  const preparedInitial = await prepareFirstAvailableAttempt(modelAttempts)
  if (!preparedInitial.ok) {
    return setupErrorResponse(preparedInitial.payload, preparedInitial.status)
  }

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

  // The "input" for the orchestrator row is the latest user turn.
  // History stays implicit (we already capture it on each message row).
  const latestUserMessage = [...messagesForProvider]
    .reverse()
    .find((m) => m.role === "user")

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
  let terminalMessageStatus: Message["status"] | null = null
  let terminalStreamError: string | null = null

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

    addMessage(
      conversationId,
      sanitizeMessageForPersistence({
        id: messageId,
        role: "assistant",
        content: accContent || "",
        status: opts?.status ?? terminalMessageStatus ?? undefined,
        contentSegments: accContentSegments,
        reasoning: accReasoning,
        thinking: accThinking || "",
        thinkingDuration: opts?.thinkingDuration,
        toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
        attachments: accAttachments.length > 0 ? accAttachments : undefined,
        // Keep stable ordering for this assistant message.
        timestamp: assistantMsg.timestamp,
      })
    )
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

  const fallbackAgentPhase = (runId: string): number => {
    const entry = findAgentEntry(runId)
    return entry?.type === "agent_call"
      ? (entry.contentSegments?.at(-1)?.phase ?? 0)
      : 0
  }

  const appendAgentThinking = (
    runId: string,
    chunk: string,
    phase = fallbackAgentPhase(runId)
  ) => {
    const entry = findAgentEntry(runId)
    if (!entry || entry.type !== "agent_call") return
    const reasoning = entry.reasoning ?? []
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

  const appendAgentContent = (
    runId: string,
    chunk: string,
    phase = fallbackAgentPhase(runId)
  ) => {
    const entry = findAgentEntry(runId)
    if (!entry || entry.type !== "agent_call") return
    entry.content += chunk
    const segments = entry.contentSegments ?? []
    const last = segments[segments.length - 1]
    if (last && last.phase === phase) {
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
      entry.deltas = appendBoundedToolDelta(entry.deltas, delta)
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
      appendAgentThinking(event.runId, event.content, event.phase)
    } else if (event.type === "agent_content") {
      appendAgentContent(event.runId, event.content, event.phase)
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
            phase: event.phase ?? entry.contentSegments?.at(-1)?.phase ?? 0,
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
        toolEntry.deltas = appendBoundedToolDelta(toolEntry.deltas, event.delta)
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
        if (event.reasoning)
          entry.reasoning = sanitizeReasoningForPersistence(event.reasoning)
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
      let activeAttempt = preparedInitial

      const publishContextUsage = (
        snapshot: ContextUsageSnapshot,
        opts?: { force?: boolean }
      ) => {
        const enriched = mergeContextUsage(latestContextUsage, {
          ...snapshot,
          provider: snapshot.provider || activeAttempt.settings.provider,
          model: snapshot.model || activeAttempt.settings.model,
          requestId: snapshot.requestId ?? messageId,
          contextWindow:
            snapshot.contextWindow ?? activeAttempt.modelContextWindow,
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
        let lastModelAttemptError: string | null = null
        for (
          let attemptIndex = preparedInitial.index;
          attemptIndex < modelAttempts.length;
          attemptIndex++
        ) {
          const prepared =
            attemptIndex === preparedInitial.index
              ? preparedInitial
              : await prepareChatAttempt(
                  modelAttempts[attemptIndex],
                  attemptIndex
                )
          if (!prepared.ok) {
            lastModelAttemptError = prepared.payload.error
            continue
          }
          activeAttempt = prepared
          let attemptStreamError: string | null = null
          let attemptHadToolCall = false
          const attemptContentStart = accContent.length
          const requestStartedAt = Date.now()
          logRequestStart({
            requestId: messageId,
            conversationId,
            agentId: orchestrator.id,
            provider: prepared.settings.provider,
            model: prepared.settings.model,
            thinkingLevel: prepared.settings.thinkingLevel,
            // Stateful mode is provider-decided now; we record whether we passed
            // a prior session id (provider may still drop it internally).
            statefulMode: Boolean(prepared.prevSession),
            startedAt: requestStartedAt,
            inputText: latestUserMessage?.content ?? null,
          })
          if (prepared.settings.fallbackIndex && accContent.length === 0) {
            const note = `Using fallback ${prepared.settings.fallbackIndex}: ${prepared.settings.provider}:${prepared.settings.model}.\n`
            accThinking += note
            appendThinkingChunk(note)
            send({ type: "thinking", content: note })
            persistAssistantProgress({ force: true })
          }

          // Build messages with file attachments resolved from disk
          const includeLocalAttachmentContext = canProviderReadLocalUploads(
            prepared.settings.provider
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
            const messageContent =
              typeof m.content === "string" ? m.content : ""
            const runtimePromptContext =
              m.id === promptContextMessageId
                ? [
                    '<runtime_context source="Smart Maps UI">',
                    "This context was supplied by the app UI for this turn. It is not visible user prose. Use it to answer with map-aware tools and artifacts; do not quote it back verbatim.",
                    promptContext,
                    "</runtime_context>",
                  ].join("\n")
                : ""
            const result: {
              role: string
              content: string
              attachments?: MessageAttachment[]
            } = {
              role: m.role,
              content: appendPromptContext(
                appendPromptContext(messageContent, localAttachmentContext),
                runtimePromptContext
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
                  !isFileSupportedByProvider(
                    prepared.settings.provider,
                    att.mimeType
                  )
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

          // Shared content-chunk pipeline. Called for every text fragment that
          // arrives — either real model output (`onContent`) or a server-side
          // injection from a tool result (`directEmit` artifacts). Centralising
          // the path means a synthetic chunk gets accContent persistence,
          // streaming SSE delivery, parser-driven artifact creation, and the
          // resulting `artifact_end` event with the inserted row — all
          // identical to a chunk the model emitted itself.
          const processContentChunk = (
            text: string,
            synthetic: boolean
          ): void => {
            void synthetic
            accContent += text
            appendContentChunk(text)
            if (text.length > 0) streamMode = "content"
            if (text.length > 0) send({ type: "content", content: text })
            for (const ev of artifactParser.feed(text)) {
              switch (ev.kind) {
                case "prose":
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
                          err instanceof Error ? err.message : "persist failed",
                      })
                    }
                  } else {
                    send({ type: "artifact_end", clientToken: ev.clientToken })
                  }
                  break
                }
                case "artifact_error":
                  send({ type: "artifact_error", message: ev.message })
                  break
              }
            }
            persistAssistantProgress()
          }

          try {
            await prepared.providerStream.call(
              prepared.provider,
              {
                model: prepared.settings.model,
                messages: resolvedMessages,
                systemPrompt: prepared.systemPrompt,
                thinkingLevel: prepared.settings.thinkingLevel,
                modelOptions: prepared.settings.modelOptions,
                tools:
                  prepared.agentTools.length > 0
                    ? prepared.agentTools
                    : undefined,
                builtins: prepared.agentBuiltins,
                prevSession: prepared.prevSession,
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
                  processContentChunk(text, /* synthetic= */ false)
                },
                onToolCall(toolCall) {
                  attemptHadToolCall = true
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
                  // Auto-inject artifact tag for tools that opt in via
                  // `directEmit: true`. The synthetic tag flows through the
                  // SAME content-chunk pipeline the model uses, so the parser
                  // creates the artifact row, the client mounts the card, and
                  // the assistant message body reads identically to a turn
                  // where the model emitted the tag itself.
                  const directEmit = result.success
                    ? getDirectEmitArtifactData(result.data)
                    : null
                  if (directEmit) {
                    // Always log the outcome of the directEmit check — makes it
                    // possible to diagnose "no card appeared" without spelunking
                    // through the SSE stream. Logs are dev-only noise; consider
                    // gating behind a debug flag later.
                    console.log(
                      `[autoinject] tool=${toolName} success=${result.success} directEmit=true ` +
                        `hasBody=true type=${directEmit.type} identifier=${directEmit.identifier} -> INJECTING`
                    )
                    const tag = buildAutoArtifactTag({
                      identifier: directEmit.identifier,
                      type: directEmit.type,
                      title: directEmit.title,
                      display: directEmit.display ?? "inline",
                      body: directEmit.body,
                    })
                    processContentChunk(tag, /* synthetic= */ true)
                    // Strip body + usage from the streamed tool result so the
                    // UI does not show giant JSON after the artifact has mounted.
                    result = {
                      ...result,
                      data: stripDirectEmitPayload(directEmit.source),
                    }
                  } else {
                    const artifactUpdate = result.success
                      ? getArtifactUpdateData(result.data)
                      : null
                    if (artifactUpdate) {
                      try {
                        const row = insertArtifact({
                          conversationId,
                          messageId,
                          identifier: artifactUpdate.identifier,
                          type: artifactUpdate.type,
                          title: artifactUpdate.title,
                          display:
                            artifactUpdate.display === "panel" ||
                            artifactUpdate.display === "fullscreen"
                              ? artifactUpdate.display
                              : "inline",
                          content: stripWrappingCodeFence(artifactUpdate.body),
                        })
                        send({
                          type: "artifact_end",
                          clientToken: `artifact-update-${row.id}`,
                          artifact: row,
                        })
                        console.log(
                          `[artifact-update] tool=${toolName} identifier=${artifactUpdate.identifier} ` +
                            `type=${artifactUpdate.type} version=${row.version}`
                        )
                        result = {
                          ...result,
                          data: stripArtifactUpdatePayload(
                            artifactUpdate.source
                          ),
                        }
                      } catch (err) {
                        result = {
                          success: false,
                          error:
                            err instanceof Error
                              ? err.message
                              : "artifact update failed",
                        }
                      }
                    } else if (toolName === "WeatherShow") {
                      console.log(
                        `[autoinject] WeatherShow result: success=${result.success} ` +
                          `error=${result.error ?? "n/a"}`
                      )
                    }
                  }

                  const displayContent = result.success
                    ? typeof result.data === "object"
                      ? JSON.stringify(result.data, null, 2)
                      : String(result.data ?? "")
                    : `Error: ${result.error}`

                  const reasoningToolCall = accReasoning.find(
                    (entry) =>
                      entry.type === "tool_call" &&
                      entry.toolCallId === toolCallId
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
                  const displaySummary = sanitizeToolCallSummaries([
                    { text: displayText, content: displayContent },
                  ])?.[0] ?? { text: displayText, content: displayContent }

                  if (
                    reasoningToolCall &&
                    reasoningToolCall.type === "tool_call"
                  ) {
                    reasoningToolCall.content = displaySummary.content
                    reasoningToolCall.success = result.success
                    reasoningToolCall.status = result.success ? "ok" : "error"
                    reasoningToolCall.endedAt = Date.now()
                  }

                  accToolCalls.push(displaySummary)
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
                    errorMessage: result.success
                      ? null
                      : (result.error ?? null),
                  })

                  send({
                    type: "tool_result",
                    toolCallId,
                    toolName,
                    result: {
                      success: result.success,
                      text: displaySummary.text,
                      content: displaySummary.content,
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
                      provider: prepared.settings.provider,
                      model: prepared.settings.model,
                      source: latestContextUsage?.source ?? "provider-live",
                      accuracy: latestContextUsage?.accuracy ?? "live",
                      updatedAt: event.at,
                      requestId: messageId,
                      threadId: event.threadId ?? latestContextUsage?.threadId,
                      turnId: event.turnId ?? latestContextUsage?.turnId,
                      contextWindow:
                        latestContextUsage?.contextWindow ??
                        prepared.modelContextWindow,
                      contextTokens: latestContextUsage?.contextTokens ?? null,
                      inputTokens: latestContextUsage?.inputTokens ?? null,
                      outputTokens: latestContextUsage?.outputTokens ?? null,
                      thinkingTokens:
                        latestContextUsage?.thinkingTokens ?? null,
                      cachedTokens: latestContextUsage?.cachedTokens ?? null,
                      totalTokens: latestContextUsage?.totalTokens ?? null,
                      threadTokens: latestContextUsage?.threadTokens ?? null,
                      last: latestContextUsage?.last ?? null,
                      total: latestContextUsage?.total ?? null,
                      lastCompactedAt: event.at,
                      compactedCount:
                        (latestContextUsage?.compactedCount ?? 0) + 1,
                    },
                    { force: true }
                  )
                },
                onDone(meta) {
                  if (terminalStreamError || attemptStreamError) return
                  if (serverAbortController.signal.aborted) {
                    terminalStreamError = "Aborted"
                    terminalMessageStatus = "aborted"
                    logRequestAbort(messageId, Date.now(), accContent || null)
                    persistAssistantProgress({
                      force: true,
                      thinkingDuration: 0,
                      status: "aborted",
                    })
                    send({ type: "stopped", messageId })
                    return
                  }

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
                    }
                  }

                  // Save final message and emit an add_message sync event.
                  terminalMessageStatus = "ok"
                  persistAssistantProgress({
                    force: true,
                    thinkingDuration: meta.thinkingDuration,
                    status: "ok",
                  })

                  if (meta.sessionId) {
                    updateInteractionId(
                      conversationId,
                      prepared.settings.provider,
                      prepared.settings.model,
                      meta.sessionId
                    )
                  }

                  const finalContextUsage = buildFinalContextUsageSnapshot({
                    provider: prepared.settings.provider,
                    model: prepared.settings.model,
                    rawUsage: meta.usage,
                    contextWindow: prepared.modelContextWindow,
                    requestId: messageId,
                    interactionId: meta.sessionId ?? null,
                  })
                  if (finalContextUsage) {
                    publishContextUsage(
                      (prepared.settings.provider === "codex" ||
                        prepared.settings.provider === "claude-code") &&
                        latestContextUsage
                        ? {
                            ...finalContextUsage,
                            source: latestContextUsage.source,
                            accuracy: latestContextUsage.accuracy,
                            threadId: latestContextUsage.threadId,
                            turnId: latestContextUsage.turnId,
                            contextWindow:
                              latestContextUsage.contextWindow ??
                              finalContextUsage.contextWindow,
                            // Codex and Claude Code both report the cumulative
                            // whole-run usage at turn end (codex's `.total`,
                            // claude's cumulative result.usage incl. cache
                            // reads) — correct for billing, but the context
                            // window gauge must show the LAST request's
                            // occupancy (≤ the window). The live stream already
                            // captured that per request, so keep those numbers
                            // instead of the cumulative ones, which otherwise
                            // blow past the window (e.g. 2.0M/258K, 1.3M/1M).
                            contextTokens:
                              latestContextUsage.contextTokens ??
                              finalContextUsage.contextTokens,
                            inputTokens:
                              latestContextUsage.inputTokens ??
                              finalContextUsage.inputTokens,
                            outputTokens:
                              latestContextUsage.outputTokens ??
                              finalContextUsage.outputTokens,
                            thinkingTokens:
                              latestContextUsage.thinkingTokens ??
                              finalContextUsage.thinkingTokens,
                            cachedTokens:
                              latestContextUsage.cachedTokens ??
                              finalContextUsage.cachedTokens,
                            totalTokens:
                              latestContextUsage.totalTokens ??
                              finalContextUsage.totalTokens,
                            threadTokens:
                              latestContextUsage.threadTokens ??
                              finalContextUsage.threadTokens,
                            last:
                              latestContextUsage.last ?? finalContextUsage.last,
                            total:
                              latestContextUsage.total ??
                              finalContextUsage.total,
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
                    provider: prepared.settings.provider,
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

                  const completedConversation = getConversation(conversationId)
                  void sendChatCompletionPushNotification({
                    conversationId,
                    title: completedConversation?.title ?? "Chat finished",
                    body: accContent,
                  }).catch((error) => {
                    console.warn(
                      "Failed to send chat completion notification",
                      error
                    )
                  })
                },
                onError(error) {
                  if (attemptStreamError || terminalStreamError) return
                  attemptStreamError = error
                  const aborted = serverAbortController.signal.aborted
                  console.error("Provider stream error:", error)
                  if (aborted) {
                    terminalStreamError = error
                    terminalMessageStatus = "aborted"
                    logRequestAbort(messageId, Date.now(), accContent || null)
                    persistAssistantProgress({
                      force: true,
                      thinkingDuration: 0,
                      status: terminalMessageStatus,
                    })
                    send({ type: "stopped", messageId })
                    return
                  }
                  logRequestFail(
                    messageId,
                    error,
                    Date.now(),
                    accContent || null
                  )
                },
              }
            )
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : "Unknown error"
            if (!attemptStreamError) {
              attemptStreamError = msg
              const aborted = serverAbortController.signal.aborted
              console.error("Streaming error:", msg)
              if (aborted) {
                terminalStreamError = msg
                terminalMessageStatus = "aborted"
                logRequestAbort(messageId, Date.now(), accContent || null)
                persistAssistantProgress({
                  force: true,
                  thinkingDuration: 0,
                  status: terminalMessageStatus,
                })
                send({ type: "stopped", messageId })
              } else {
                logRequestFail(messageId, msg, Date.now(), accContent || null)
              }
            }
          }
          if (
            terminalMessageStatus === "ok" ||
            terminalMessageStatus === "aborted"
          ) {
            break
          }
          if (attemptStreamError) {
            lastModelAttemptError = attemptStreamError
            const canRetry =
              attemptIndex < modelAttempts.length - 1 &&
              !attemptHadToolCall &&
              accContent.length === attemptContentStart &&
              shouldTryModelFallback(attemptStreamError)
            if (canRetry) {
              const note = `Model ${prepared.settings.provider}:${prepared.settings.model} failed before output; trying fallback.\n`
              accThinking += note
              appendThinkingChunk(note)
              send({ type: "thinking", content: note })
              persistAssistantProgress({ force: true })
              continue
            }
            terminalStreamError = attemptStreamError
            terminalMessageStatus = "error"
            persistAssistantProgress({
              force: true,
              thinkingDuration: 0,
              status: terminalMessageStatus,
            })
            send({ type: "error", error: attemptStreamError })
            break
          }
        }
        if (!terminalMessageStatus) {
          const error =
            lastModelAttemptError ?? "All configured model attempts failed."
          terminalStreamError = error
          terminalMessageStatus = "error"
          persistAssistantProgress({
            force: true,
            thinkingDuration: 0,
            status: terminalMessageStatus,
          })
          send({ type: "error", error })
        }
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
