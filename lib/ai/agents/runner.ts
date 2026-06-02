import { randomUUID } from 'crypto'

import type {
    AgentConfig,
    AgentRunEvent,
    GeneratedMediaAsset,
    ImageGenResult,
    MusicGenResult,
    SpeechGenResult,
    ToolExecutionContext,
    ToolResult,
    VideoGenJob,
} from './types'
import { MAX_AGENT_DEPTH } from './types'
import { getAgent } from './registry'
import { AUDIO_CONTEXT_AGENT_ID } from './audio-context-agent'
import { getProvider, getProviderCapabilities } from '@/lib/ai/providers'
import { formatAssetSummary, saveGeneratedAsset } from '@/lib/ai/media-assets'
import {
    appendBoundedToolDelta,
    sanitizeReasoningForPersistence,
    sanitizeToolCallSummaries,
} from '@/lib/ai/reasoning-limits'
import { getApiKey, getEffectiveAgentSettings } from '@/lib/config'
import { getEffectiveModel } from '@/lib/models/registry'
import { getToolsForAgent, getToolsForBuiltins, resolveProviderToolSurface } from '@/lib/ai/tools/registry'
import { redactToolArgs } from '@/lib/ai/tools/redaction'
import { filterIntegrationToolExposure } from '@/lib/integrations/exposure'
import {
    appendPromptContext,
    buildAttachmentContext,
    canProviderReadLocalUploads,
} from '@/lib/ai/attachment-context'
import { resolveExistingUploadPath } from '@/lib/uploads'
import { isFileSupportedByProvider } from '@/lib/config'
import type { MessageAttachment } from './types'
import {
    addAgentThreadTurn,
    type AgentThreadMessage,
    getAgentThreadInteractionId,
    getAgentThreadMessages,
    touchAgentThreadRuntime,
    updateAgentThreadInteractionId,
} from '@/lib/db'
import {
    buildAutoArtifactTag,
    getDirectEmitArtifactData,
    stripDirectEmitPayload,
} from '@/lib/artifacts/direct-emit'
import {
    logRequestStart,
    logRequestComplete,
    logRequestFail,
    logRequestAbort,
    logToolCall,
} from '@/lib/observability/store'
import type { Attachment, ContentSegment, ReasoningEntry } from '@/lib/types'

interface RuntimeAgentSettings {
    provider: string
    model: string
    thinkingLevel: AgentConfig['thinkingLevel']
    modelOptions: Record<string, boolean | string | number>
    fallbackIndex?: number
}

interface RunTextSubAgentArgs {
    target: AgentConfig
    prompt: string
    parentCtx: ToolExecutionContext
    agentThreadId?: string
    cwd?: string
    /** User attachments to forward to the model on this turn. */
    attachments?: Attachment[]
}

interface RunMediaSubAgentArgs {
    target: AgentConfig
    prompt: string
    parentCtx: ToolExecutionContext
    agentThreadId?: string
}

const VIDEO_POLL_INTERVAL_MS = 10_000
const VIDEO_POLL_TIMEOUT_MS = 10 * 60_000

/**
 * Run a text-kind sub-agent to completion and return its final assistant
 * message as a tool result. Runs are non-streaming from the caller's view —
 * the parent agent receives one consolidated answer string.
 *
 * Logging: each sub-agent call gets its own row in `request_logs` with
 * `parentRequestId` pointing back to the caller. The Logs tab shows the
 * tree by joining on this column.
 */
export async function runTextSubAgent(args: RunTextSubAgentArgs): Promise<ToolResult> {
    const runtimes = resolveAgentRuntimeCandidates(args.target)
    let lastResult: ToolResult | null = null

    for (let index = 0; index < runtimes.length; index++) {
        const result = await runTextSubAgentAttempt(args, runtimes[index])
        if (result.success) return result
        lastResult = result
        if (index >= runtimes.length - 1) break
        if (!isFallbackSafeToolResult(result)) break
        if (!shouldTryModelFallback(result.error)) break
    }

    return lastResult ?? {
        success: false,
        error: `Sub-agent ${args.target.id} failed before a model attempt could start.`,
    }
}

