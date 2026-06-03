import { GoogleGenAI } from '@google/genai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
    AIProvider,
    ImageGenOptions,
    ImageGenResult,
    MusicGenOptions,
    MusicGenResult,
    ProviderCapabilities,
    ProviderSendOptions,
    SpeechGenOptions,
    SpeechGenResult,
    StreamCallbacks,
    ToolDef,
    ToolCallInfo,
    VideoGenJob,
    VideoGenOptions,
} from '@/lib/ai/agents/types'
import type { ContextUsageSnapshot } from '@/lib/types'
import { executeTool } from '@/lib/ai/tools/executor'
import { getToolsForBuiltins } from '@/lib/ai/tools/registry'
import { latestUserMessageWithPortableHistory } from './history'

const MAX_TOOL_ROUNDS = 25
const FILES_API_POLL_INTERVAL_MS = 1000
const FILES_API_TIMEOUT_MS = 120000
const DEFAULT_TTS_VOICE = 'Kore'
const DEFAULT_SECONDARY_TTS_VOICE = 'Puck'
const TTS_VOICE_NAMES = [
    'Zephyr',
    'Puck',
    'Charon',
    'Kore',
    'Fenrir',
    'Leda',
    'Orus',
    'Aoede',
    'Callirrhoe',
    'Autonoe',
    'Enceladus',
    'Iapetus',
    'Umbriel',
    'Algieba',
    'Despina',
    'Erinome',
    'Algenib',
    'Rasalgethi',
    'Laomedeia',
    'Achernar',
    'Alnilam',
    'Schedar',
    'Gacrux',
    'Pulcherrima',
    'Achird',
    'Zubenelgenubi',
    'Vindemiatrix',
    'Sadachbia',
    'Sadaltager',
    'Sulafat',
]

/** Beyond this age, Gemini stops accepting previous_interaction_id — must restart stateless. */
const INTERACTION_MAX_AGE_MS = 50 * 24 * 60 * 60 * 1000

/**
 * Files API entries TTL ~48h. Refresh the file context (re-send full history)
 * a bit before that so attachments don't 404 mid-stream.
 */
const FILE_CONTEXT_REFRESH_MAX_AGE_MS = 47 * 60 * 60 * 1000

type MessageAttachment = NonNullable<ProviderSendOptions['messages'][number]['attachments']>[number]
type GeminiStreamEvent = Record<string, unknown>
type PendingGeminiToolCall = ToolCallInfo & { parseError?: string }

interface StreamingFunctionCallState {
    id: string
    name: string
    arguments: Record<string, unknown>
    argumentChunks: string[]
    emitted: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readThinkingDelta(delta: any): string {
    if (!delta) return ''

    if (delta.type === 'thought' && typeof delta.thought === 'string') {
        return delta.thought
    }

    if (delta.type === 'thought_summary') {
        if (typeof delta.summary === 'string') return delta.summary
        if (typeof delta.content?.text === 'string') return delta.content.text
        if (typeof delta.text === 'string') return delta.text
    }

    // Some SDK versions emit direct text fields for thought blocks.
    if (typeof delta.thought === 'string') return delta.thought
    if (typeof delta.summary === 'string') return delta.summary
    return ''
}

function eventTypeOf(event: GeminiStreamEvent): string {
    return stringValue(event.event_type) ?? stringValue(event.eventType) ?? stringValue(event.type) ?? ''
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function interactionIdFromEvent(event: GeminiStreamEvent): string | null {
    const interaction = objectValue(event.interaction)
    return stringValue(interaction?.id) ?? stringValue(event.interaction_id) ?? stringValue(event.id) ?? null
}

function usageFromEvent(event: GeminiStreamEvent): unknown {
    const interaction = objectValue(event.interaction)
    const metadata = objectValue(event.metadata)
    return interaction?.usage ?? metadata?.usage ?? event.usage
}

function objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function contentTexts(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
        const record = objectValue(item)
        if (!record) continue
        const text = stringValue(record.text)
        if (text) out.push(text)
    }
    return out
}

function readThinkingStep(step: GeminiStreamEvent): string {
    const summary = step.summary
    if (typeof summary === 'string') return summary
    const text = contentTexts(summary).join('')
    return text
}

function parseFunctionArguments(raw: string): { arguments: Record<string, unknown>; error?: string } {
    const text = raw.trim()
    if (!text) return { arguments: {} }
    try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { arguments: parsed as Record<string, unknown> }
        }
        return { arguments: {}, error: `Function call arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}` }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { arguments: {}, error: `Invalid streamed function call arguments: ${message}` }
    }
}

function normalizeArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
    }
    if (typeof value === 'string') {
        return parseFunctionArguments(value).arguments
    }
    return {}
}

function serverToolName(type: string): string | null {
    if (type.startsWith('google_search_')) return 'web_search'
    if (type.startsWith('url_context_')) return 'url_context'
    if (type.startsWith('code_execution_')) return 'code_execution'
    if (type.startsWith('file_search_')) return 'file_search'
    return null
}

