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

  let body: {
    conversationId: string
    messageId: string
    messages: Message[]
    promptContext?: string
    activateIntegrations?: string[]
  }
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

    addMessage(conversationId, {
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
          const runtimePromptContext =
            m.id === promptContextMessageId
              ? [
                  "<runtime_context source=\"Smart Maps UI\">",
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

        // Shared content-chunk pipeline. Called for every text fragment that
        // arrives — either real model output (`onContent`) or a server-side
        // injection from a tool result (`directEmit` artifacts). Centralising
        // the path means a synthetic chunk gets accContent persistence,
        // streaming SSE delivery, parser-driven artifact creation, and the
        // resulting `artifact_end` event with the inserted row — all
        // identical to a chunk the model emitted itself.
        const processContentChunk = (text: string, synthetic: boolean): void => {
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
                      message: err instanceof Error ? err.message : "persist failed",
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
              processContentChunk(text, /* synthetic= */ false)
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
                  `hasBody=true type=${directEmit.type} identifier=${directEmit.identifier} -> INJECTING`,
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
                      display: artifactUpdate.display === "panel" || artifactUpdate.display === "fullscreen"
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
                      `type=${artifactUpdate.type} version=${row.version}`,
                    )
                    result = {
                      ...result,
                      data: stripArtifactUpdatePayload(artifactUpdate.source),
                    }
                  } catch (err) {
                    result = {
                      success: false,
                      error: err instanceof Error ? err.message : "artifact update failed",
                    }
                  }
                } else if (toolName === "WeatherShow") {
                  console.log(
                    `[autoinject] WeatherShow result: success=${result.success} ` +
                    `error=${result.error ?? "n/a"}`,
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
              if (terminalStreamError) return

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
              terminalMessageStatus = "ok"
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
              if (terminalStreamError) return
              terminalStreamError = error
              const aborted = serverAbortController.signal.aborted
              terminalMessageStatus = aborted ? "aborted" : "error"
              console.error("Provider stream error:", error)
              if (aborted) {
                logRequestAbort(messageId, Date.now(), accContent || null)
              } else {
                logRequestFail(messageId, error, Date.now(), accContent || null)
              }
              persistAssistantProgress({
                force: true,
                thinkingDuration: 0,
                status: terminalMessageStatus,
              })
              send(aborted ? { type: "stopped", messageId } : { type: "error", error })
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