async function runTextSubAgentAttempt(args: RunTextSubAgentArgs, runtime: RuntimeAgentSettings): Promise<ToolResult> {
    const { target, prompt, parentCtx, agentThreadId, cwd, attachments } = args
    const prevSession = agentThreadId ? getAgentThreadInteractionId(agentThreadId, runtime.provider, runtime.model) : null
    if (agentThreadId) touchAgentThreadRuntime(agentThreadId, runtime.provider, runtime.model)

    if (!runtime.provider || !runtime.model) {
        return {
            success: false,
            error: `Sub-agent ${target.id} is missing provider/model — cannot run.`,
            data: { fallbackSafe: true },
        }
    }
    // CLI-backed agents can omit buildPrompt — they pass
    // the user prompt straight through to the subprocess. Pure-LLM agents
    // require a buildPrompt for their system prompt.
    const isProviderBackedWithoutPrompt = runtime.provider === 'browser'
    const isCliBacked = runtime.provider === 'claude-code' || runtime.provider === 'codex'
    if (!target.buildPrompt && !isCliBacked && !isProviderBackedWithoutPrompt) {
        return {
            success: false,
            error: `Sub-agent ${target.id} is missing buildPrompt — text agents require one.`,
            data: { fallbackSafe: false },
        }
    }

    const providerCaps = getProviderCapabilities(runtime.provider)
    const apiKey = getApiKey(runtime.provider)
    if (providerCaps?.requiresApiKey !== false && !apiKey) {
        return {
            success: false,
            error: `Sub-agent ${target.id}: API key missing for provider ${runtime.provider}`,
            data: { fallbackSafe: true },
        }
    }

    const provider = getProvider(runtime.provider, apiKey ?? '')
    if (!provider.stream) {
        return {
            success: false,
            error: `Sub-agent ${target.id}: provider ${runtime.provider} doesn't support text streaming yet (stub)`,
            data: { fallbackSafe: true },
        }
    }

    const subRequestId = `sub_${randomUUID()}`
    const startedAt = Date.now()
    const subDepth = parentCtx.depth + 1

    logRequestStart({
        requestId: subRequestId,
        conversationId: parentCtx.conversationId,
        agentId: target.id,
        provider: runtime.provider,
        model: runtime.model,
        thinkingLevel: runtime.thinkingLevel ?? 'medium',
        statefulMode: Boolean(prevSession),
        startedAt,
        agentThreadId,
        parentRequestId: parentCtx.parentRequestId,
        depth: subDepth,
        inputText: prompt,
    })

    emitAgent(parentCtx, {
        type: 'agent_start',
        runId: subRequestId,
        parentRunId: parentCtx.parentAgentRunId,
        toolCallId: parentCtx.currentToolCallId,
        agentId: target.id,
        agentName: target.name,
        kind: target.kind,
        agentThreadId,
        prompt,
        depth: subDepth,
        startedAt,
    })

    // Resolve sub-agent's tools. If it can call further sub-agents, include
    // delegate_to so the depth chain can extend (until MAX_AGENT_DEPTH).
    const canDelegate = (target.canCallAgents?.length ?? 0) > 0 && subDepth < MAX_AGENT_DEPTH
    const baseTools = getToolsForAgent(target.tools).filter(tool => {
        // Do not advertise an unusable delegation tool at the depth cap.
        if (tool.id !== 'delegate_to' && tool.id !== 'delegate_parallel') return true
        return canDelegate
    })
    // Gate integration operational tools, then remove custom schemas that
    // duplicate this provider's native built-ins.
    const candidateTools = filterIntegrationToolExposure(
        dedupeTools(canDelegate
            ? [...baseTools, ...getToolsForBuiltins(target.builtins), ...getToolsForAgent(['delegate_to', 'delegate_parallel'])]
            : [...baseTools, ...getToolsForBuiltins(target.builtins)]),
        { conversationId: parentCtx.conversationId, origin: parentCtx.appOrigin, agentId: target.id }
    )
    const toolSurface = resolveProviderToolSurface(candidateTools, target.builtins, provider.capabilities)
    const agentTools = toolSurface.tools
    const agentBuiltins = toolSurface.builtins

    const subToolContext: ToolExecutionContext = {
        callerAgentId: target.id,
        depth: subDepth,
        conversationId: parentCtx.conversationId,
        agentThreadId,
        parentRequestId: subRequestId,
        signal: parentCtx.signal,
        parentAgentRunId: subRequestId,
        onAgentEvent: parentCtx.onAgentEvent,
        appOrigin: parentCtx.appOrigin,
    }

    const threadMessages = agentThreadId ? getAgentThreadMessages(agentThreadId) : []
    const safeAttachments = (attachments ?? []).filter(att =>
        att && typeof att.id === 'string' && resolveExistingUploadPath(att.id) !== null
    )
    const attachmentContext = safeAttachments.length > 0
        ? buildAttachmentContext(safeAttachments, {
            includeLocalPath: canProviderReadLocalUploads(runtime.provider),
        })
        : ''
    const promptWithAttachments = appendPromptContext(prompt, attachmentContext)
    const providerAttachments: MessageAttachment[] = []
    if (safeAttachments.length > 0) {
        for (const att of safeAttachments) {
            const mimeType = typeof att.mimeType === 'string'
                ? att.mimeType.split(';')[0].trim()
                : ''
            if (!mimeType) continue
            if (!isFileSupportedByProvider(runtime.provider, mimeType)) continue
            const filePath = resolveExistingUploadPath(att.id)
            if (!filePath) continue
            providerAttachments.push({ filePath, mimeType })
        }
    }
    const messages = buildSubAgentMessages(
        runtime.provider,
        threadMessages,
        promptWithAttachments,
        Boolean(prevSession),
        providerAttachments,
    )

    // Resolve sub-callable agents from the registry so the prompt has full
    // descriptions. Gated by canDelegate: at the depth cap the delegate_to
    // tool is withheld (above), so the roster and the runtime_context
    // delegation line must agree and advertise nothing the agent can't use.
    const availableAgents = canDelegate
        ? (target.canCallAgents ?? [])
            .map(id => getAgent(id))
            .filter((a): a is AgentConfig => a !== undefined)
        : []

    // Build the system prompt whenever the agent has one — including
    // CLI-backed agents can still receive a built system prompt. Providers
    // adapt it to their own invocation mechanism. Agents without a
    // `buildPrompt` get an undefined prompt.
    const systemPrompt = target.buildPrompt
        ? target.buildPrompt({
            agentId: target.id,
            userName: '',
            assistantName: target.name,
            availableTools: agentTools,
            availableBuiltins: agentBuiltins,
            availableAgents,
            conversationId: parentCtx.conversationId,
            agentThreadId,
            declaredToolIds: target.tools,
            declaredTools: getToolsForAgent(target.tools),
            delegationDepth: subDepth,
            maxDelegationDepth: MAX_AGENT_DEPTH,
            extra: parentCtx.appOrigin ? { appOrigin: parentCtx.appOrigin } : undefined,
        })
        : undefined

    let accContent = ''
    let accThinking = ''
    const contentSegments: ContentSegment[] = []
    const reasoning: ReasoningEntry[] = []
    let phase = 0
    let streamMode: 'reasoning' | 'content' = 'reasoning'
    let toolCallCount = 0
    const toolStartTimes = new Map<string, number>()
    let providerError: string | null = null
    let finalUsage: unknown
    let finalThinkingDuration: number | undefined
    let finalAttachments: Attachment[] = []

    try {
        await provider.stream({
            model: runtime.model,
            messages,
            systemPrompt,
            thinkingLevel: runtime.thinkingLevel,
            modelOptions: runtime.modelOptions,
            tools: agentTools.length > 0 ? agentTools : undefined,
            builtins: agentBuiltins,
            prevSession,
            toolContext: subToolContext,
            cwd,
            signal: parentCtx.signal,
        }, {
            onThinking(text) {
                if (streamMode === 'content') {
                    phase += 1
                    streamMode = 'reasoning'
                }
                accThinking += text
                appendThinking(reasoning, phase, text)
                emitAgent(parentCtx, { type: 'agent_thinking', runId: subRequestId, phase, content: text })
            },
            onThinkingDone(seconds) {
                emitAgent(parentCtx, { type: 'agent_thinking_done', runId: subRequestId, seconds })
            },
            onContent(text) {
                if (text.length > 0) streamMode = 'content'
                accContent += text
                appendContent(contentSegments, phase, text)
                emitAgent(parentCtx, { type: 'agent_content', runId: subRequestId, phase, content: text })
            },
            onToolCall(tc) {
                if (streamMode === 'content') {
                    phase += 1
                    streamMode = 'reasoning'
                }
                const existing = reasoning.some(item => item.type === 'tool_call' && item.toolCallId === tc.id)
                if (existing) return
                toolCallCount++
                toolStartTimes.set(tc.id, Date.now())
                const safeArgs = redactToolArgs(tc.name, tc.arguments) ?? {}
                const title = buildToolTitle(tc.name, safeArgs)
                reasoning.push({
                    type: 'tool_call',
                    id: `tool_${tc.id}`,
                    phase,
                    toolCallId: tc.id,
                    title,
                    content: '',
                    toolName: tc.name,
                    args: safeArgs,
                    status: 'running',
                    startedAt: Date.now(),
                })
                emitAgent(parentCtx, {
                    type: 'agent_tool_call',
                    runId: subRequestId,
                    phase,
                    toolCall: { ...tc, arguments: safeArgs, title },
                })
            },
            onToolDelta(toolCallId, toolName, delta) {
                const entry = reasoning.find(item => item.type === 'tool_call' && item.toolCallId === toolCallId)
                if (entry?.type === 'tool_call') {
                    entry.deltas = appendBoundedToolDelta(entry.deltas, delta)
                    entry.status = 'running'
                }
                emitAgent(parentCtx, {
                    type: 'agent_tool_delta',
                    runId: subRequestId,
                    toolCallId,
                    toolName,
                    delta,
                })
            },
            onToolResult(toolCallId, toolName, result) {
                const directEmit = result.success
                    ? getDirectEmitArtifactData(result.data)
                    : null
                if (directEmit) {
                    const tag = buildAutoArtifactTag({
                        identifier: directEmit.identifier,
                        type: directEmit.type,
                        title: directEmit.title,
                        display: directEmit.display ?? 'inline',
                        body: directEmit.body,
                    })
                    if (tag.length > 0) streamMode = 'content'
                    accContent += tag
                    appendContent(contentSegments, phase, tag)
                    emitAgent(parentCtx, { type: 'agent_content', runId: subRequestId, phase, content: tag })
                    result = {
                        ...result,
                        data: stripDirectEmitPayload(directEmit.source),
                    }
                }
                const start = toolStartTimes.get(toolCallId)
                const end = Date.now()
                toolStartTimes.delete(toolCallId)
                logToolCall({
                    requestId: subRequestId,
                    toolName,
                    success: result.success,
                    startedAt: start ?? end,
                    durationMs: start ? end - start : null,
                    errorMessage: result.success ? null : result.error ?? null,
                })
                const entry = reasoning.find(item => item.type === 'tool_call' && item.toolCallId === toolCallId)
                if (entry?.type === 'tool_call') {
                    entry.content = sanitizeToolCallSummaries([
                        { text: entry.title, content: stringifyToolResult(result) },
                    ])?.[0]?.content ?? stringifyToolResult(result)
                    entry.success = result.success
                    entry.status = result.success ? 'ok' : 'error'
                    entry.endedAt = Date.now()
                }
                emitAgent(parentCtx, {
                    type: 'agent_tool_result',
                    runId: subRequestId,
                    toolCallId,
                    toolName,
                    result,
                })
            },
            onDone(meta) {
                if (parentCtx.signal?.aborted) {
                    logRequestAbort(subRequestId, Date.now(), accContent || null, {
                        reasoning: sanitizeReasoningForPersistence(reasoning),
                        contentSegments,
                    })
                    return
                }
                finalUsage = meta.usage
                finalThinkingDuration = meta.thinkingDuration
                finalAttachments = meta.attachments ?? []
                if (providerError) return
                logRequestComplete({
                    requestId: subRequestId,
                    endedAt: Date.now(),
                    thinkingMs: typeof meta.thinkingDuration === 'number' ? meta.thinkingDuration * 1000 : null,
                    interactionId: meta.sessionId ?? null,
                    usage: meta.usage,
                    provider: runtime.provider,
                    outputText: accContent || null,
                    reasoning: sanitizeReasoningForPersistence(reasoning),
                    contentSegments,
                })
                if (agentThreadId && meta.sessionId) {
                    updateAgentThreadInteractionId(agentThreadId, runtime.provider, runtime.model, meta.sessionId)
                }
            },
            onError(err) {
                providerError = mergeProviderError(providerError, err)
                const reasoningExtra = {
                    reasoning: sanitizeReasoningForPersistence(reasoning),
                    contentSegments,
                }
                if (parentCtx.signal?.aborted) {
                    logRequestAbort(subRequestId, Date.now(), accContent || null, reasoningExtra)
                } else {
                    logRequestFail(subRequestId, providerError, Date.now(), accContent || null, reasoningExtra)
                }
            },
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown sub-agent error'
        const reasoningExtra = {
            reasoning: sanitizeReasoningForPersistence(reasoning),
            contentSegments,
        }
        if (parentCtx.signal?.aborted) {
            logRequestAbort(subRequestId, Date.now(), accContent || null, reasoningExtra)
            emitAgent(parentCtx, {
                type: 'agent_done',
                runId: subRequestId,
                status: 'aborted',
                endedAt: Date.now(),
                content: accContent,
                reasoning: sanitizeReasoningForPersistence(reasoning),
                contentSegments,
                error: `Sub-agent ${target.id} aborted`,
            })
            return { success: false, error: `Sub-agent ${target.id} aborted`, data: { fallbackSafe: false } }
        }
        logRequestFail(subRequestId, msg, Date.now(), accContent || null, reasoningExtra)
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId: subRequestId,
            status: 'error',
            endedAt: Date.now(),
            content: accContent,
            reasoning: sanitizeReasoningForPersistence(reasoning),
            contentSegments,
            error: msg,
        })
        return {
            success: false,
            error: `Sub-agent ${target.id} failed: ${msg}`,
            data: { fallbackSafe: !accContent.trim() && toolCallCount === 0 },
        }
    }

    if (parentCtx.signal?.aborted) {
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId: subRequestId,
            status: 'aborted',
            endedAt: Date.now(),
            content: accContent,
            reasoning: sanitizeReasoningForPersistence(reasoning),
            contentSegments,
            error: `Sub-agent ${target.id} aborted`,
        })
        return { success: false, error: `Sub-agent ${target.id} aborted`, data: { fallbackSafe: false } }
    }

    if (providerError) {
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId: subRequestId,
            status: 'error',
            endedAt: Date.now(),
            content: accContent,
            reasoning: sanitizeReasoningForPersistence(reasoning),
            contentSegments,
            error: providerError,
        })
        return {
            success: false,
            error: `Sub-agent ${target.id} reported error: ${providerError}`,
            data: { fallbackSafe: !accContent.trim() && toolCallCount === 0 },
        }
    }

    // Empty text output is a legitimate outcome when the agent communicated
    // via tool calls (e.g. notify_inbox-only replies). Only treat as failure
    // when literally nothing happened — no text and no tools — which usually
    // signals a misconfigured provider.
    if (!accContent.trim() && toolCallCount === 0) {
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId: subRequestId,
            status: 'error',
            endedAt: Date.now(),
            content: accContent,
            reasoning: sanitizeReasoningForPersistence(reasoning),
            contentSegments,
            error: `Sub-agent ${target.id} produced no content.`,
        })
        return {
            success: false,
            error: `Sub-agent ${target.id} produced no content. Check that its provider/model are configured.`,
            data: { fallbackSafe: true },
        }
    }

    void accThinking

    if (agentThreadId) {
        addAgentThreadTurn(agentThreadId, {
            prompt,
            output: accContent,
            requestId: subRequestId,
        })
    }

    emitAgent(parentCtx, {
        type: 'agent_done',
        runId: subRequestId,
        status: 'ok',
        endedAt: Date.now(),
        content: accContent,
        reasoning: sanitizeReasoningForPersistence(reasoning),
        contentSegments,
        attachments: finalAttachments.length > 0 ? finalAttachments : undefined,
        usage: finalUsage,
        thinkingDuration: finalThinkingDuration,
    })

    return {
        success: true,
        data: {
            agentId: target.id,
            agentThreadId,
            agent_thread_id: agentThreadId,
            output: accContent,
            attachments: finalAttachments,
            files: finalAttachments.map(attachment => ({
                id: attachment.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                url: `/api/uploads/${attachment.id}`,
            })),
        },
    }
}