function toContentType(mimeType: string): 'audio' | 'image' | 'video' | 'document' {
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('video/')) return 'video'
    return 'document'
}

// Raw Gemini `Usage` total fields (snake_case wire shape). Summed across rounds
// by accumulateGeminiUsage. See lib/observability/usage-mapper.ts → mapGemini.
const GEMINI_USAGE_TOTAL_KEYS = [
    'total_input_tokens',
    'total_output_tokens',
    'total_thought_tokens',
    'total_cached_tokens',
    'total_tool_use_tokens',
    'total_tokens',
] as const

const GEMINI_USAGE_MODALITY_KEYS = [
    'input_tokens_by_modality',
    'output_tokens_by_modality',
    'cached_tokens_by_modality',
    'tool_use_tokens_by_modality',
] as const

/**
 * Sum two raw Gemini `Usage` payloads. The Interactions API bills each agentic
 * round as its own request and reports per-interaction (marginal) usage, not a
 * running total for the `previous_interaction_id` chain. The tool loop fires one
 * interaction per round, so the run total is the sum of every round's usage —
 * keeping only the last interaction undercounts multi-round runs (and makes
 * Gemini look ~10x cheaper than the equivalent cumulative Claude Code run).
 */
function accumulateGeminiUsage(acc: unknown, next: unknown): unknown {
    if (!next || typeof next !== 'object') return acc
    if (!acc || typeof acc !== 'object') return next
    const a = acc as Record<string, unknown>
    const b = next as Record<string, unknown>
    const out: Record<string, unknown> = { ...a }
    for (const key of GEMINI_USAGE_TOTAL_KEYS) {
        if (a[key] === undefined && b[key] === undefined) continue
        out[key] = geminiUsageNumber(a[key]) + geminiUsageNumber(b[key])
    }
    for (const key of GEMINI_USAGE_MODALITY_KEYS) {
        const merged = mergeGeminiModality(a[key], b[key])
        if (merged) out[key] = merged
    }
    return out
}

function geminiUsageNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function geminiUsageNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function geminiContextUsageSnapshot(args: {
    usage: unknown
    provider: string
    model: string
    interactionId?: string | null
}): ContextUsageSnapshot | null {
    const raw = objectValue(args.usage)
    if (!raw) return null
    const inputTokens = geminiUsageNumberOrNull(raw.total_input_tokens)
    const outputTokens = geminiUsageNumberOrNull(raw.total_output_tokens)
    const thinkingTokens = geminiUsageNumberOrNull(raw.total_thought_tokens)
    const cachedTokens = geminiUsageNumberOrNull(raw.total_cached_tokens)
    const totalTokens = geminiUsageNumberOrNull(raw.total_tokens)
    if (
        inputTokens === null &&
        outputTokens === null &&
        thinkingTokens === null &&
        cachedTokens === null &&
        totalTokens === null
    ) {
        return null
    }

    return {
        provider: args.provider,
        model: args.model,
        source: 'provider-live',
        accuracy: 'actual',
        updatedAt: Date.now(),
        interactionId: args.interactionId ?? undefined,
        contextTokens: inputTokens,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cachedTokens,
        totalTokens,
    }
}

function mergeGeminiModality(a: unknown, b: unknown): Array<{ modality: string; tokens: number }> | null {
    const byModality = new Map<string, number>()
    for (const entry of [...toModalityArray(a), ...toModalityArray(b)]) {
        const modality = typeof entry?.modality === 'string' ? entry.modality : ''
        if (!modality) continue
        byModality.set(modality, (byModality.get(modality) ?? 0) + geminiUsageNumber(entry?.tokens))
    }
    if (byModality.size === 0) return null
    return [...byModality.entries()].map(([modality, tokens]) => ({ modality, tokens }))
}

function toModalityArray(value: unknown): Array<{ modality?: unknown; tokens?: unknown }> {
    return Array.isArray(value) ? value as Array<{ modality?: unknown; tokens?: unknown }> : []
}

// Hoisted so the registry can read capabilities without ever instantiating a
// real SDK client (which warns on empty keys).
export const GOOGLE_CAPABILITIES: ProviderCapabilities = {
    kinds: ['text', 'image', 'video', 'speech', 'music'],
    // Abstract names — each provider maps these to its native tool spec.
    // For Google, `web_search` becomes Gemini's `google_search` tool.
    nativeBuiltins: ['web_search', 'code_execution', 'url_context', 'file_search'],
    nativeBuiltinsCanMixWithFunctionTools: false,
    statefulMode: true,
    promptCaching: 'auto',
    attachmentMode: 'files-api',
    thinkingSupport: true,
    requiresApiKey: true,
}

export class GoogleProvider implements AIProvider {
    readonly id = 'google'
    readonly name = 'Google'
    readonly capabilities: ProviderCapabilities = GOOGLE_CAPABILITIES
    private client: GoogleGenAI
    private uploadedFileUriCache = new Map<string, string>()

    constructor(apiKey: string) {
        this.client = new GoogleGenAI({ apiKey })
    }

