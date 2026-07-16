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
  ContextUsageBreakdown,
  ContextUsageSnapshot,
  Conversation,
  MemoryRecallReasoningEntry,
  Message,
  SteeredMessageReasoningEntry,
  ToolCallReasoningEntry,
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
import { extractUploadAttachmentsFromContent } from "@/lib/ai/media-assets"
import {
  announceChatStream,
  clearChatStream,
  getActiveChatStream,
  registerChatStream,
} from "@/lib/chat-streams"
import {
  claimFollowUp,
  enqueueFollowUp,
  peekFollowUps,
  requeueClaimedFollowUp,
  type ChatFollowUp,
} from "@/lib/chat-followups"
import { clearTurnSteering, registerTurnSteering } from "@/lib/chat-steering"
import { wrapSteeredMessage } from "@/lib/steered-message"
import {
  getCachedPendingUpdateForProfile,
  isUpdateMaintenanceActive,
} from "@/lib/update/manager"
import {
  logRequestStart,
  logRequestComplete,
  logRequestFail,
  logRequestAbort,
  logRequestInput,
  logToolCall,
} from "@/lib/observability/store"
import { insertArtifact } from "@/lib/artifacts/store"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { stripWrappingCodeFence } from "@/lib/artifacts/sanitize"
import {
  buildArtifactBlockFromRow,
  missingArtifactBlocks,
  stripArtifactBlocksForPreview,
} from "@/lib/artifacts/text"
import {
  buildAutoArtifactTag,
  getArtifactUpdateData,
  getDirectEmitArtifactData,
  stripArtifactUpdatePayload,
  stripDirectEmitPayload,
} from "@/lib/artifacts/direct-emit"
import { redactToolArgs } from "@/lib/ai/tools/redaction"
import { prepareAudioContextsForProvider } from "@/lib/ai/audio-context"
import {
  buildContextUsageBreakdown,
  reconcileContextUsageBreakdown,
} from "@/lib/ai/context-usage-breakdown"
import { filterIntegrationToolExposure } from "@/lib/integrations/exposure"
import { activateIntegrations } from "@/lib/integrations/activation-store"
import { resolveExistingUploadPath } from "@/lib/uploads"
import { getEffectiveRegistry } from "@/lib/models/registry"
import { generateTitle } from "@/lib/utils-chat"
import { maybeAutoNameAttachmentOnlyConversation } from "@/lib/ai/conversation-auto-title"
import { getProviderReadiness } from "@/lib/provider-readiness"
import { resolveRequestOrigin } from "@/lib/app-origin"
import {
  proxyToDurableAiWorker,
  shouldProxyToDurableAiWorker,
} from "@/lib/ai/durable-worker"
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
  sanitizePreferredFallbackIndex,
  sanitizePromptContextSource,
  sanitizePromptContext,
} from "./route-support"
import {
  buildRecallUiHits,
  getRecalledMemory,
  type RecallAttachmentInput,
  type RecalledMemory,
} from "@/lib/memory/recall"
import {
  MAX_MODEL_RETRIES_BEFORE_FALLBACK,
  buildModelRetryRecoveryContext,
  requestMessagesFromBody,
  shouldTryModelFallback,
  type ChatRequestBody,
  type ModelRetryRecoveryAttempt,
} from "./route-request"
import { createArtifactStreamBridge } from "./artifact-stream"
import { repairArtifactContent } from "@/lib/artifacts/repair"
import { runTextSubAgent } from "@/lib/ai/agents/runner"
import { getAiRunAdmissionBlock } from "@/lib/ai/run-admission"
import { buildArtifactRepairRuntimeAgent } from "@/lib/ai/agents/artifact-repair"
import { runWithRequestProfile } from "@/lib/profiles/server"
import { getActiveProfileId } from "@/lib/profiles/context"

/** Persist in-progress assistant output periodically so reloads can catch up */
const STREAM_PROGRESS_PERSIST_INTERVAL_MS = 250
/** SSE comment keepalive cadence. Long tool calls can be event-silent for
 *  minutes; without bytes on the wire the client cannot tell "model is busy"
 *  from "mobile radio silently died", and its stall watchdog (which frees a
 *  hung reader) needs a heartbeat to measure against. Comment lines (`: …`)
 *  are invisible to the client's `data: ` parser. */
const STREAM_KEEPALIVE_INTERVAL_MS = 10_000

function currentMessageMissingUploads(message: Message | undefined): Attachment[] {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  return attachments.filter((att): att is Attachment => {
    return Boolean(att?.id && !resolveExistingUploadPath(att.id))
  })
}