export async function runMediaSubAgent(args: RunMediaSubAgentArgs): Promise<ToolResult> {
    const { target, prompt, parentCtx, agentThreadId } = args
    const runtime = resolveAgentRuntimeSettings(target)
    if (agentThreadId) touchAgentThreadRuntime(agentThreadId, runtime.provider, runtime.model)
    const providerCaps = getProviderCapabilities(runtime.provider)
    const apiKey = getApiKey(runtime.provider)
    if (providerCaps?.requiresApiKey !== false && !apiKey) {
        return {
            success: false,
            error: `Sub-agent ${target.id}: API key missing for provider ${runtime.provider}`,
        }
    }

    const provider = getProvider(runtime.provider, apiKey ?? '')
    const missing = !providerCaps?.kinds.includes(target.kind)
    if (missing) {
        return {
            success: false,
            error: `Provider ${runtime.provider} is not configured for ${target.kind} generation.`,
        }
    }

    const runId = `sub_${randomUUID()}`
    const startedAt = Date.now()
    const subDepth = parentCtx.depth + 1

    logRequestStart({
        requestId: runId,
        conversationId: parentCtx.conversationId,
        agentId: target.id,
        provider: runtime.provider,
        model: runtime.model,
        thinkingLevel: runtime.thinkingLevel ?? 'medium',
        statefulMode: false,
        startedAt,
        agentThreadId,
        parentRequestId: parentCtx.parentRequestId,
        depth: subDepth,
        inputText: prompt,
    })

    emitAgent(parentCtx, {
        type: 'agent_start',
        runId,
        parentRunId: parentCtx.parentAgentRunId,
        toolCallId: parentCtx.currentToolCallId,
        agentId: target.id,
        agentName: target.name,
        kind: target.kind,
        agentThreadId,
        prompt,
        depth: subDepth,
        startedAt,
    })

    try {
        let summary = ''
        let attachments: Attachment[] = []
        let assets: GeneratedMediaAsset[] = []
        let usage: unknown

        if (target.kind === 'image') {
            if (!provider.generateImage) throw new Error(`Provider ${runtime.provider} does not implement image generation`)
            const result = await provider.generateImage({
                model: runtime.model,
                prompt,
                aspectRatio: inferImageAspectRatio(prompt),
                n: inferCount(prompt),
                modelOptions: runtime.modelOptions,
                signal: parentCtx.signal,
            })
            usage = result.usage
            assets = saveImageResults(result)
            attachments = assets.map(a => a.attachment)
            summary = formatAssetSummary('Generated image', assets)
            if (result.sources?.length) {
                summary += `\n\nSources:\n${result.sources.map(source => `- [${source.title ?? source.uri}](${source.uri})`).join('\n')}`
            }
        } else if (target.kind === 'video') {
            if (!provider.generateVideo || !provider.pollVideoJob) throw new Error(`Provider ${runtime.provider} does not implement video generation`)
            const initial = await provider.generateVideo({
                model: runtime.model,
                prompt,
                aspectRatio: inferVideoAspectRatio(prompt),
                durationSeconds: inferDurationSeconds(prompt),
                modelOptions: runtime.modelOptions,
                signal: parentCtx.signal,
            })
            emitAgent(parentCtx, {
                type: 'agent_content',
                runId,
                content: `Started video job ${initial.id}. Waiting for completion...\n`,
            })
            const done = await pollVideoUntilDone(provider.pollVideoJob.bind(provider), initial, parentCtx.signal)
            if (done.status === 'failed') throw new Error(done.error ?? 'Video generation failed')
            usage = done.usage
            if (done.video) {
                assets = [saveGeneratedAsset(done.video.data, done.video.mimeType, 'generated-video')]
                attachments = assets.map(a => a.attachment)
            } else if (done.videoUrl) {
                summary = `Generated video: ${done.videoUrl}`
            } else {
                throw new Error('Video generation completed without a downloadable video')
            }
            if (assets.length > 0) summary = formatAssetSummary('Generated video', assets)
        } else if (target.kind === 'speech') {
            if (!provider.generateSpeech) throw new Error(`Provider ${runtime.provider} does not implement speech generation`)
            const result: SpeechGenResult = await provider.generateSpeech({
                model: runtime.model,
                text: prompt,
                voice: inferVoice(prompt),
                format: 'wav',
                modelOptions: runtime.modelOptions,
                signal: parentCtx.signal,
            })
            usage = result.usage
            assets = [saveGeneratedAsset(result.data, result.mimeType, 'generated-speech')]
            attachments = assets.map(a => a.attachment)
            summary = formatAssetSummary('Generated speech', assets)
        } else if (target.kind === 'music') {
            if (!provider.generateMusic) throw new Error(`Provider ${runtime.provider} does not implement music generation`)
            const result: MusicGenResult = await provider.generateMusic({
                model: runtime.model,
                prompt,
                format: 'mp3',
                modelOptions: runtime.modelOptions,
                signal: parentCtx.signal,
            })
            usage = result.usage
            assets = [saveGeneratedAsset(result.data, result.mimeType, 'generated-music')]
            attachments = assets.map(a => a.attachment)
            const text = result.text?.trim()
            summary = `${formatAssetSummary('Generated music', assets)}${text ? `\n\n${text}` : ''}`
        } else {
            throw new Error(`Unsupported media agent kind: ${target.kind}`)
        }

        emitAgent(parentCtx, { type: 'agent_content', runId, content: summary })
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId,
            status: 'ok',
            endedAt: Date.now(),
            content: summary,
            attachments,
            usage,
        })

        logRequestComplete({
            requestId: runId,
            endedAt: Date.now(),
            thinkingMs: null,
            interactionId: null,
            usage,
            provider: runtime.provider,
            outputText: summary || null,
        })

        if (agentThreadId) {
            addAgentThreadTurn(agentThreadId, {
                prompt,
                output: summary,
                requestId: runId,
            })
        }

        return {
            success: true,
            data: {
                agentId: target.id,
                agentThreadId,
                agent_thread_id: agentThreadId,
                output: summary,
                attachments,
                files: assets.map(asset => ({
                    id: asset.attachment.id,
                    filename: asset.attachment.filename,
                    mimeType: asset.attachment.mimeType,
                    url: asset.url,
                })),
            },
        }
    } catch (err) {
        const msg = parentCtx.signal?.aborted
            ? `Sub-agent ${target.id} aborted`
            : err instanceof Error ? err.message : 'Unknown media generation error'
        if (parentCtx.signal?.aborted) {
            logRequestAbort(runId, Date.now(), null)
        } else {
            logRequestFail(runId, msg, Date.now(), null)
        }
        emitAgent(parentCtx, {
            type: 'agent_done',
            runId,
            status: parentCtx.signal?.aborted ? 'aborted' : 'error',
            endedAt: Date.now(),
            content: '',
            error: msg,
        })
        return { success: false, error: msg }
    }
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

