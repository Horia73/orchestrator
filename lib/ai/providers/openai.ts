import type {
    AIProvider,
    ImageGenOptions,
    ImageGenResult,
    ProviderCapabilities,
    ProviderSendOptions,
    StreamCallbacks,
    ToolDef,
    ToolResult,
} from '@/lib/ai/agents/types'
import { executeTool } from '@/lib/ai/tools/executor'
import { getToolsForBuiltins } from '@/lib/ai/tools/registry'
import { readSse } from './sse'

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations'
const OPENAI_IMAGES_EDITS_URL = 'https://api.openai.com/v1/images/edits'
const MAX_TOOL_ROUNDS = 25

interface AnyObj { [key: string]: unknown }

interface OpenAIToolCall {
    id: string
    callId: string
    name: string
    arguments: Record<string, unknown>
}

export class OpenAIProvider implements AIProvider {
    readonly id = 'openai'
    readonly name = 'OpenAI'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text', 'image'],
        nativeBuiltins: ['web_search'],
        statefulMode: true,
        promptCaching: 'auto',
        attachmentMode: 'file-id-or-url',
        thinkingSupport: true,
        requiresApiKey: true,
    }

    constructor(private apiKey: string) {}

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const runtimeTools = dedupeTools([
            ...(options.tools ?? []),
            ...getToolsForBuiltins(options.builtins),
        ])

        let previousResponseId = options.prevSession?.id
        let input: unknown = previousResponseId
            ? latestUserInput(options)
            : fullConversationInput(options)
        let finalUsage: unknown
        let finalResponseId: string | undefined = previousResponseId
        let thinkingStartedAt: number | null = null
        let thinkingTotalMs = 0

        const startThinking = () => {
            if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
        }
        const stopThinking = () => {
            if (thinkingStartedAt === null) return
            thinkingTotalMs += Date.now() - thinkingStartedAt
            thinkingStartedAt = null
            cb.onThinkingDone(Math.max(1, Math.round(thinkingTotalMs / 1000)))
        }

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal?.aborted) break

            const body = buildOpenAIRequestBody({
                model: options.model,
                input,
                previousResponseId,
                systemPrompt: options.systemPrompt,
                thinkingLevel: options.thinkingLevel,
                tools: runtimeTools,
                builtins: options.builtins,
            })

            const streamed = await streamOpenAIResponse(this.apiKey, body, {
                signal: options.signal,
                onText(delta) {
                    stopThinking()
                    cb.onContent(delta)
                },
                onThinking(delta) {
                    startThinking()
                    cb.onThinking(delta)
                },
                onError(message) {
                    cb.onError(message)
                },
                onHostedToolCall(toolCall) {
                    cb.onToolCall(toolCall)
                },
                onHostedToolResult(toolCallId, toolName, result) {
                    cb.onToolResult(toolCallId, toolName, result)
                },
            })

            finalUsage = streamed.usage ?? finalUsage
            finalResponseId = streamed.responseId ?? finalResponseId
            previousResponseId = streamed.responseId ?? previousResponseId

            if (streamed.toolCalls.length === 0) {
                stopThinking()
                cb.onDone({
                    sessionId: finalResponseId,
                    usage: finalUsage,
                    thinkingDuration: thinkingTotalMs > 0 ? Math.max(1, Math.round(thinkingTotalMs / 1000)) : undefined,
                })
                return
            }

            const toolOutputs: AnyObj[] = []
            for (const toolCall of streamed.toolCalls) {
                if (options.signal?.aborted) break
                cb.onToolCall({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })
                const tool = runtimeTools.find(t => t.name === toolCall.name || t.id === toolCall.name)
                const result = tool
                    ? await executeTool(tool, toolCall.arguments, options.toolContext
                        ? { ...options.toolContext, currentToolCallId: toolCall.id }
                        : undefined)
                    : { success: false, error: `Unknown tool: ${toolCall.name}` }
                cb.onToolResult(toolCall.id, toolCall.name, result)
                toolOutputs.push({
                    type: 'function_call_output',
                    call_id: toolCall.callId,
                    output: formatToolResult(result),
                })
            }

            input = toolOutputs
        }

        cb.onError(`OpenAI tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`)
    }

    async generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
        if (options.referenceImages?.length) {
            return this.editImage(options)
        }

        const response = await fetch(OPENAI_IMAGES_GENERATIONS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: options.model,
                prompt: options.prompt,
                n: options.n ?? 1,
                size: openAIImageSize(options.aspectRatio),
            }),
            signal: options.signal,
        })
        if (!response.ok) {
            throw new Error(`OpenAI image generation failed (${response.status}): ${await response.text()}`)
        }
        const json = await response.json() as AnyObj
        return parseOpenAIImageResponse(json)
    }

    private async editImage(options: ImageGenOptions): Promise<ImageGenResult> {
        const form = new FormData()
        form.set('model', options.model)
        form.set('prompt', options.prompt)
        form.set('n', String(options.n ?? 1))
        const size = openAIImageSize(options.aspectRatio)
        if (size) form.set('size', size)
        for (const [index, image] of (options.referenceImages ?? []).entries()) {
            const bytes = image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength) as ArrayBuffer
            const blob = new Blob([bytes], { type: image.mimeType })
            form.append('image[]', blob, `reference-${index + 1}${openAIFileExtension(image.mimeType)}`)
        }

        const response = await fetch(OPENAI_IMAGES_EDITS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: form,
            signal: options.signal,
        })
        if (!response.ok) {
            throw new Error(`OpenAI image edit failed (${response.status}): ${await response.text()}`)
        }
        const json = await response.json() as AnyObj
        return parseOpenAIImageResponse(json)
    }
}