    private async waitForFileActive(fileName: string): Promise<string> {
        const deadline = Date.now() + FILES_API_TIMEOUT_MS

        while (Date.now() < deadline) {
            const file = await this.client.files.get({ name: fileName })
            const state = String(file.state ?? '')

            if (state === 'ACTIVE') {
                if (!file.uri) throw new Error(`Files API returned ACTIVE without URI for ${fileName}`)
                return file.uri
            }

            if (state === 'FAILED') {
                const errMsg = file.error?.message ? `: ${file.error.message}` : ''
                throw new Error(`Files API processing failed for ${fileName}${errMsg}`)
            }

            await new Promise(resolve => setTimeout(resolve, FILES_API_POLL_INTERVAL_MS))
        }

        throw new Error(`Timed out waiting for Files API processing (${fileName})`)
    }

    private async uploadToFilesApi(att: MessageAttachment): Promise<string> {
        const baseMime = att.mimeType.split(';')[0].trim()
        const cacheKey = `${att.filePath}|${baseMime}`
        const cachedUri = this.uploadedFileUriCache.get(cacheKey)
        if (cachedUri) return cachedUri

        const uploaded = await this.client.files.upload({
            file: att.filePath,
            config: { mimeType: baseMime },
        })

        if (uploaded.uri && String(uploaded.state ?? '') === 'ACTIVE') {
            this.uploadedFileUriCache.set(cacheKey, uploaded.uri)
            return uploaded.uri
        }

        if (!uploaded.name) {
            throw new Error(`Files API upload did not return a file name for polling (mime: ${baseMime})`)
        }

        const uri = await this.waitForFileActive(uploaded.name)
        this.uploadedFileUriCache.set(cacheKey, uri)
        return uri
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async buildMessageContent(msg: ProviderSendOptions['messages'][number]): Promise<any> {
        if (!msg.attachments?.length) return msg.content || ' '

        const parts: Array<
            { type: 'audio' | 'image' | 'video' | 'document'; uri: string; mime_type: string }
            | { type: 'text'; text: string }
        > = await Promise.all(msg.attachments.map(async att => {
            const baseMime = att.mimeType.split(';')[0].trim()
            return {
                type: toContentType(baseMime),
                uri: await this.uploadToFilesApi(att),
                mime_type: baseMime,
            }
        }))

        if (msg.content?.trim()) {
            parts.push({ type: 'text', text: msg.content })
        }

        return parts
    }

    /**
     * Convert our ToolDef[] into Gemini's tool format for the Interactions API.
     * Interactions API uses: tools: [{ type: 'function', name, description, parameters }]
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private buildTools(tools: ToolDef[]): any[] {
        // Gemini Interactions API uses `parameters` on the wire — we map our
        // Anthropic-native `input_schema` field across.
        return tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        }))
    }

    /**
     * Decide whether to resume the prior interaction or start stateless.
     * Stateful saves a lot of input tokens but breaks if:
     *   - The prior interaction is too old (> 50 days, Gemini's hard cap)
     *   - The conversation has attachments and the Files API uploads have
     *     aged out (~48h TTL, we refresh at 47h so we don't race expiry)
     */
    private canResumeSession(prevSession: ProviderSendOptions['prevSession'], hasAttachments: boolean): boolean {
        if (!prevSession) return false
        const age = Date.now() - prevSession.at
        if (age >= INTERACTION_MAX_AGE_MS) return false
        if (hasAttachments && age >= FILE_CONTEXT_REFRESH_MAX_AGE_MS) return false
        return true
    }

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const hasAttachments = options.messages.some(m => (m.attachments?.length ?? 0) > 0)
        const useStateful = this.canResumeSession(options.prevSession, hasAttachments)
        const resumeFromId = useStateful && options.prevSession ? options.prevSession.id : null

        // Build input for Interactions API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let input: any
        if (resumeFromId) {
            // Stateful: only the latest user message
            const lastUser = [...options.messages].reverse().find(m => m.role === 'user')
            if (lastUser) {
                input = await this.buildMessageContent(lastUser)
            } else {
                input = ''
            }
        } else {
            const portableUserMessage = latestUserMessageWithPortableHistory(options.messages, false)
            if (portableUserMessage) {
                input = await this.buildMessageContent(portableUserMessage)
            } else {
                input = ''
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
            model: options.model,
            stream: true as const,
            store: true as const,
            input,
            generation_config: {
                thinking_level: options.thinkingLevel || 'high',
                thinking_summaries: 'auto',
            },
        }

        if (options.systemPrompt) {
            params.system_instruction = options.systemPrompt
        }

        if (resumeFromId) {
            params.previous_interaction_id = resumeFromId
        }

        const runtimeTools = dedupeTools([
            ...(options.tools ?? []),
            ...getToolsForBuiltins(options.builtins),
        ])

        let nativeTools = this.buildNativeTools(options.builtins)

        // Gemini Interactions currently rejects requests that combine
        // google_search/code_execution/etc. with function calling. Keep the
        // function surface so agents can still notify, update task state, and
        // delegate a separate research pass when they need web context.
        if (runtimeTools.length > 0 && nativeTools.length > 0) {
            nativeTools = []
        }

        // Add tools if provided
        if (runtimeTools.length || nativeTools.length) {
            params.tools = [
                ...this.buildTools(runtimeTools),
                ...nativeTools,
            ]
        }

        let activeThinkingStartTime: number | null = null
        let totalThinkingMs = 0
        let sawThinking = false
        let thinkingDoneSent = false
        let hasContent = false
        let interactionId: string | null = null
        // Raw Gemini Usage shape — see node_modules/@google/genai/dist/genai.d.ts.
        // Consumers should normalize via lib/observability/usage-mapper.ts.
        let usage: unknown

        const startThinking = () => {
            if (activeThinkingStartTime === null) {
                activeThinkingStartTime = Date.now()
            }
            sawThinking = true
        }

        const stopThinking = () => {
            if (activeThinkingStartTime === null) return
            totalThinkingMs += Date.now() - activeThinkingStartTime
            activeThinkingStartTime = null
        }

        const emitThinkingDone = () => {
            stopThinking()
            if (!sawThinking || thinkingDoneSent) return
            cb.onThinkingDone(Math.max(1, Math.round(totalThinkingMs / 1000)))
            thinkingDoneSent = true
        }

        const emitModelText = (text: unknown) => {
            const value = stringValue(text)
            if (!value) return
            if (!hasContent) emitThinkingDone()
            hasContent = true
            cb.onContent(value)
        }

        const abortStream = () => {
            emitThinkingDone()
            cb.onError('Aborted')
        }

        // Tool call loop — model may request tools multiple times
        let round = 0
        while (round < MAX_TOOL_ROUNDS) {
            if (options.signal?.aborted) {
                abortStream()
                return
            }

            round++
            const pendingToolCalls: PendingGeminiToolCall[] = []
            const streamingFunctionCalls = new Map<number, StreamingFunctionCallState>()
            const emittedServerToolCalls = new Set<string>()
            const emittedServerToolResults = new Set<string>()

            const emitServerToolStep = (step: GeminiStreamEvent, index: number) => {
                const stepType = stringValue(step.type)
                if (!stepType) return
                const toolName = serverToolName(stepType)
                if (!toolName) return

                emitThinkingDone()

                if (stepType.endsWith('_call')) {
                    const id = stringValue(step.id) ?? `${stepType}_${round}_${index}`
                    const key = `${stepType}:${id}`
                    if (emittedServerToolCalls.has(key)) return
                    emittedServerToolCalls.add(key)
                    cb.onToolCall({
                        id,
                        name: toolName,
                        arguments: normalizeArguments(step.arguments),
                    })
                    return
                }

                if (stepType.endsWith('_result')) {
                    const callId = stringValue(step.call_id) ?? `${stepType}_${round}_${index}`
                    const key = `${stepType}:${callId}`
                    if (emittedServerToolResults.has(key)) return
                    emittedServerToolResults.add(key)
                    cb.onToolResult(callId, toolName, {
                        success: !step.is_error,
                        data: {
                            provider: 'google',
                            type: stepType,
                            results: step.result ?? [],
                        },
                        error: step.is_error ? `Google ${toolName} failed` : undefined,
                    })
                }
            }

            const startFunctionCall = (step: GeminiStreamEvent, index: number) => {
                const name = stringValue(step.name)
                if (!name) return
                streamingFunctionCalls.set(index, {
                    id: stringValue(step.id) ?? `call_${round}_${index}`,
                    name,
                    arguments: normalizeArguments(step.arguments),
                    argumentChunks: [],
                    emitted: false,
                })
            }

            const appendFunctionArguments = (index: number, delta: GeminiStreamEvent) => {
                let state = streamingFunctionCalls.get(index)
                if (!state) {
                    state = {
                        id: `call_${round}_${index}`,
                        name: '',
                        arguments: {},
                        argumentChunks: [],
                        emitted: false,
                    }
                    streamingFunctionCalls.set(index, state)
                }
                const chunk = stringValue(delta.arguments)
                if (chunk) state.argumentChunks.push(chunk)
            }

            const flushFunctionCall = (index: number) => {
                const state = streamingFunctionCalls.get(index)
                if (!state || state.emitted) return

                let args = state.arguments
                let parseError: string | undefined
                const rawArgs = state.argumentChunks.join('')
                if (rawArgs.trim()) {
                    const parsed = parseFunctionArguments(rawArgs)
                    args = parsed.arguments
                    parseError = parsed.error
                }
                if (!state.name) {
                    parseError = parseError
                        ? `${parseError}; missing function tool name`
                        : 'Missing function tool name in streamed function_call step'
                }

                const toolCall: PendingGeminiToolCall = {
                    id: state.id,
                    name: state.name || 'unknown',
                    arguments: args,
                }
                if (parseError) toolCall.parseError = parseError
                emitThinkingDone()
                pendingToolCalls.push(toolCall)
                cb.onToolCall(toolCall)
                state.emitted = true
            }

            const streamResult = await this.client.interactions.create(
                params,
                { signal: options.signal }
            ) as unknown as AsyncIterable<Record<string, unknown>>

            for await (const chunk of streamResult) {
                if (options.signal?.aborted) break

                const event = chunk as GeminiStreamEvent
                const eventType = eventTypeOf(event)
                const currentInteractionId = interactionIdFromEvent(event)
                if (currentInteractionId) interactionId = currentInteractionId

                if (eventType === 'content.start') {
                    const content = objectValue(event.content)
                    if (content?.type === 'thought') {
                        startThinking()
                    }
                }

                if (eventType === 'step.start') {
                    const step = objectValue(event.step) ?? objectValue(event.content)
                    if (!step) continue
                    const stepType = stringValue(step.type)

                    if (stepType === 'thought') {
                        startThinking()
                        const text = readThinkingStep(step)
                        if (text) cb.onThinking(text)
                    } else if (stepType === 'model_output') {
                        for (const text of contentTexts(step.content)) {
                            emitModelText(text)
                        }
                    } else if (stepType === 'function_call') {
                        startFunctionCall(step, Number(event.index) || 0)
                    } else {
                        emitServerToolStep(step, Number(event.index) || 0)
                    }
                }

                if (eventType === 'content.delta' || eventType === 'step.delta') {
                    const delta = objectValue(event.delta)
                    if (!delta) continue
                    const deltaType = stringValue(delta.type)

                    if (deltaType === 'thought' || deltaType === 'thought_summary') {
                        startThinking()
                        const text = readThinkingDelta(delta)
                        if (text) cb.onThinking(text)
                    }

                    if (deltaType === 'text') {
                        emitModelText(delta.text)
                    }

                    if (deltaType === 'function_call') {
                        emitThinkingDone()
                        const parsedArgs = typeof delta.arguments === 'string'
                            ? parseFunctionArguments(delta.arguments)
                            : { arguments: normalizeArguments(delta.arguments) }
                        const toolCall: PendingGeminiToolCall = {
                            id: stringValue(delta.id) ?? `call_${round}_${pendingToolCalls.length}`,
                            name: stringValue(delta.name) ?? 'unknown',
                            arguments: parsedArgs.arguments,
                        }
                        if (parsedArgs.error) toolCall.parseError = parsedArgs.error
                        pendingToolCalls.push(toolCall)
                        cb.onToolCall(toolCall)
                    }

                    if (deltaType === 'arguments_delta') {
                        appendFunctionArguments(Number(event.index) || 0, delta)
                    }

                    if (deltaType) {
                        emitServerToolStep(delta, Number(event.index) || 0)
                    }
                }

                if (eventType === 'step.stop') {
                    flushFunctionCall(Number(event.index) || 0)
                }

                if (eventType === 'interaction.complete' || eventType === 'interaction.completed') {
                    const interactionUsage = usageFromEvent(event)
                    usage = accumulateGeminiUsage(usage, interactionUsage)
                    const snapshot = geminiContextUsageSnapshot({
                        usage: interactionUsage,
                        provider: 'google',
                        model: options.model,
                        interactionId: currentInteractionId ?? interactionId,
                    })
                    if (snapshot) cb.onUsage?.(snapshot)
                }

                if (eventType === 'error') {
                    const error = objectValue(event.error)
                    cb.onError(stringValue(error?.message) ?? 'Unknown API error')
                    return
                }
            }

            for (const index of streamingFunctionCalls.keys()) {
                flushFunctionCall(index)
            }

            if (options.signal?.aborted) {
                abortStream()
                return
            }

            // If no tool calls were made, we're done — model gave a final response
            if (pendingToolCalls.length === 0) {
                break
            }

            // Execute tool calls and send results back
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const functionResults: any[] = []

            for (const tc of pendingToolCalls) {
                if (options.signal?.aborted) {
                    abortStream()
                    return
                }

                if (tc.parseError) {
                    const result = { success: false, error: tc.parseError }
                    cb.onToolResult(tc.id, tc.name, result)
                    functionResults.push({
                        type: 'function_result',
                        name: tc.name,
                        call_id: tc.id,
                        result: JSON.stringify(result),
                        is_error: true,
                    })
                    continue
                }

                const toolDef = runtimeTools.find(t => t.name === tc.name || t.id === tc.name)
                if (!toolDef) {
                    const result = { success: false, error: `Unknown tool: ${tc.name}` }
                    cb.onToolResult(tc.id, tc.name, result)
                    functionResults.push({
                        type: 'function_result',
                        name: tc.name,
                        call_id: tc.id,
                        result: JSON.stringify(result),
                        is_error: true,
                    })
                    continue
                }

                const result = await executeTool(toolDef, tc.arguments, options.toolContext
                    ? { ...options.toolContext, currentToolCallId: tc.id }
                    : undefined)
                if (options.signal?.aborted) {
                    abortStream()
                    return
                }
                cb.onToolResult(tc.id, tc.name, result)

                functionResults.push({
                    type: 'function_result',
                    name: tc.name,
                    call_id: tc.id,
                    result: JSON.stringify(result),
                    is_error: !result.success,
                })
            }

            // Send tool results back to the model using previous_interaction_id
            params.previous_interaction_id = interactionId
            params.input = functionResults
        }

        if (options.signal?.aborted) {
            abortStream()
            return
        }

        // Final done
        emitThinkingDone()
        stopThinking()
        const totalThinkingSeconds = sawThinking ? Math.max(1, Math.round(totalThinkingMs / 1000)) : undefined
        if (!thinkingDoneSent && typeof totalThinkingSeconds === 'number') {
            cb.onThinkingDone(totalThinkingSeconds)
        }

        cb.onDone({
            sessionId: interactionId ?? undefined,
            usage,
            thinkingDuration: totalThinkingSeconds,
        })
    }

    private buildNativeTools(builtins: ProviderSendOptions['builtins']): Array<Record<string, unknown>> {
        const tools: Array<Record<string, unknown>> = []
        if (builtins?.includes('web_search')) tools.push({ type: 'google_search' })
        if (builtins?.includes('url_context')) tools.push({ type: 'url_context' })
        if (builtins?.includes('code_execution')) tools.push({ type: 'code_execution' })
        if (builtins?.includes('file_search')) tools.push({ type: 'file_search' })
        return tools
    }

    async generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
        const contents = buildGeminiImageContents(options.prompt, options.referenceImages)
        const webSearchMode = options.modelOptions?.web_search
        const enableSearch = webSearchMode === 'on' || webSearchMode === true
            ? true
            : webSearchMode === 'off' || webSearchMode === false
                ? false
                : wantsSearchGrounding(options.prompt)
        const response = await this.client.models.generateContent({
            model: options.model,
            contents,
            config: {
                responseModalities: ['TEXT', 'IMAGE'],
                responseFormat: {
                    image: {
                        aspectRatio: options.aspectRatio,
                        imageSize: '1K',
                    },
                },
                tools: enableSearch
                    ? [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }]
                    : undefined,
            },
        } as never)

