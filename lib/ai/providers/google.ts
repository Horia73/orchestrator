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
            if (portableUserMessage && options.messages.length > 1) {
                input = await this.buildMessageContent(portableUserMessage)
            } else {
                // Stateless first turn — resolve the message normally (may need Files API upload).
                input = await Promise.all(options.messages.map(async m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    content: await this.buildMessageContent(m),
                })))
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
            const pendingToolCalls: ToolCallInfo[] = []

            const streamResult = await this.client.interactions.create(
                params,
                { signal: options.signal }
            ) as unknown as AsyncIterable<Record<string, unknown>>

            for await (const chunk of streamResult) {
                if (options.signal?.aborted) break

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const event = chunk as any
                const eventType = (event.event_type ?? event.eventType) as string

                if (eventType === 'interaction.start') {
                    interactionId = event.interaction?.id ?? null
                }

                if (eventType === 'content.start') {
                    if (event.content?.type === 'thought') {
                        startThinking()
                    }
                }

                if (eventType === 'content.delta') {
                    const delta = event.delta
                    if (!delta) continue

                    if (delta.type === 'thought' || delta.type === 'thought_summary') {
                        startThinking()
                        const text = readThinkingDelta(delta)
                        if (text) cb.onThinking(text)
                    }

                    if (delta.type === 'text') {
                        if (!hasContent) emitThinkingDone()
                        hasContent = true
                        const text = delta.text ?? ''
                        if (text) cb.onContent(text)
                    }

                    if (delta.type === 'function_call') {
                        emitThinkingDone()
                        // Function call arguments arrive as a complete JSON object
                        const toolCall: ToolCallInfo = {
                            id: delta.id ?? `call_${round}_${pendingToolCalls.length}`,
                            name: delta.name,
                            arguments: delta.arguments ?? {},
                        }
                        pendingToolCalls.push(toolCall)
                        cb.onToolCall(toolCall)
                    }

                    if (delta.type === 'google_search_call') {
                        emitThinkingDone()
                        const id = typeof delta.id === 'string' ? delta.id : `google_search_${round}_${pendingToolCalls.length}`
                        cb.onToolCall({
                            id,
                            name: 'web_search',
                            arguments: delta.arguments ?? {},
                        })
                    }

                    if (delta.type === 'google_search_result') {
                        emitThinkingDone()
                        const callId = typeof delta.call_id === 'string' ? delta.call_id : `google_search_result_${round}`
                        cb.onToolResult(callId, 'web_search', {
                            success: !delta.is_error,
                            data: {
                                provider: 'google',
                                type: delta.type,
                                results: Array.isArray(delta.result) ? delta.result : [],
                            },
                            error: delta.is_error ? 'Google Search grounding failed' : undefined,
                        })
                    }

                    if (delta.type === 'url_context_call') {
                        emitThinkingDone()
                        const id = typeof delta.id === 'string' ? delta.id : `url_context_${round}_${pendingToolCalls.length}`
                        cb.onToolCall({
                            id,
                            name: 'url_context',
                            arguments: delta.arguments ?? {},
                        })
                    }

                    if (delta.type === 'url_context_result') {
                        emitThinkingDone()
                        const callId = typeof delta.call_id === 'string' ? delta.call_id : `url_context_result_${round}`
                        cb.onToolResult(callId, 'url_context', {
                            success: !delta.is_error,
                            data: {
                                provider: 'google',
                                type: delta.type,
                                results: Array.isArray(delta.result) ? delta.result : [],
                            },
                            error: delta.is_error ? 'Google URL Context failed' : undefined,
                        })
                    }
                }

                if (eventType === 'interaction.complete') {
                    if (event.interaction?.id) interactionId = event.interaction.id
                    usage = accumulateGeminiUsage(usage, event.interaction?.usage)
                }

                if (eventType === 'error') {
                    cb.onError(event.error?.message ?? 'Unknown API error')
                    return
                }
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

                const toolDef = runtimeTools.find(t => t.name === tc.name || t.id === tc.name)
                if (!toolDef) {
                    const result = { success: false, error: `Unknown tool: ${tc.name}` }
                    cb.onToolResult(tc.id, tc.name, result)
                    functionResults.push({
                        type: 'function_result',
                        name: tc.name,
                        call_id: tc.id,
                        result: JSON.stringify(result),
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