function resolveAgentRuntimeSettings(target: AgentConfig): RuntimeAgentSettings {
    return resolveAgentRuntimeCandidates(target)[0]
}

function resolveAgentRuntimeCandidates(target: AgentConfig): RuntimeAgentSettings[] {
    if (target.provider === 'browser') {
        return [{
            provider: 'browser',
            model: target.model ?? 'default',
            thinkingLevel: target.thinkingLevel ?? 'medium',
            modelOptions: {},
        }]
    }

    const effective = getEffectiveAgentSettings(target.id)
    const primary = effective.fromOverride
        ? {
            provider: effective.provider,
            model: effective.model,
            thinkingLevel: effective.thinkingLevel,
            modelOptions: effective.modelOptions,
        }
        : {
            provider: target.provider ?? effective.provider,
            model: target.model ?? effective.model,
            thinkingLevel: effective.thinkingLevel,
            modelOptions: effective.modelOptions,
        }

    const candidates: RuntimeAgentSettings[] = [primary]
    if (supportsModelFallbacks(target)) {
        for (const [index, fallback] of effective.fallbacks.entries()) {
            candidates.push({
                provider: fallback.provider,
                model: fallback.model,
                thinkingLevel: fallback.thinkingLevel ?? effective.thinkingLevel,
                modelOptions: {},
                fallbackIndex: index + 1,
            })
        }
    }

    return dedupeRuntimeSettings(candidates).map(withSupportedThinkingLevel)
}