        const responseRecord = response as unknown as Record<string, unknown>
        const responseParts = (responseRecord.parts as Array<Record<string, unknown>> | undefined) ?? []
        const parts = response.candidates?.[0]?.content?.parts ?? responseParts
        const images: ImageGenResult['images'] = []
        let text = ''
        for (const part of parts as Array<Record<string, unknown>>) {
            if (part.thought) continue
            if (typeof part.text === 'string') {
                text += part.text
                continue
            }
            const inlineData = part.inlineData as { data?: string; mimeType?: string } | undefined
            if (!inlineData?.data) continue
            images.push({
                mimeType: inlineData.mimeType ?? 'image/png',
                data: Buffer.from(inlineData.data, 'base64'),
                revisedPrompt: text.trim() || undefined,
            })
        }
        if (images.length === 0) throw new Error('Google image generation returned no image data')
        return {
            images,
            sources: extractGroundingSources(response as unknown as Record<string, unknown>),
            usage: response.usageMetadata,
        }
    }

    async generateVideo(options: VideoGenOptions): Promise<VideoGenJob> {
        const operation = await this.client.models.generateVideos({
            model: options.model,
            prompt: options.prompt,
            image: options.referenceImage
                ? {
                    imageBytes: options.referenceImage.data.toString('base64'),
                    mimeType: options.referenceImage.mimeType,
                }
                : undefined,
            config: {
                aspectRatio: options.aspectRatio,
                durationSeconds: options.durationSeconds,
            },
        } as never)

        return videoJobFromOperation(operation as unknown as Record<string, unknown>)
    }

    async pollVideoJob(jobId: string): Promise<VideoGenJob> {
        const operation = await this.client.operations.getVideosOperation({
            operation: { name: jobId },
        } as never)
        const job = videoJobFromOperation(operation as unknown as Record<string, unknown>)
        if (job.status !== 'done') return job

        const video = firstGeneratedVideo(operation as unknown as Record<string, unknown>)
        const downloaded = await downloadGoogleVideo(this.client, video)
        if (downloaded) job.video = downloaded
        return job
    }

    async generateSpeech(options: SpeechGenOptions): Promise<SpeechGenResult> {
        const response = await this.client.models.generateContent({
            model: options.model,
            contents: options.text,
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: buildGoogleSpeechConfig(options),
            },
        } as never)

        const inline = firstInlineData(response as unknown as Record<string, unknown>)
        if (!inline?.data) throw new Error('Google TTS returned no audio data')
        const mimeType = inline.mimeType ?? 'audio/wav'
        const raw = Buffer.from(inline.data, 'base64')
        const data = mimeType === 'audio/wav' || mimeType === 'audio/wave'
            ? raw
            : pcmToWav(raw)
        return { mimeType: 'audio/wav', data, usage: response.usageMetadata }
    }

    async generateMusic(options: MusicGenOptions): Promise<MusicGenResult> {
        const contents = buildGeminiImageContents(options.prompt, options.referenceImages)
        const response = await this.client.models.generateContent({
            model: options.model,
            contents,
            config: {
                responseModalities: ['AUDIO', 'TEXT'],
                responseFormat: options.format === 'wav'
                    ? { audio: { mimeType: 'audio/wav' } }
                    : undefined,
            },
        } as never)

        const responseRecord = response as unknown as Record<string, unknown>
        const responseParts = (responseRecord.parts as Array<Record<string, unknown>> | undefined) ?? []
        const parts = response.candidates?.[0]?.content?.parts ?? responseParts
        let text = ''
        let audio: { mimeType: string; data: Buffer } | null = null
        for (const part of parts as Array<Record<string, unknown>>) {
            if (typeof part.text === 'string') text += part.text
            const inlineData = part.inlineData as { data?: string; mimeType?: string } | undefined
            if (inlineData?.data && inlineData.mimeType?.startsWith('audio/')) {
                audio = {
                    mimeType: inlineData.mimeType,
                    data: Buffer.from(inlineData.data, 'base64'),
                }
            }
        }
        if (!audio) throw new Error('Google Lyria returned no audio data')
        return {
            mimeType: audio.mimeType,
            data: audio.data,
            text: text.trim() || undefined,
            usage: response.usageMetadata,
        }
    }
}

