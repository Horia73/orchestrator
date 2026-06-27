import type {
    AIProvider,
    ProviderCapabilities,
    ProviderSendOptions,
    StreamCallbacks,
    ToolDef,
    ToolResult,
} from '@/lib/ai/agents/types'
import { executeTool } from '@/lib/ai/tools/executor'
import { getToolsForBuiltins } from '@/lib/ai/tools/registry'
import { readLiveRegistry } from '@/lib/models/store'
import { readSse } from './sse'

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_TOOL_ROUNDS = 25
const OPENROUTER_PROVIDER_ROUTING = { sort: 'price' } as const

interface AnyObj { [key: string]: unknown }

interface OpenRouterToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

interface StreamedOpenRouterResponse {
    assistantText: string
    toolCalls: OpenRouterToolCall[]
    usage?: unknown
    thinkingDuration?: number
}

export class OpenRouterProvider implements AIProvider {
    readonly id = 'openrouter'
    readonly name = 'OpenRouter'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text'],
        nativeBuiltins: ['web_search'],
        statefulMode: false,
        promptCaching: 'auto',
        attachmentMode: 'none',
        thinkingSupport: true,
        requiresApiKey: true,
    }

    constructor(private apiKey: string) {}

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const runtimeTools = dedupeTools([
            ...(options.tools ?? []),
            ...getToolsForBuiltins(options.builtins),
        ])
        const messages = toOpenRouterMessages(options)
        let finalUsage: unknown
        let finalThinkingDuration: number | undefined

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal?.aborted) break

            const result = await streamOpenRouterChat(this.apiKey, {
                model: options.model,
                messages,
                tools: runtimeTools,
                builtins: options.builtins,
                thinkingLevel: options.thinkingLevel,
                signal: options.signal,
                callbacks: cb,
            })

            finalUsage = accumulateOpenRouterUsage(finalUsage, result.usage)
            finalThinkingDuration = result.thinkingDuration ?? finalThinkingDuration

            if (result.toolCalls.length === 0) {
                cb.onDone({
                    usage: finalUsage,
                    thinkingDuration: finalThinkingDuration,
                })
                return
            }

            messages.push({
                role: 'assistant',
                content: result.assistantText || null,
                tool_calls: result.toolCalls.map(call => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments),
                    },
                })),
            })

            for (const call of result.toolCalls) {
                if (options.signal?.aborted) break
                cb.onToolCall({ id: call.id, name: call.name, arguments: call.arguments })
                const tool = runtimeTools.find(t => t.name === call.name || t.id === call.name)
                const toolResult =
                    call.name === 'web_search' || call.name === 'openrouter:web_search'
                        ? await executeOpenRouterWebSearch(this.apiKey, options.model, call.arguments, options.signal)
                        : tool
                            ? await executeTool(tool, call.arguments, options.toolContext
                                ? { ...options.toolContext, currentToolCallId: call.id }
                                : undefined)
                            : { success: false, error: `Unknown tool: ${call.name}` }
                if (options.signal?.aborted) {
                    cb.onError('Aborted')
                    return
                }
                cb.onToolResult(call.id, call.name, toolResult)
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    name: call.name,
                    content: formatToolResult(toolResult),
                })
            }
        }

        if (options.signal?.aborted) {
            cb.onError('Aborted')
            return
        }

        cb.onError(`OpenRouter tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`)
    }
}

function toOpenRouterMessages(options: ProviderSendOptions): AnyObj[] {
    const out: AnyObj[] = []
    if (options.systemPrompt?.trim()) {
        out.push({ role: 'system', content: options.systemPrompt.trim() })
    }
    for (const message of options.messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const content = message.content?.trim() ? message.content : ' '
        out.push({ role, content })
    }
    return out
}