function buildOpenAIRequestBody(args: {
    model: string
    input: unknown
    previousResponseId?: string
    systemPrompt?: string
    thinkingLevel?: string
    tools: ToolDef[]
    builtins?: string[]
}): AnyObj {
    const body: AnyObj = {
        model: args.model,
        input: args.input,
        stream: true,
        store: true,
        parallel_tool_calls: true,
    }
    if (args.previousResponseId) body.previous_response_id = args.previousResponseId
    if (args.systemPrompt?.trim()) body.instructions = args.systemPrompt.trim()
    if (args.builtins?.includes('web_search')) {
        body.include = ['web_search_call.action.sources', 'web_search_call.results']
    }
    const tools = [
        ...args.tools.map(openAITool),
        ...openAINativeTools(args.builtins),
    ]
    if (tools.length > 0) body.tools = tools
    const effort = mapOpenAIEffort(args.thinkingLevel)
    if (effort) body.reasoning = { effort }
    return body
}

function openAINativeTools(builtins: string[] | undefined): AnyObj[] {
    if (!builtins?.includes('web_search')) return []
    return [{ type: 'web_search' }]
}

function openAITool(tool: ToolDef): AnyObj {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
    }
}

function fullConversationInput(options: ProviderSendOptions): AnyObj[] {
    return options.messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content || ' ',
    }))
}

function latestUserInput(options: ProviderSendOptions): AnyObj[] {
    const last = [...options.messages].reverse().find(message => message.role === 'user')
    return [{
        role: 'user',
        content: last?.content || ' ',
    }]
}

async function streamOpenAIResponse(
    apiKey: string,
    body: AnyObj,
    callbacks: {
        signal?: AbortSignal
        onText: (delta: string) => void
        onThinking: (delta: string) => void
        onError: (message: string) => void
        onHostedToolCall?: (toolCall: OpenAIToolCall) => void
        onHostedToolResult?: (toolCallId: string, toolName: string, result: ToolResult) => void
    }
): Promise<{ responseId?: string; usage?: unknown; toolCalls: OpenAIToolCall[] }> {
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: callbacks.signal,
    })

    if (!response.ok) {
        throw new Error(`OpenAI API error ${response.status}: ${await response.text()}`)
    }

    let responseId: string | undefined
    let usage: unknown
    const calls = new Map<number, {
        id: string
        callId: string
        name: string
        argumentsJson: string
    }>()
    const hostedCalls = new Map<number, { id: string; name: string; arguments: Record<string, unknown> }>()

    await readSse(response, event => {
        if (event.data === '[DONE]') return
        let data: AnyObj
        try {
            data = JSON.parse(event.data) as AnyObj
        } catch {
            return
        }

        const type = typeof data.type === 'string' ? data.type : event.event
        if (type === 'response.created') {
            const resp = data.response as AnyObj | undefined
            if (typeof resp?.id === 'string') responseId = resp.id
            return
        }
        if (type === 'response.output_text.delta') {
            const delta = typeof data.delta === 'string' ? data.delta : ''
            if (delta) callbacks.onText(delta)
            return
        }
        if (type && type.includes('reasoning') && typeof data.delta === 'string') {
            callbacks.onThinking(data.delta)
            return
        }
        if (type === 'response.output_item.added') {
            const item = data.item as AnyObj | undefined
            const index = typeof data.output_index === 'number' ? data.output_index : calls.size
            if (item?.type === 'web_search_call') {
                const id = typeof item.id === 'string' ? item.id : `openai_web_${index}`
                const args = openAIWebSearchArgs(item)
                hostedCalls.set(index, { id, name: 'web_search', arguments: args })
                callbacks.onHostedToolCall?.({ id, callId: id, name: 'web_search', arguments: args })
                return
            }
            if (item?.type !== 'function_call') return
            calls.set(index, {
                id: typeof item.id === 'string' ? item.id : `openai_tool_${index}`,
                callId: typeof item.call_id === 'string' ? item.call_id : `call_${index}`,
                name: typeof item.name === 'string' ? item.name : '',
                argumentsJson: typeof item.arguments === 'string' ? item.arguments : '',
            })
            return
        }
        if (type === 'response.output_item.done') {
            const item = data.item as AnyObj | undefined
            const index = typeof data.output_index === 'number' ? data.output_index : 0
            if (item?.type !== 'web_search_call') return
            const existing = hostedCalls.get(index)
            const id = typeof item.id === 'string' ? item.id : existing?.id ?? `openai_web_${index}`
            const result = openAIWebSearchResult(item)
            callbacks.onHostedToolResult?.(id, 'web_search', result)
            return
        }
        if (type === 'response.function_call_arguments.delta') {
            const index = typeof data.output_index === 'number' ? data.output_index : 0
            const call = calls.get(index)
            if (call && typeof data.delta === 'string') call.argumentsJson += data.delta
            return
        }
        if (type === 'response.function_call_arguments.done') {
            const index = typeof data.output_index === 'number' ? data.output_index : 0
            const item = data.item as AnyObj | undefined
            const call = calls.get(index)
            if (!call || !item) return
            if (typeof item.id === 'string') call.id = item.id
            if (typeof item.call_id === 'string') call.callId = item.call_id
            if (typeof item.name === 'string') call.name = item.name
            if (typeof item.arguments === 'string') call.argumentsJson = item.arguments
            return
        }
        if (type === 'response.completed') {
            const resp = data.response as AnyObj | undefined
            if (typeof resp?.id === 'string') responseId = resp.id
            usage = resp?.usage ?? usage
            return
        }
        if (type === 'error') {
            const error = data.error as AnyObj | undefined
            callbacks.onError(typeof error?.message === 'string' ? error.message : 'OpenAI streaming error')
        }
    }, callbacks.signal)

    return {
        responseId,
        usage,
        toolCalls: Array.from(calls.values())
            .filter(call => call.name && call.callId)
            .map(call => ({
                id: call.id,
                callId: call.callId,
                name: call.name,
                arguments: parseJsonObject(call.argumentsJson),
            })),
    }
}