function buildGoogleSpeechConfig(options: SpeechGenOptions): Record<string, unknown> {
    const preferredVoice =
        normalizeTtsVoice(options.voice) ??
        modelOptionVoice(options.modelOptions, 'voice_name') ??
        DEFAULT_TTS_VOICE
    const speakerLabels = inferSpeakerLabels(options.text)

    if (speakerLabels.length >= 2) {
        const [firstSpeaker, secondSpeaker] = speakerLabels
        const firstVoice =
            findSpeakerVoice(options.text, firstSpeaker) ??
            modelOptionVoice(options.modelOptions, 'speaker_1_voice') ??
            preferredVoice
        const secondVoice =
            findSpeakerVoice(options.text, secondSpeaker) ??
            modelOptionVoice(options.modelOptions, 'speaker_2_voice') ??
            differentDefaultVoice(firstVoice)

        return {
            multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: [
                    speakerVoiceConfig(firstSpeaker, firstVoice),
                    speakerVoiceConfig(secondSpeaker, secondVoice),
                ],
            },
        }
    }

    return {
        voiceConfig: {
            prebuiltVoiceConfig: {
                voiceName: preferredVoice,
            },
        },
    }
}

function speakerVoiceConfig(speaker: string, voiceName: string): Record<string, unknown> {
    return {
        speaker,
        voiceConfig: {
            prebuiltVoiceConfig: {
                voiceName,
            },
        },
    }
}