function missingUploadsChatMessage(missing: Attachment[]): string {
  const names = missing
    .map((att) => att.filename || att.id)
    .slice(0, 3)
    .join(", ")
  const suffix = missing.length > 3 ? ` and ${missing.length - 3} more` : ""
  return [
    `I can't access ${missing.length === 1 ? "the attached file" : "some attached files"}: ${names}${suffix}.`,
    "The upload metadata is still in this draft/message, but the file bytes are no longer present on disk, likely after a restart or cleanup.",
    "Remove and re-attach the missing file, then send again.",
  ].join(" ")
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const requestOrigin = resolveRequestOrigin(request)

      if (isUpdateMaintenanceActive()) {
        return new Response(
          JSON.stringify({
            error: "Update in progress. The app will reconnect after restart.",
            code: "update_in_progress",
            profileId: getActiveProfileId(),
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

      if (shouldProxyToDurableAiWorker()) {
        return proxyToDurableAiWorker(request)
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

      const requestedFollowUpId =
        typeof body.followUpId === "string" && body.followUpId
          ? body.followUpId
          : null
      const queueBehindActiveStream = (active: {
        messageId: string
        startedAt: number
      }): Response => {
        if (requestedFollowUpId) {
          const queued = peekFollowUps(conversationId).some(
            (entry) => entry.id === requestedFollowUpId
          )
          if (!queued) {
            return new Response(
              JSON.stringify({
                error: "Follow-up already claimed",
                code: "followup_already_claimed",
                activeMessageId: active.messageId,
                activeStartedAt: active.startedAt,
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            )
          }
          return new Response(
            JSON.stringify({
              error: "The previous stream is still active; follow-up remains queued",
              code: "followup_deferred",
              queued: true,
              followUpId: requestedFollowUpId,
              activeMessageId: active.messageId,
              activeStartedAt: active.startedAt,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        }

        const userMessage = [...requestMessages]
          .reverse()
          .find((message) => message.role === "user")
        if (!userMessage) {
          return new Response(
            JSON.stringify({
              error: "A stream is already active",
              code: "stream_active",
              activeMessageId: active.messageId,
              activeStartedAt: active.startedAt,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        }

        const persistableMessage: Message = { ...userMessage }
        delete persistableMessage.steerPending
        addMessage(conversationId, persistableMessage)
        const existing = peekFollowUps(conversationId).find(
          (entry) => entry.userMessageId === userMessage.id
        )
        const queuedAt = existing?.queuedAt ?? Date.now()
        if (!existing) {
          enqueueFollowUp(conversationId, {
            id: userMessage.id,
            userMessageId: userMessage.id,
            content: userMessage.content,
            attachments: userMessage.attachments,
            source: "user",
            queuedAt,
          })
        }
        return new Response(
          JSON.stringify({
            error: "A stream is already active; message queued as a follow-up",
            code: "stream_active_queued",
            queued: true,
            followUpId: existing?.id ?? userMessage.id,
            queuedAt,
            activeMessageId: active.messageId,
            activeStartedAt: active.startedAt,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )
      }

      const activeAtStart = getActiveChatStream(conversationId)
      if (activeAtStart) {
        if (activeAtStart.messageId === messageId) {
          return new Response(
            JSON.stringify({
              error: "This stream is already active",
              code: "stream_already_active",
              activeMessageId: activeAtStart.messageId,
              activeStartedAt: activeAtStart.startedAt,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        }
        return queueBehindActiveStream(activeAtStart)
      }

      // Steering drain: this turn runs a queued follow-up. Claim it up front —
      // whoever loses the claim race (client drain vs server sweep) backs off
      // so the follow-up never runs twice.
      let claimedFollowUp: ChatFollowUp | null = null
      let claimedFollowUpMessageId: string | null = null
      if (requestedFollowUpId) {
        const claimed = claimFollowUp(conversationId, requestedFollowUpId)
        if (!claimed) {
          return new Response(
            JSON.stringify({
              error: "Follow-up already claimed",
              code: "followup_already_claimed",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        }
        claimedFollowUp = claimed
        claimedFollowUpMessageId = claimed.userMessageId
      }

      // Ensure conversation exists (race condition: frontend fires POST /api/conversations
      // in parallel, but /api/chat may arrive first). Do this before runtime
      // validation so setup failures still persist as normal assistant messages.
      const existingConversation = getConversation(conversationId)
      // Merge browser-supplied history with persisted history. The client normally
      // sends the full local conversation; near request-size limits it may strip
      // UI-only metadata while preserving all role/content/attachments context.
      let messagesForProvider = mergeMessagesForProvider(
        existingConversation?.messages ?? [],
        requestMessages
      )
      let restampedClaimedMessage: Message | null = null
      if (claimedFollowUpMessageId) {
        // The follow-up was typed while the PREVIOUS turn streamed, but that
        // turn's terminal persist stamps the assistant row with its completion
        // time — later than the follow-up's send time. Re-stamp the follow-up
        // to claim time so the timestamp order matches what the user saw:
        // question → answer → follow-up → its answer.
        const restampedAt = Date.now()
        let restamped: Message | null = null
        messagesForProvider = messagesForProvider.map((message) => {
          if (message.id !== claimedFollowUpMessageId) return message
          restamped = { ...message, timestamp: restampedAt }
          return restamped
        })
        if (restamped) {
          restampedClaimedMessage = restamped
          messagesForProvider.sort((a, b) => {
            const timeDelta = a.timestamp - b.timestamp
            return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id)
          })
        }
      }
      const promptContext = sanitizePromptContext(body.promptContext)
      const promptContextSource = sanitizePromptContextSource(
        body.promptContextSource
      )
      const promptContextMessageId = promptContext
        ? [...messagesForProvider].reverse().find((m) => m.role === "user")?.id
        : null
      const requestedActivations = sanitizeCapabilityActivations(
        body.activateIntegrations
      )
      const preferredFallbackIndex = sanitizePreferredFallbackIndex(
        body.preferredFallbackIndex
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

      // The "input" for the orchestrator row is the latest user turn.
      // History stays implicit (we already capture it on each message row).
      const latestUserMessage = [...messagesForProvider]
        .reverse()
        .find((m) => m.role === "user")
      const missingCurrentUploads = currentMessageMissingUploads(latestUserMessage)
      if (missingCurrentUploads.length > 0) {
        return setupErrorResponse(
          {
            error: `Missing upload file(s): ${missingCurrentUploads.map((att) => att.id).join(", ")}`,
            chatMessage: missingUploadsChatMessage(missingCurrentUploads),
            code: "missing_upload_file",
          },
          409
        )
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
      const declaredTools = getToolsForAgent(orchestrator.tools)

      const pendingUpdate = getCachedPendingUpdateForProfile(getActiveProfileId())

      type ChatModelAttempt = {
        provider: string
        model: string
        thinkingLevel: string
        modelOptions: Record<string, boolean | string | number>
        fallbackIndex?: number
      }

      const buildModelAttempts = (
        primary: typeof primaryAgentSettings,
        preferredFallback: number | null
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

        if (preferredFallback !== null) {
          const preferredIndex = attempts.findIndex(
            (attempt) => attempt.fallbackIndex === preferredFallback
          )
          if (preferredIndex > 0) {
            const [preferred] = attempts.splice(preferredIndex, 1)
            attempts.unshift(preferred)
          }
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

        const modelSupportsFunctionTools =
          settings.provider !== "openrouter" ||
          providerDef.models[settings.model]?.capabilities.includes("function_calling")
        const requestedBuiltins = modelSupportsFunctionTools
          ? orchestrator.builtins
          : []
        const candidateTools = modelSupportsFunctionTools
          ? filterIntegrationToolExposure(
              dedupeTools([
                ...declaredTools,
                ...getToolsForBuiltins(orchestrator.builtins),
              ]),
              { conversationId, origin: requestOrigin, agentId: orchestrator.id }
            )
          : []
        const toolSurface = resolveProviderToolSurface(
          candidateTools,
          requestedBuiltins,
          provider.capabilities
        )
        const modelContextWindow =
          registry[settings.provider]?.models[settings.model]?.contextWindow ??
          null
        const systemPrompt = orchestrator.buildPrompt!({
          agentId: orchestrator.id,
          userName: config.userName,
          assistantName: config.assistantName,
          availableTools: toolSurface.tools,
          availableBuiltins: toolSurface.builtins,
          customToolNamePrefix: provider.capabilities.customToolNamePrefix,
          availableAgents,
          conversationId,
          declaredToolIds: orchestrator.tools,
          declaredTools,
          delegationDepth: 0,
          maxDelegationDepth: MAX_AGENT_DEPTH,
          modelContextWindow,
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
          exposedTools: candidateTools,
          declaredTools,
          systemPrompt,
          prevSession,
          modelContextWindow,
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

      const modelAttempts = buildModelAttempts(
        primaryAgentSettings,
        preferredFallbackIndex
      )
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
      const serverAbortController = new AbortController()
      const registered = registerChatStream(
        conversationId,
        messageId,
        serverAbortController,
        { announce: false }
      )
      if (!registered) {
        if (claimedFollowUp) {
          requeueClaimedFollowUp(conversationId, claimedFollowUp)
        }
        const admissionBlock = getAiRunAdmissionBlock()
        if (admissionBlock) {
          return new Response(
            JSON.stringify({
              error: "Update in progress. The app will reconnect after restart.",
              code: "update_in_progress",
              profileId: getActiveProfileId(),
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
        const active = getActiveChatStream(conversationId)
        if (active?.messageId === messageId) {
          return new Response(
            JSON.stringify({
              error: "This stream is already active",
              code: "stream_already_active",
              activeMessageId: active.messageId,
              activeStartedAt: active.startedAt,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          )
        }
        return active
          ? queueBehindActiveStream(active)
          : new Response(
              JSON.stringify({
                error: "Another stream won the start race",
                code: "stream_start_race",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            )
      }
      try {
        if (restampedClaimedMessage) {
          addMessage(conversationId, restampedClaimedMessage)
        }
        addMessage(conversationId, assistantMsg)
        announceChatStream(conversationId, messageId)
      } catch (error) {
        clearChatStream(conversationId, messageId)
        if (claimedFollowUp) {
          requeueClaimedFollowUp(conversationId, claimedFollowUp)
        }
        throw error
      }

      // Wall-clock since the turn started — mirrors the durationMs persisted at
      // finalize so the live client can stamp "Worked for …" without a reload.
      const elapsedMs = () => Math.max(0, Date.now() - assistantMsg.timestamp)

      // Live steer function for the CURRENT provider attempt — set through
      // StreamCallbacks.onSteeringAvailable while the provider's turn accepts
      // mid-turn input (codex `turn/steer`), null otherwise. The registry
      // handle (registered inside the stream below, where `send` exists)
      // reads it at delivery time, so attempt retries/fallbacks are safe.
      let providerSteer: ((text: string) => Promise<boolean>) | null = null

      // Automatic semantic memory recall for this user turn. Computed once (a turn
      // may build resolved messages more than once across attempts), fail-open: an
      // empty string when disabled, no key, timeout, or no match — i.e. the turn
      // proceeds exactly as it did before this feature existed. See lib/memory.
      let recalledMemoryPromise: Promise<RecalledMemory> | null = null
      let recallNoteEmitted = false
      // Resolve the turn's image/PDF attachments to on-disk paths so a multimodal
      // embedding model can also drive recall from them (similar notes + files).
      // Fail-open: an unresolvable/unsupported attachment is simply skipped.
      const resolveRecallAttachments = (): RecallAttachmentInput[] => {
        const atts = Array.isArray(latestUserMessage?.attachments)
          ? latestUserMessage.attachments
          : []
        const out: RecallAttachmentInput[] = []
        for (const att of atts) {
          if (!att || (att.type !== "image" && att.type !== "pdf")) continue
          const abs = resolveExistingUploadPath(att.id)
          if (!abs) continue
          out.push({ path: abs, mimeType: att.mimeType })
        }
        return out
      }
      const resolveConversationRecallExcludePaths = (): string[] => {
        const paths = new Set<string>()
        for (const message of messagesForProvider) {
          const atts = Array.isArray(message.attachments) ? message.attachments : []
          for (const att of atts) {
            if (!att || (att.type !== "image" && att.type !== "pdf")) continue
            const abs = resolveExistingUploadPath(att.id)
            if (abs) paths.add(abs)
          }
        }
        return [...paths]
      }
      const getRecall = (): Promise<RecalledMemory> => {
        if (!recalledMemoryPromise) {
          recalledMemoryPromise = getRecalledMemory(
            latestUserMessage?.content,
            {
              attachments: resolveRecallAttachments(),
              conversationId,
              excludeFilePaths: resolveConversationRecallExcludePaths(),
            }
          ).catch(() => ({ block: "", hits: [] }))
        }
        return recalledMemoryPromise
      }

      // Start time per tool call so we can record durationMs in tool_logs.
      const toolStartTimes = new Map<string, number>()

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
      const modelRetryRecoveryAttempts: ModelRetryRecoveryAttempt[] = []

      const collectAttemptRecoveryToolCalls = (
        startIndex: number
      ): ModelRetryRecoveryAttempt["toolCalls"] =>
        accReasoning
          .slice(startIndex)
          .filter(
            (entry): entry is ToolCallReasoningEntry =>
              entry.type === "tool_call"
          )
          .map((entry) => ({
            toolName: entry.toolName,
            title: entry.title,
            args: entry.args,
            content: entry.content,
            success: entry.success,
            status: entry.status,
            deltas: entry.deltas?.map((delta) => ({
              stream: delta.stream,
              text: delta.text,
            })),
          }))

      // Merge attachments the provider reported with any upload assets the agent
      // embedded inline as markdown (e.g. a browser sub-agent screenshot the
      // orchestrator re-emits). This makes those files first-class so the Library
      // lists them and the preview lightbox can open them. Deduped by id, with
      // provider-reported attachments taking precedence.
      const withInlineUploadAttachments = (
        content: string,
        base: Attachment[]
      ): Attachment[] => {
        const inline = extractUploadAttachmentsFromContent(content)
        if (inline.length === 0) return base
        const ids = new Set(base.map((a) => a.id))
        return [...base, ...inline.filter((a) => !ids.has(a.id))]
      }
      let latestContextUsage: ContextUsageSnapshot | null =
        existingConversation?.contextUsage ?? null
      let activeContextBreakdown: ContextUsageBreakdown | null = null
      let lastPublishedContextUsageKey = latestContextUsage
        ? contextUsageKey(latestContextUsage)
        : ""
      let terminalMessageStatus: Message["status"] | null = null
      let terminalStreamError: string | null = null
      let terminalPersistedAt: number | null = null
      const persistedArtifactsThisTurn: ArtifactRow[] = []

      const persistAssistantProgress = (opts?: {
        force?: boolean
        thinkingDuration?: number
        status?: Message["status"]
        /** Provider/runtime error to surface inside the bubble (error persists). */
        errorText?: string
      }): Message | null => {
        const force = opts?.force ?? false
        const now = Date.now()
        if (
          !force &&
          now - lastProgressPersistAt < STREAM_PROGRESS_PERSIST_INTERVAL_MS
        )
          return null
        lastProgressPersistAt = now

        const effectiveStatus = opts?.status ?? terminalMessageStatus ?? undefined
        // Mid-stream progress saves keep the assistant row pinned to its start
        // timestamp so it doesn't reorder while streaming. The FINAL (terminal)
        // persist instead stamps the completion time — that's what advances the
        // conversation's lastMessageAt past any readAt the user accumulated while
        // watching the run live. Without it, a run that finishes after you've left
        // the conversation (its completion arrives via /api/sync, not this tab's
        // reader) leaves lastMessageAt frozen at start time, so the unread calc
        // reads it as already-read: no bold + no "finished" dot in the sidebar.
        const isTerminalPersist =
          effectiveStatus === "ok" ||
          effectiveStatus === "error" ||
          effectiveStatus === "aborted"
        const persistedAt = isTerminalPersist
          ? (terminalPersistedAt ??= now)
          : assistantMsg.timestamp

        // Error turns surface the failure inside the bubble. Persist exactly
        // what the live client renders so a refresh shows the same message.
        const content =
          effectiveStatus === "error" && opts?.errorText
            ? accContent
              ? `${accContent}\n\n[Error: ${opts.errorText}]`
              : `[Error: ${opts.errorText}]`
            : accContent || ""
        const contentSegments =
          effectiveStatus === "error" &&
          accContentSegments.length === 0 &&
          content
            ? [{ phase: 0, content }]
            : accContentSegments

        const persistAttachments = withInlineUploadAttachments(
          content,
          accAttachments
        )

        const message = sanitizeMessageForPersistence({
          id: messageId,
          role: "assistant",
          content,
          status: effectiveStatus,
          contentSegments,
          reasoning: accReasoning,
          thinking: accThinking || "",
          thinkingDuration: opts?.thinkingDuration,
          // Total turn wall-clock, stamped only on the terminal persist (the row's
          // timestamp is rewritten to `now` here, so the start is otherwise lost).
          durationMs: isTerminalPersist
            ? Math.max(0, persistedAt - assistantMsg.timestamp)
            : undefined,
          toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
          attachments:
            persistAttachments.length > 0 ? persistAttachments : undefined,
          // Async child events may keep updating their agent card after the
          // parent answer has already completed. Preserve the original
          // terminal timestamp/duration so those transcript updates do not
          // repeatedly make an old parent answer look newly completed.
          timestamp: persistedAt,
        })
        addMessage(conversationId, message)
        // Terminal events ship this persisted row to the live client, which
        // adopts it verbatim — the message you watched stream is byte-for-byte
        // the one a refresh loads from the DB.
        return message
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
              assignedName: event.assignedName,
              taskLabel: event.taskLabel,
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
          const artifactStream = createArtifactStreamBridge({
            conversationId,
            messageId,
            send,
            onPersistedArtifact(row) {
              persistedArtifactsThisTurn.push(row)
            },
          })
          let activeAttempt = preparedInitial

          // Live steering: POST /api/chat/steer calls this while the turn
          // streams. On provider-confirmed injection the message becomes part
          // of THIS turn: a steered_message reasoning entry marks the exact
          // injection point (always opening a fresh phase, so the transcript
          // splits into before/after), the user row persists wrapped in
          // <steered-message> (its standalone bubble is hidden — it renders
          // inline at the marker), and the live client learns about it via
          // the steered_message SSE event. Returning false sends the caller
          // down the follow-up-queue path instead.
          registerTurnSteering(conversationId, {
            messageId,
            deliver: async (message: Message): Promise<boolean> => {
              const steer = providerSteer
              if (!steer) return false
              if (terminalMessageStatus || serverAbortController.signal.aborted)
                return false
              const text =
                typeof message.content === "string" ? message.content.trim() : ""
              if (!text) return false
              if (Array.isArray(message.attachments) && message.attachments.length > 0)
                return false
              const accepted = await steer(text).catch(() => false)
              if (!accepted) return false

              reasoningPhase += 1
              streamMode = "reasoning"
              const at = Date.now()
              const entry: SteeredMessageReasoningEntry = {
                type: "steered_message",
                id: `steered_${message.id}`,
                phase: reasoningPhase,
                userMessageId: message.id,
                content: text,
                at,
                elapsedMs: elapsedMs(),
              }
              accReasoning.push(entry)
              const persistedUser: Message = {
                id: message.id,
                role: "user",
                content: wrapSteeredMessage(text),
                timestamp: at,
              }
              addMessage(conversationId, persistedUser)
              // A same-turn retry/fallback replays messagesForProvider —
              // include the injected turn so it survives an attempt death.
              messagesForProvider.push(persistedUser)
              send({ type: "steered_message", entry, userMessageId: message.id })
              persistAssistantProgress({ force: true })
              return true
            },
          })

          const publishContextUsage = (
            snapshot: ContextUsageSnapshot,
            opts?: { force?: boolean }
          ) => {
            const occupiedTokens =
              snapshot.contextTokens ?? snapshot.inputTokens ?? null
            const contextBreakdown = activeContextBreakdown
              ? reconcileContextUsageBreakdown(
                  activeContextBreakdown,
                  occupiedTokens,
                  snapshot.outputTokens
                )
              : snapshot.contextBreakdown
            const enriched = mergeContextUsage(latestContextUsage, {
              ...snapshot,
              contextBreakdown,
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

          // Fix any strict-schema artifact that failed validation this turn:
          // re-prompt the generating agent with the exact error, then commit
          // the fixed card (or report the precise failure). Invoked once after
          // the model stream completes, before the SSE stream closes.
          const repairPendingArtifacts = async () => {
            const pending = artifactStream.takePendingRepairs()
            const repairTarget = buildArtifactRepairRuntimeAgent(orchestrator)
            for (const repair of pending) {
              const repaired = await repairArtifactContent({
                type: repair.attrs.type,
                content: repair.content,
                error: repair.error,
                maxAttempts: 3,
                generate: async (userPrompt) => {
                  const result = await runTextSubAgent({
                    target: repairTarget,
                    prompt: userPrompt,
                    parentCtx: {
                      callerAgentId: orchestrator.id,
                      depth: 0,
                      conversationId,
                      parentRequestId: messageId,
                      signal: serverAbortController.signal,
                      appOrigin: requestOrigin,
                    },
                  })
                  if (!result.success) return null
                  const data = result.data as { output?: unknown } | undefined
                  return typeof data?.output === "string" ? data.output : null
                },
              })
              if (repaired.ok) {
                artifactStream.commitRepairedArtifact(repair, repaired.content)
                // Keep the stored message body (and thus future-turn history +
                // reloads) consistent with the card the user now sees. Guarded:
                // only when the original body is present verbatim — it isn't if
                // the model wrapped it in a fence that got stripped before insert.
                if (repair.content && accContent.includes(repair.content)) {
                  // Functional replacement: `$`-sequences in the repaired JSON
                  // must not be expanded as replacement patterns.
                  accContent = accContent.replace(repair.content, () => repaired.content)
                  persistAssistantProgress({ force: true, status: "ok" })
                }
                console.log(
                  `[artifact-repair] type=${repair.attrs.type} identifier=${repair.attrs.identifier} repaired after ${repaired.attempts} attempt(s)`
                )
              } else {
                artifactStream.reportRepairFailure(repair.clientToken, repaired.error)
                console.warn(
                  `[artifact-repair] type=${repair.attrs.type} identifier=${repair.attrs.identifier} repair failed after ${repaired.attempts} attempt(s): ${repaired.error}`
                )
              }
            }
          }

          // Created immediately before the try so the finally's clearInterval
          // is unskippable — an interval orphaned by a throw in earlier setup
          // would ping a dead controller forever.
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(enc.encode(`: ping\n\n`))
            } catch {
              /* controller closed — run may outlive the client; cleared below */
            }
          }, STREAM_KEEPALIVE_INTERVAL_MS)
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
              let tryNextModel = false
              for (
                let retryIndex = 0;
                retryIndex <= MAX_MODEL_RETRIES_BEFORE_FALLBACK;
                retryIndex++
              ) {
              activeAttempt = prepared
              let attemptStreamError: string | null = null
              let attemptHadToolCall = false
              const attemptContentStart = accContent.length
              const attemptReasoningStart = accReasoning.length
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
              if (
                retryIndex === 0 &&
                prepared.settings.fallbackIndex &&
                accContent.length === 0
              ) {
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

              const buildResolvedMessages = async (): Promise<
                Array<{
                  role: string
                  content: string
                  attachments?: MessageAttachment[]
                }>
              > => {
                const audioContextByMessageId =
                  await prepareAudioContextsForProvider({
                    messages: messagesForProvider,
                    provider: prepared.settings.provider,
                    parentCtx: {
                      callerAgentId: orchestrator.id,
                      depth: 0,
                      conversationId,
                      parentRequestId: messageId,
                      signal: serverAbortController.signal,
                      parentAgentRunId: messageId,
                      onAgentEvent: (event) => handleAgentEvent(event, send),
                      appOrigin: requestOrigin,
                    },
                  })

                const recall = await getRecall()
                const recalledMemoryContext = recall.block
                const modelRetryRecoveryContext =
                  buildModelRetryRecoveryContext(modelRetryRecoveryAttempts)
                // Surface the recall as a structured, collapsible card in the
                // assistant's thinking stream once per turn (auditable: which notes
                // and scores were used). Mirrors the context_compaction
                // reasoning-entry plumbing.
                if (recall.hits.length > 0 && !recallNoteEmitted) {
                  recallNoteEmitted = true
                  if (streamMode === "content") {
                    reasoningPhase += 1
                    streamMode = "reasoning"
                  }
                  const entryId = `memory_recall_${messageId}`
                  if (
                    !accReasoning.some(
                      (entry) =>
                        entry.type === "memory_recall" && entry.id === entryId
                    )
                  ) {
                    const entry: MemoryRecallReasoningEntry = {
                      type: "memory_recall",
                      id: entryId,
                      phase: reasoningPhase,
                      hits: buildRecallUiHits(recall.hits),
                    }
                    accReasoning.push(entry)
                    send({ type: "memory_recall", entry })
                    persistAssistantProgress({ force: true })
                  }
                }

                return messagesForProvider.map((m) => {
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
                  const audioContext =
                    m.role === "user"
                      ? (audioContextByMessageId.get(m.id) ?? "")
                      : ""
                  const runtimePromptContext =
                    m.id === promptContextMessageId
                      ? [
                          `<runtime_context source="${promptContextSource}">`,
                          "This context was supplied by the app UI for this turn. It is not visible user prose. Use it to answer with the relevant active capability, tools, and artifacts for the current app surface; do not quote it back verbatim.",
                          promptContext,
                          "</runtime_context>",
                        ].join("\n")
                      : ""
                  const recalledMemory =
                    m.id === latestUserMessage?.id ? recalledMemoryContext : ""
                  const modelRetryRecovery =
                    m.id === latestUserMessage?.id
                      ? modelRetryRecoveryContext
                      : ""
                  const result: {
                    role: string
                    content: string
                    attachments?: MessageAttachment[]
                  } = {
                    role: m.role,
                    content: appendPromptContext(
                      appendPromptContext(
                        appendPromptContext(
                          appendPromptContext(
                            appendPromptContext(
                              messageContent,
                              localAttachmentContext
                            ),
                            audioContext
                          ),
                          runtimePromptContext
                        ),
                        recalledMemory
                      ),
                      modelRetryRecovery
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
              }

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
                artifactStream.feed(text)
                persistAssistantProgress()
              }

              const appendMissingPersistedArtifactBlocks = (): boolean => {
                if (persistedArtifactsThisTurn.length === 0) return false
                const latestRows = new Map<string, ArtifactRow>()
                for (const row of persistedArtifactsThisTurn) {
                  const key = `${row.type}:${row.identifier}`
                  const existing = latestRows.get(key)
                  if (!existing || row.version > existing.version) {
                    latestRows.set(key, row)
                  }
                }
                const source = [...latestRows.values()]
                  .map((row) => buildArtifactBlockFromRow(row))
                  .join("\n\n")
                const missing = missingArtifactBlocks(accContent, source)
                if (missing.length === 0) return false

                const suffix = `${accContent.trim().length > 0 ? "\n\n" : ""}${missing.join("\n\n")}`
                accContent += suffix
                appendContentChunk(suffix)
                if (suffix.length > 0) streamMode = "content"
                return true
              }

              try {
                const resolvedMessages = await buildResolvedMessages()
                activeContextBreakdown = buildContextUsageBreakdown({
                  systemPrompt: prepared.systemPrompt,
                  messages: resolvedMessages,
                  tools: prepared.agentTools,
                  exposedTools: prepared.exposedTools,
                  declaredTools: prepared.declaredTools,
                  builtins: prepared.agentBuiltins,
                  availableAgentCount: availableAgents.length,
                  attachments: messagesForProvider.flatMap(
                    (message) => message.attachments ?? []
                  ),
                })
                publishContextUsage(
                  {
                    provider: prepared.settings.provider,
                    model: prepared.settings.model,
                    source: "estimated",
                    accuracy: "estimated",
                    updatedAt: Date.now(),
                    requestId: messageId,
                    contextWindow: prepared.modelContextWindow,
                    contextTokens: activeContextBreakdown.estimatedTokens,
                    inputTokens: activeContextBreakdown.estimatedTokens,
                    outputTokens: null,
                    thinkingTokens: null,
                    cachedTokens: null,
                    totalTokens: null,
                    contextBreakdown: activeContextBreakdown,
                  },
                  { force: true }
                )
                // Snapshot the EXACT input handed to the provider — the full
                // system prompt and every resolved message with injected
                // memories / runtime / attachment context already inlined — so
                // the Logs detail can show what the model actually received,
                // not just the bare user turn. Best-effort; never blocks the
                // request (logRequestInput swallows its own failures).
                logRequestInput({
                  requestId: messageId,
                  systemPrompt: prepared.systemPrompt,
                  messages: resolvedMessages.map((m) => ({
                    role: m.role,
                    content: m.content,
                    attachments: m.attachments?.map((a) => ({
                      filePath: a.filePath,
                      mimeType: a.mimeType,
                    })),
                  })),
                  tools: [
                    ...prepared.agentTools.map((t) => t.name),
                    ...prepared.agentBuiltins,
                  ],
                })
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
                    onSteeringAvailable(steer) {
                      providerSteer = steer
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
                            persistedArtifactsThisTurn.push(row)
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
                        logRequestAbort(messageId, Date.now(), accContent || null, {
                          reasoning: sanitizeReasoningForPersistence(accReasoning),
                          contentSegments: accContentSegments,
                        })
                        const persisted = persistAssistantProgress({
                          force: true,
                          thinkingDuration: 0,
                          status: "aborted",
                        })
                        send({
                          type: "stopped",
                          messageId,
                          durationMs: persisted?.durationMs ?? elapsedMs(),
                          message: persisted ?? undefined,
                        })
                        return
                      }

                      accAttachments = meta.attachments ?? []
                      // Flush any trailing parser state (unterminated tags become
                      // prose; unterminated artifacts are closed and persisted with
                      // whatever content arrived).
                      artifactStream.flush()
                      appendMissingPersistedArtifactBlocks()

                      // Save final message and emit an add_message sync event.
                      terminalMessageStatus = "ok"
                      const persisted = persistAssistantProgress({
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
                            prepared.settings.provider === "claude-code" ||
                            prepared.settings.provider === "google") &&
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
                                // Some providers report cumulative whole-run usage at
                                // turn end (codex's `.total`, Gemini's sum across
                                // Interactions tool-loop rounds). That's correct for
                                // billing/logs, but the context window gauge must show
                                // the LAST provider request's prompt occupancy. The
                                // live stream already captured that per request, so
                                // keep those numbers instead of the cumulative ones.
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
                        reasoning: sanitizeReasoningForPersistence(accReasoning),
                        contentSegments: accContentSegments,
                      })

                      send({
                        type: "done",
                        messageId,
                        status: "ok",
                        thinkingDuration: meta.thinkingDuration,
                        durationMs: persisted?.durationMs ?? elapsedMs(),
                        usage: meta.usage,
                        interactionId: meta.sessionId,
                        attachments: accAttachments,
                        message: persisted ?? undefined,
                      })

                      void maybeAutoNameAttachmentOnlyConversation({
                        conversationId,
                        assistantMessageId: messageId,
                        assistantText: persisted?.content ?? accContent,
                      }).catch((error) => {
                        console.warn(
                          "Failed to auto-name attachment-only conversation",
                          error
                        )
                      })

                      const completedConversation = getConversation(conversationId)
                      // The notification body should carry only the final answer —
                      // the text that renders after the last reasoning/tool phase
                      // (the "Worked for…" block) in chat — not the interim
                      // narration emitted before or between tool calls. Content
                      // segments merge consecutive same-phase chunks, so the last
                      // non-empty segment is exactly that closing answer; for a
                      // single-phase turn it equals the whole response. Fall back to
                      // the full content if there are no segments to read.
                      const finalAnswer =
                        [...accContentSegments]
                          .reverse()
                          .find((segment) => segment.content.trim().length > 0)
                          ?.content ?? accContent
                      void sendChatCompletionPushNotification({
                        conversationId,
                        title: completedConversation?.title ?? "Chat finished",
                        body: stripArtifactBlocksForPreview(finalAnswer),
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
                        logRequestAbort(messageId, Date.now(), accContent || null, {
                          reasoning: sanitizeReasoningForPersistence(accReasoning),
                          contentSegments: accContentSegments,
                        })
                        const persisted = persistAssistantProgress({
                          force: true,
                          thinkingDuration: 0,
                          status: terminalMessageStatus,
                        })
                        send({
                          type: "stopped",
                          messageId,
                          durationMs: persisted?.durationMs ?? elapsedMs(),
                          message: persisted ?? undefined,
                        })
                        return
                      }
                      logRequestFail(
                        messageId,
                        error,
                        Date.now(),
                        accContent || null,
                        {
                          reasoning: sanitizeReasoningForPersistence(accReasoning),
                          contentSegments: accContentSegments,
                        }
                      )
                    },
                  }
                )

                // In-turn artifact repair: if any strict-schema artifact failed
                // validation while streaming, fix it now by feeding the exact
                // error back to the generating agent before the stream closes.
                // The `done` event has already been sent, but the client keeps
                // reading until stream close and applies the artifact row
                // independently, so the corrected card replaces the streaming
                // placeholder with no broken-card flash.
                if (
                  !terminalStreamError &&
                  !attemptStreamError &&
                  !serverAbortController.signal.aborted &&
                  artifactStream.hasPendingRepairs()
                ) {
                  await repairPendingArtifacts()
                }
              } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : "Unknown error"
                if (!attemptStreamError) {
                  attemptStreamError = msg
                  const aborted = serverAbortController.signal.aborted
                  console.error("Streaming error:", msg)
                  if (aborted) {
                    terminalStreamError = msg
                    terminalMessageStatus = "aborted"
                    logRequestAbort(messageId, Date.now(), accContent || null, {
                      reasoning: sanitizeReasoningForPersistence(accReasoning),
                      contentSegments: accContentSegments,
                    })
                    const persisted = persistAssistantProgress({
                      force: true,
                      thinkingDuration: 0,
                      status: terminalMessageStatus,
                    })
                    send({
                      type: "stopped",
                      messageId,
                      durationMs: persisted?.durationMs ?? elapsedMs(),
                      message: persisted ?? undefined,
                    })
                  } else {
                    logRequestFail(messageId, msg, Date.now(), accContent || null, {
                      reasoning: sanitizeReasoningForPersistence(accReasoning),
                      contentSegments: accContentSegments,
                    })
                  }
                }
              } finally {
                // The attempt's turn is over (done, error, or abort) — a
                // provider that died without retracting must not leave a
                // stale steer function pointing at a dead process.
                providerSteer = null
              }
              if (
                terminalMessageStatus === "ok" ||
                terminalMessageStatus === "aborted"
              ) {
                break
              }
              if (attemptStreamError) {
                lastModelAttemptError = attemptStreamError
                const attemptProducedContent =
                  accContent.length !== attemptContentStart
                const canAttemptRecovery =
                  !attemptProducedContent &&
                  shouldTryModelFallback(attemptStreamError, {
                    afterToolCall: attemptHadToolCall,
                  })
                if (
                  canAttemptRecovery &&
                  retryIndex < MAX_MODEL_RETRIES_BEFORE_FALLBACK
                ) {
                  if (attemptHadToolCall) {
                    const toolCalls =
                      collectAttemptRecoveryToolCalls(attemptReasoningStart)
                    if (toolCalls.length > 0) {
                      modelRetryRecoveryAttempts.push({
                        provider: prepared.settings.provider,
                        model: prepared.settings.model,
                        retry: retryIndex,
                        error: attemptStreamError,
                        toolCalls,
                      })
                    }
                  }
                  const note = `Model ${prepared.settings.provider}:${prepared.settings.model} failed before final output; retrying same model (${retryIndex + 1}/${MAX_MODEL_RETRIES_BEFORE_FALLBACK}).\n`
                  accThinking += note
                  appendThinkingChunk(note)
                  send({ type: "thinking", content: note })
                  persistAssistantProgress({ force: true })
                  continue
                }
                const canTryFallback =
                  canAttemptRecovery && attemptIndex < modelAttempts.length - 1
                if (canTryFallback) {
                  if (attemptHadToolCall) {
                    const toolCalls =
                      collectAttemptRecoveryToolCalls(attemptReasoningStart)
                    if (toolCalls.length > 0) {
                      modelRetryRecoveryAttempts.push({
                        provider: prepared.settings.provider,
                        model: prepared.settings.model,
                        retry: retryIndex,
                        error: attemptStreamError,
                        toolCalls,
                      })
                    }
                  }
                  const note = `Model ${prepared.settings.provider}:${prepared.settings.model} failed before final output; trying fallback.\n`
                  accThinking += note
                  appendThinkingChunk(note)
                  send({ type: "thinking", content: note })
                  persistAssistantProgress({ force: true })
                  tryNextModel = true
                  break
                }
                terminalStreamError = attemptStreamError
                terminalMessageStatus = "error"
                const persisted = persistAssistantProgress({
                  force: true,
                  thinkingDuration: 0,
                  status: terminalMessageStatus,
                  errorText: attemptStreamError,
                })
                send({
                  type: "error",
                  error: attemptStreamError,
                  durationMs: persisted?.durationMs ?? elapsedMs(),
                  message: persisted ?? undefined,
                })
                break
              }
              }
              if (tryNextModel) continue
              if (terminalMessageStatus) break
            }
            if (!terminalMessageStatus) {
              const error =
                lastModelAttemptError ?? "All configured model attempts failed."
              terminalStreamError = error
              terminalMessageStatus = "error"
              const persisted = persistAssistantProgress({
                force: true,
                thinkingDuration: 0,
                status: terminalMessageStatus,
                errorText: error,
              })
              send({
                type: "error",
                error,
                durationMs: persisted?.durationMs ?? elapsedMs(),
                message: persisted ?? undefined,
              })
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : "Unknown error"
            const aborted = serverAbortController.signal.aborted
            console.error("Streaming error:", msg)

            const persisted = persistAssistantProgress({
              force: true,
              thinkingDuration: 0,
              status: aborted ? "aborted" : "error",
              errorText: aborted ? undefined : msg,
            })

            if (aborted) {
              logRequestAbort(messageId, Date.now(), accContent || null, {
                reasoning: sanitizeReasoningForPersistence(accReasoning),
                contentSegments: accContentSegments,
              })
            } else {
              logRequestFail(messageId, msg, Date.now(), accContent || null, {
                reasoning: sanitizeReasoningForPersistence(accReasoning),
                contentSegments: accContentSegments,
              })
            }

            send(
              aborted
                ? {
                    type: "stopped",
                    messageId,
                    durationMs: persisted?.durationMs ?? elapsedMs(),
                    message: persisted ?? undefined,
                  }
                : {
                    type: "error",
                    error: msg,
                    durationMs: persisted?.durationMs ?? elapsedMs(),
                    message: persisted ?? undefined,
                  }
            )
          } finally {
            clearInterval(keepalive)
            clearTurnSteering(conversationId, messageId)
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
  })
}