async function streamOpenRouterChat(apiKey: string, args: {
    model: string
    messages: AnyObj[]
    tools: ToolDef[]
    builtins?: string[]
    thinkingLevel?: string
    signal?: AbortSignal
    callbacks: StreamCallbacks
}): Promise<StreamedOpenRouterResponse> {
    const body: AnyObj = {
        model: args.model,
        messages: args.messages,
        stream: true,
        provider: OPENROUTER_PROVIDER_ROUTING,
        usage: { include: true },
    }
    const tools = [
        ...args.tools.map(openRouterTool),
        ...openRouterNativeTools(args.builtins),
    ]
    if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
    }
    Object.assign(body, openRouterReasoningOptions(args.model, args.thinkingLevel))

    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: openRouterHeaders(apiKey),
        body: JSON.stringify(body),
        signal: args.signal,
    })

    if (!response.ok) {
        throw new Error(await openRouterErrorMessage(response))
    }

    let assistantText = ''
    let usage: unknown
    let thinkingStartedAt: number | null = null
    let thinkingTotalMs = 0
    let thinkingDoneSent = false
    let streamError: string | null = null
    const toolCalls = new Map<number, {
        id: string
        name: string
        argumentsJson: string
    }>()

    const startThinking = () => {
        if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
    }
    const stopThinking = () => {
        if (thinkingStartedAt === null || thinkingDoneSent) return
        thinkingTotalMs += Date.now() - thinkingStartedAt
        thinkingStartedAt = null
        thinkingDoneSent = true
        args.callbacks.onThinkingDone(Math.max(1, Math.round(thinkingTotalMs / 1000)))
    }

    await readSse(response, event => {
        if (event.data === '[DONE]') return
        let data: AnyObj
        try {
            data = JSON.parse(event.data) as AnyObj
        } catch {
            return
        }
        const error = objectValue(data.error)
        if (error) {
            streamError = formatOpenRouterError(200, data) ?? 'OpenRouter streaming error'
            return
        }
        usage = data.usage ?? usage
        const choices = Array.isArray(data.choices) ? data.choices as AnyObj[] : []
        for (const choice of choices) {
            const delta = objectValue(choice.delta)
            if (!delta) continue

            const reasoning = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content)
            if (reasoning) {
                startThinking()
                args.callbacks.onThinking(reasoning)
            }

            const content = stringValue(delta.content)
            if (content) {
                stopThinking()
                assistantText += content
                args.callbacks.onContent(content)
            }

            const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as AnyObj[] : []
            for (const rawCall of rawToolCalls) {
                const index = typeof rawCall.index === 'number' ? rawCall.index : toolCalls.size
                const existing = toolCalls.get(index) ?? {
                    id: `openrouter_tool_${index}`,
                    name: '',
                    argumentsJson: '',
                }
                const id = stringValue(rawCall.id)
                if (id) existing.id = id
                const fn = objectValue(rawCall.function)
                const name = stringValue(fn?.name)
                if (name) existing.name = existing.name ? existing.name : name
                const argsDelta = stringValue(fn?.arguments)
                if (argsDelta) existing.argumentsJson += argsDelta
                toolCalls.set(index, existing)
            }
        }
    }, args.signal)

    if (thinkingStartedAt !== null && !thinkingDoneSent) stopThinking()
    if (streamError) throw new Error(streamError)

    return {
        assistantText,
        toolCalls: Array.from(toolCalls.values())
            .filter(call => call.name)
            .map(call => ({
                id: call.id,
                name: call.name,
                arguments: parseJsonObject(call.argumentsJson),
            })),
        usage,
        thinkingDuration: thinkingTotalMs > 0 ? Math.max(1, Math.round(thinkingTotalMs / 1000)) : undefined,
    }
}

async function openRouterErrorMessage(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    if (!text.trim()) return `OpenRouter API error ${response.status}`
    try {
        const parsed = JSON.parse(text) as unknown
        const formatted = formatOpenRouterError(response.status, parsed)
        if (formatted) return formatted
    } catch {
        // fall through to a bounded raw body
    }
    return `OpenRouter API error ${response.status}: ${text.slice(0, 500)}`
}