function modelOptionVoice(
    options: Record<string, boolean | string | number> | undefined,
    key: string
): string | undefined {
    const value = options?.[key]
    return typeof value === 'string' ? normalizeTtsVoice(value) : undefined
}

function normalizeTtsVoice(value: string | undefined): string | undefined {
    const normalized = value?.trim()
    if (!normalized) return undefined
    return TTS_VOICE_NAMES.find(voice => voice.toLowerCase() === normalized.toLowerCase())
}

function differentDefaultVoice(firstVoice: string): string {
    return firstVoice === DEFAULT_SECONDARY_TTS_VOICE ? DEFAULT_TTS_VOICE : DEFAULT_SECONDARY_TTS_VOICE
}

function inferSpeakerLabels(text: string): string[] {
    const transcript = transcriptSection(text)
    const labels: string[] = []
    const seen = new Set<string>()
    const re = /^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9 ._-]{0,39})\s*:\s+\S/gm
    let match: RegExpExecArray | null

    while ((match = re.exec(transcript)) !== null) {
        const label = normalizeSpeakerLabel(match[1])
        const key = label.toLowerCase()
        if (!label || isIgnoredSpeakerLabel(key) || seen.has(key)) continue
        seen.add(key)
        labels.push(label)
        if (labels.length === 2) break
    }

    return labels
}