function supportsModelFallbacks(target: AgentConfig): boolean {
    return (
        (target.kind === 'text' || target.kind === 'concierge') &&
        target.provider !== 'browser' &&
        target.id !== AUDIO_CONTEXT_AGENT_ID &&
        target.id !== 'phone_agent' &&
        target.id !== 'android_agent'
    )
}

function dedupeRuntimeSettings(settings: RuntimeAgentSettings[]): RuntimeAgentSettings[] {
    const seen = new Set<string>()
    const out: RuntimeAgentSettings[] = []
    for (const item of settings) {
        const key = `${item.provider}:${item.model}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
    }
    return out
}

function isFallbackSafeToolResult(result: ToolResult): boolean {
    const data = result.data
    return Boolean(
        data &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        (data as { fallbackSafe?: unknown }).fallbackSafe === true
    )
}

function shouldTryModelFallback(error: string | undefined): boolean {
    const message = (error ?? '').toLowerCase()
    if (!message || message.includes('aborted')) return false
    if (message.includes('missing buildprompt')) return false
    return (
        message.includes('api key missing') ||
        message.includes('missing api key') ||
        message.includes('quota') ||
        message.includes('rate limit') ||
        message.includes('rate_limit') ||
        message.includes('out of usage') ||
        message.includes('usage limit') ||
        message.includes('session limit') ||
        (message.includes('hit your') && message.includes('limit')) ||
        message.includes('resource_exhausted') ||
        message.includes('exhausted') ||
        message.includes('overloaded') ||
        message.includes('capacity') ||
        message.includes('unavailable') ||
        message.includes('expired') ||
        message.includes('exited with code') ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('401') ||
        message.includes('model') ||
        message.includes('streaming')
    )
}

function mergeProviderError(current: string | null, next: string): string {
    if (!current) return next
    if (isGenericProcessExit(next) && !isGenericProcessExit(current)) return current
    return next
}

function isGenericProcessExit(message: string): boolean {
    return /\bexited with code\s+\d+\b/i.test(message)
}

function withSupportedThinkingLevel(runtime: RuntimeAgentSettings): RuntimeAgentSettings {
    const model = getEffectiveModel(runtime.provider, runtime.model)
    const levels = model?.thinkingLevels ?? []
    if (levels.length === 0) return { ...runtime, thinkingLevel: undefined }
    if (runtime.thinkingLevel && levels.includes(runtime.thinkingLevel)) return runtime
    return { ...runtime, thinkingLevel: model?.defaultThinkingLevel ?? levels[0] }
}

function emitAgent(ctx: ToolExecutionContext, event: AgentRunEvent): void {
    try {
        void ctx.onAgentEvent?.(event)
    } catch {
        // Agent UI telemetry must never break the tool call.
    }
}

function appendThinking(reasoning: ReasoningEntry[], phase: number, chunk: string): void {
    const last = reasoning[reasoning.length - 1]
    if (last?.type === 'thought' && last.phase === phase) {
        last.content += chunk
        return
    }
    reasoning.push({
        type: 'thought',
        id: `thought_${reasoning.length + 1}`,
        phase,
        content: chunk,
    })
}

function appendContent(segments: ContentSegment[], phase: number, chunk: string): void {
    const last = segments[segments.length - 1]
    if (last && last.phase === phase) {
        last.content += chunk
        return
    }
    segments.push({ phase, content: chunk })
}

function stringifyToolResult(result: ToolResult): string {
    if (!result.success) return `Error: ${result.error}`
    if (typeof result.data === 'object') return JSON.stringify(result.data, null, 2)
    return String(result.data ?? '')
}

function buildSubAgentMessages(
    providerId: string,
    history: AgentThreadMessage[],
    prompt: string,
    hasPrevSession: boolean,
    attachments: MessageAttachment[] = [],
): Array<{ role: string; content: string; attachments?: MessageAttachment[] }> {
    const userAttachments = attachments.length > 0 ? attachments : undefined

    if ((providerId === 'claude-code' || providerId === 'codex') && !hasPrevSession && history.length > 0) {
        return [{
            role: 'user',
            content: [
                '<agent_thread_history>',
                'This is the previous conversation between your parent agent and you. It is not the user chat.',
                ...history.map(message => `${message.role === 'assistant' ? 'agent' : 'parent'}: ${message.content}`),
                '</agent_thread_history>',
                '',
                '<new_parent_message>',
                prompt,
                '</new_parent_message>',
            ].join('\n'),
            attachments: userAttachments,
        }]
    }

    return [
        ...history.map(message => ({
            role: message.role,
            content: message.content,
        })),
        { role: 'user', content: prompt, attachments: userAttachments },
    ]
}

function buildToolTitle(toolName: string, args: Record<string, unknown> | undefined): string {
    const pathArg = typeof args?.path === 'string'
        ? args.path
        : typeof args?.file_path === 'string' ? args.file_path : ''
    if (toolName === 'read_file' || toolName === 'Read') return pathArg ? `Read ${pathArg}` : 'Read file'
    if (toolName === 'list_dir') return pathArg ? `List ${pathArg}` : 'List directory'
    if (toolName === 'delegate_to') {
        const agentId = typeof args?.agent_id === 'string' ? args.agent_id : 'agent'
        return `Delegate to ${agentId}`
    }
    if (toolName === 'delegate_parallel') {
        const count = Array.isArray(args?.jobs) ? args.jobs.length : 0
        return count > 0 ? `Delegate ${count} jobs in parallel` : 'Delegate in parallel'
    }
    if (toolName === 'RunActivatedIntegrationTool') {
        return typeof args?.tool_id === 'string' ? `Run ${args.tool_id}` : 'Run integration tool'
    }
    if (toolName === 'Write') return pathArg ? `Write ${pathArg}` : 'Write file'
    if (toolName === 'Edit') return pathArg ? `Edit ${pathArg}` : 'Edit file'
    if (toolName === 'Bash' || toolName === 'shell') return typeof args?.command === 'string' ? `Run ${String(args.command).slice(0, 80)}` : 'Run command'
    if (toolName === 'Glob') return typeof args?.pattern === 'string' ? `Glob ${args.pattern}` : 'Glob'
    if (toolName === 'Grep') return typeof args?.pattern === 'string' ? `Grep ${args.pattern}` : 'Grep'
    if (toolName === 'WebFetch') return typeof args?.url === 'string' ? `Fetch ${args.url}` : 'Fetch URL'
    if (toolName === 'SetEnv') return typeof args?.key === 'string' ? `Set env ${args.key}` : 'Set env'
    if (toolName === 'web_search' || toolName === 'WebSearch') {
        const queries = Array.isArray(args?.queries) ? args.queries.filter(q => typeof q === 'string') : []
        if (queries.length > 0) return `Search ${queries.join(', ').slice(0, 90)}`
        return typeof args?.query === 'string' ? `Search ${args.query}` : 'Search web'
    }
    if (toolName === 'TodoWrite') return 'Update todos'
    return toolName
}

function saveImageResults(result: ImageGenResult): GeneratedMediaAsset[] {
    return result.images.map((image, index) => saveGeneratedAsset(
        image.data,
        image.mimeType,
        result.images.length > 1 ? `generated-image-${index + 1}` : 'generated-image',
    ))
}

function inferImageAspectRatio(prompt: string): '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | undefined {
    if (/\b9:16\b|portrait|vertical/i.test(prompt)) return '9:16'
    if (/\b16:9\b|landscape|widescreen/i.test(prompt)) return '16:9'
    if (/\b4:3\b/i.test(prompt)) return '4:3'
    if (/\b3:4\b/i.test(prompt)) return '3:4'
    if (/\b1:1\b|square/i.test(prompt)) return '1:1'
    return undefined
}

function inferVideoAspectRatio(prompt: string): '16:9' | '9:16' | '1:1' | undefined {
    if (/\b9:16\b|portrait|vertical/i.test(prompt)) return '9:16'
    if (/\b1:1\b|square/i.test(prompt)) return '1:1'
    if (/\b16:9\b|landscape|widescreen/i.test(prompt)) return '16:9'
    return undefined
}

function inferCount(prompt: string): number | undefined {
    const match = prompt.match(/\b(?:generate|make|create)\s+(\d{1,2})\s+(?:images?|variants?|options?)\b/i)
    if (!match) return undefined
    const count = Number(match[1])
    if (!Number.isFinite(count)) return undefined
    return Math.max(1, Math.min(4, count))
}

function inferDurationSeconds(prompt: string): number | undefined {
    const match = prompt.match(/\b(\d{1,3})\s*(?:s|sec|secs|seconds?)\b/i)
    if (!match) return undefined
    const seconds = Number(match[1])
    if (!Number.isFinite(seconds)) return undefined
    return Math.max(1, Math.min(60, seconds))
}

function inferVoice(prompt: string): string | undefined {
    const match = prompt.match(/\bvoice\s*[:=]\s*([A-Za-z]+)/i)
    return match?.[1]
}

async function pollVideoUntilDone(
    poll: (jobId: string) => Promise<VideoGenJob>,
    initial: VideoGenJob,
    signal?: AbortSignal
): Promise<VideoGenJob> {
    let job = initial
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
    while (job.status !== 'done' && job.status !== 'failed') {
        if (signal?.aborted) throw new Error('Video generation aborted')
        if (Date.now() > deadline) throw new Error('Video generation timed out')
        await new Promise(resolve => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS))
        job = await poll(job.id)
    }
    return job
}