async function executeOpenRouterWebSearch(
    apiKey: string,
    model: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
): Promise<ToolResult> {
    const query = openRouterSearchQuery(args)
    if (!query) return { success: false, error: 'Missing web_search query' }

    try {
        const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: openRouterHeaders(apiKey),
            body: JSON.stringify({
                model,
                messages: [{
                    role: 'user',
                    content: [
                        'Search the web for the query below and return concise results.',
                        'Include source titles and URLs when available.',
                        '',
                        `Query: ${query}`,
                    ].join('\n'),
                }],
                provider: OPENROUTER_PROVIDER_ROUTING,
                tools: openRouterNativeTools(['web_search']),
                usage: { include: true },
            }),
            signal,
        })
        if (!response.ok) {
            return { success: false, error: await openRouterErrorMessage(response) }
        }
        const json = await response.json() as AnyObj
        const choices = Array.isArray(json.choices) ? json.choices as AnyObj[] : []
        const message = objectValue(choices[0]?.message)
        const content = stringValue(message?.content) ?? ''
        const annotations = Array.isArray(message?.annotations) ? message.annotations : []
        return {
            success: true,
            data: {
                provider: 'openrouter',
                tool: 'web_search',
                query,
                content,
                annotations,
            },
        }
    } catch (error) {
        if (signal?.aborted) return { success: false, error: 'Aborted' }
        return {
            success: false,
            error: error instanceof Error ? error.message : 'OpenRouter web search failed',
        }
    }
}

function openRouterSearchQuery(args: Record<string, unknown>): string {
    for (const key of ['query', 'q', 'search_query']) {
        const value = args[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    const queries = args.queries
    if (Array.isArray(queries)) {
        const parts = queries.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        if (parts.length > 0) return parts.join('\n')
    }
    for (const value of Object.values(args)) {
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function formatOpenRouterError(status: number, value: unknown): string | null {
    const root = objectValue(value)
    const error = objectValue(root?.error)
    if (!error) return null
    const message = stringValue(error.message)
    const metadata = objectValue(error.metadata)
    const raw = stringValue(metadata?.raw)
    const provider = stringValue(metadata?.provider_name)
    const code = typeof error.code === 'number' || typeof error.code === 'string'
        ? String(error.code)
        : String(status)
    const detail = raw && raw !== message ? raw : message
    return [
        `OpenRouter API error ${code}`,
        detail ? `: ${detail}` : '',
        provider ? ` (upstream: ${provider})` : '',
    ].join('')
}

function openRouterHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Orchestrator',
    }
    const referer = process.env.ORCHESTRATOR_PUBLIC_URL
    if (referer?.trim()) headers['HTTP-Referer'] = referer.trim()
    return headers
}

function openRouterTool(tool: ToolDef): AnyObj {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        },
    }
}

function openRouterNativeTools(builtins: string[] | undefined): AnyObj[] {
    if (!builtins?.includes('web_search')) return []
    return [{
        type: 'openrouter:web_search',
        parameters: {
            engine: 'auto',
            max_results: 5,
            max_total_results: 10,
            search_context_size: 'medium',
        },
    }]
}

function openRouterReasoningOptions(model: string, thinkingLevel: string | undefined): AnyObj {
    const level = normalizeReasoningEffort(thinkingLevel)
    if (!level) return {}
    const supported = new Set(
        readLiveRegistry().providers.openrouter?.models[model]?.raw?.supported_parameters as string[] | undefined
    )
    const out: AnyObj = {}
    if (supported.has('include_reasoning')) out.include_reasoning = true
    if (supported.has('reasoning')) out.reasoning = { effort: level }
    return out
}

function normalizeReasoningEffort(level: string | undefined): 'low' | 'medium' | 'high' | null {
    switch (level) {
        case 'low':
            return 'low'
        case 'medium':
            return 'medium'
        case 'high':
        case 'xhigh':
        case 'max':
            return 'high'
        default:
            return null
    }
}

function objectValue(value: unknown): AnyObj | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as AnyObj
        : null
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' ? value : null
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

function accumulateOpenRouterUsage(a: unknown, b: unknown): unknown {
    const left = objectValue(a)
    const right = objectValue(b)
    if (!left) return b ?? a
    if (!right) return a
    const out: AnyObj = { ...right }
    for (const key of [
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'input_tokens',
        'output_tokens',
    ]) {
        const av = typeof left[key] === 'number' ? left[key] as number : 0
        const bv = typeof right[key] === 'number' ? right[key] as number : 0
        if (av || bv) out[key] = av + bv
    }
    return out
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