function transcriptSection(text: string): string {
    const match = text.match(/(?:^|\n)#{1,6}\s*transcript\s*\n([\s\S]*)/i)
    return match?.[1] ?? text
}

function normalizeSpeakerLabel(label: string): string {
    return label.replace(/\s+/g, ' ').trim()
}

function isIgnoredSpeakerLabel(label: string): boolean {
    return [
        'audio profile',
        'director',
        'director notes',
        'emotion',
        'instruction',
        'instructions',
        'language',
        'mood',
        'note',
        'notes',
        'pace',
        'profile',
        'scene',
        'speed',
        'style',
        'text',
        'tone',
        'transcript',
        'voice',
        'voice name',
        'voices',
    ].includes(label)
}

function findSpeakerVoice(text: string, speaker: string): string | undefined {
    const voicePattern = TTS_VOICE_NAMES.map(escapeRegExp).join('|')
    const escapedSpeaker = escapeRegExp(speaker)
    const patterns = [
        new RegExp(`\\b${escapedSpeaker}\\b[^\\n]{0,80}\\bvoice\\s*[:=]\\s*(${voicePattern})\\b`, 'i'),
        new RegExp(`\\b${escapedSpeaker}\\b\\s*\\((?:voice\\s*)?(${voicePattern})\\)`, 'i'),
        new RegExp(`\\b${escapedSpeaker}\\b\\s*[-=]\\s*(${voicePattern})\\b`, 'i'),
    ]

    for (const pattern of patterns) {
        const match = text.match(pattern)
        const voice = normalizeTtsVoice(match?.[1])
        if (voice) return voice
    }

    return undefined
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dedupeTools(tools: ToolDef[]): ToolDef[] {
    const seen = new Set<string>()
    const out: ToolDef[] = []
    for (const tool of tools) {
        if (seen.has(tool.name)) continue
        seen.add(tool.name)
        out.push(tool)
    }
    return out
}

function buildGeminiImageContents(
    prompt: string,
    images?: Array<{ mimeType: string; data: Buffer }>
): unknown[] | string {
    if (!images?.length) return prompt
    return [
        { text: prompt },
        ...images.map(image => ({
            inlineData: {
                mimeType: image.mimeType,
                data: image.data.toString('base64'),
            },
        })),
    ]
}

function wantsSearchGrounding(prompt: string): boolean {
    return /\b(use|with|via)\s+(google\s+)?(image\s+)?search\b|\bcurrent\b|\brecent\b|\btoday\b|\bweather\b|\bforecast\b|\blast night\b/i.test(prompt)
}

function extractGroundingSources(response: Record<string, unknown>): Array<{ uri: string; title?: string }> | undefined {
    const candidates = response.candidates as Array<Record<string, unknown>> | undefined
    const metadata = candidates?.[0]?.groundingMetadata as { groundingChunks?: Array<Record<string, unknown>> } | undefined
    const chunks = metadata?.groundingChunks ?? []
    const sources: Array<{ uri: string; title?: string }> = []
    for (const chunk of chunks) {
        const web = chunk.web as { uri?: string; title?: string } | undefined
        const image = chunk.image as { uri?: string; title?: string } | undefined
        const source = image ?? web
        if (source?.uri) sources.push({ uri: source.uri, title: source.title })
    }
    return sources.length > 0 ? sources : undefined
}

function firstInlineData(response: Record<string, unknown>): { data?: string; mimeType?: string } | null {
    const candidates = response.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined
    const parts = candidates?.[0]?.content?.parts ?? response.parts as Array<Record<string, unknown>> | undefined ?? []
    for (const part of parts) {
        const inlineData = part.inlineData as { data?: string; mimeType?: string } | undefined
        if (inlineData?.data) return inlineData
    }
    return null
}

function videoJobFromOperation(operation: Record<string, unknown>): VideoGenJob {
    const name = typeof operation.name === 'string' ? operation.name : ''
    const done = Boolean(operation.done)
    const error = operation.error as { message?: string } | undefined
    if (error?.message) {
        return { id: name, status: 'failed', error: error.message }
    }
    if (!done) return { id: name, status: 'running' }
    return {
        id: name,
        status: 'done',
        usage: (operation.response as Record<string, unknown> | undefined)?.usageMetadata,
    }
}

function firstGeneratedVideo(operation: Record<string, unknown>): Record<string, unknown> | null {
    const response = operation.response as Record<string, unknown> | undefined
    const generatedVideos = response?.generatedVideos as Array<Record<string, unknown>> | undefined
    const generatedSamples = (response as { generateVideoResponse?: { generatedSamples?: Array<Record<string, unknown>> } } | undefined)
        ?.generateVideoResponse?.generatedSamples
    const item = generatedVideos?.[0] ?? generatedSamples?.[0]
    const video = item?.video as Record<string, unknown> | undefined
    return video ?? null
}

async function downloadGoogleVideo(client: GoogleGenAI, video: Record<string, unknown> | null): Promise<{ mimeType: string; data: Buffer } | null> {
    if (!video) return null
    const mimeType = typeof video.mimeType === 'string' ? video.mimeType : 'video/mp4'
    const videoBytes = video.videoBytes
    if (typeof videoBytes === 'string' && videoBytes.length > 0) {
        return { mimeType, data: Buffer.from(videoBytes, 'base64') }
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-veo-'))
    const downloadPath = path.join(dir, 'video.mp4')
    try {
        await client.files.download({
            file: video,
            downloadPath,
        } as never)
        if (!fs.existsSync(downloadPath)) return null
        return { mimeType, data: fs.readFileSync(downloadPath) }
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
}

function pcmToWav(pcm: Buffer, channels = 1, sampleRate = 24000, bitsPerSample = 16): Buffer {
    const header = Buffer.alloc(44)
    const byteRate = sampleRate * channels * bitsPerSample / 8
    const blockAlign = channels * bitsPerSample / 8

    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
}