function openAIWebSearchArgs(item: AnyObj): Record<string, unknown> {
    const action = item.action && typeof item.action === 'object' ? item.action as AnyObj : {}
    return {
        action: typeof action.type === 'string' ? action.type : 'search',
        queries: Array.isArray(action.queries) ? action.queries : undefined,
    }
}

function openAIWebSearchResult(item: AnyObj): ToolResult {
    const status = typeof item.status === 'string' ? item.status : undefined
    const action = item.action && typeof item.action === 'object' ? item.action as AnyObj : {}
    return {
        success: status !== 'failed',
        data: {
            provider: 'openai',
            type: item.type,
            status,
            action,
            sources: Array.isArray(action.sources) ? action.sources : undefined,
            results: Array.isArray(item.results) ? item.results : undefined,
        },
        error: status === 'failed' ? 'OpenAI web search failed' : undefined,
    }
}

function parseJsonObject(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {}
    } catch {
        return {}
    }
}

function formatToolResult(result: ToolResult): string {
    if (!result.success) return typeof result.error === 'string' ? result.error : 'Tool call failed'
    if (typeof result.data === 'string') return result.data
    try {
        return JSON.stringify(result.data ?? '', null, 2)
    } catch {
        return String(result.data ?? '')
    }
}

function mapOpenAIEffort(level: string | undefined): string | null {
    switch (level) {
        case 'minimal':
        case 'low':
            return 'low'
        case 'medium':
            return 'medium'
        case 'high':
        case 'xhigh':
        case 'max':
            return 'high'
        default:
            return level ?? null
    }
}

function openAIImageSize(aspectRatio: ImageGenOptions['aspectRatio']): string | undefined {
    switch (aspectRatio) {
        case '16:9':
        case '4:3':
            return '1536x1024'
        case '9:16':
        case '3:4':
            return '1024x1536'
        case '1:1':
            return '1024x1024'
        default:
            return 'auto'
    }
}

function openAIFileExtension(mimeType: string): string {
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg'
    if (mimeType.includes('webp')) return '.webp'
    if (mimeType.includes('gif')) return '.gif'
    return '.png'
}

async function parseOpenAIImageResponse(json: AnyObj): Promise<ImageGenResult> {
    const data = Array.isArray(json.data) ? json.data as AnyObj[] : []
    const images: ImageGenResult['images'] = []
    for (const item of data) {
        const b64 = typeof item.b64_json === 'string'
            ? item.b64_json
            : typeof item.b64 === 'string'
                ? item.b64
                : undefined
        const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
        if (b64) {
            images.push({ mimeType: 'image/png', data: Buffer.from(b64, 'base64'), revisedPrompt })
            continue
        }
        const url = typeof item.url === 'string' ? item.url : undefined
        if (url) {
            const fetched = await fetch(url)
            if (!fetched.ok) throw new Error(`OpenAI image URL download failed (${fetched.status})`)
            const mimeType = fetched.headers.get('content-type') ?? 'image/png'
            images.push({ mimeType, data: Buffer.from(await fetched.arrayBuffer()), revisedPrompt })
        }
    }
    if (images.length === 0) throw new Error('OpenAI image generation returned no image data')
    return { images, usage: json.usage }
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
