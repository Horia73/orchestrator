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
import { readSse } from './sse'

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOOL_ROUNDS = 25
const DEFAULT_MAX_TOKENS = 8192

interface AnyObj { [key: string]: unknown }

interface AnthropicToolCall {
    id: string
    name: string
    input: Record<string, unknown>
}

interface AnthropicStreamResult {
    assistantContent: AnyObj[]
    toolCalls: AnthropicToolCall[]
    stopReason?: string
    usage?: unknown
    thinkingDuration?: number
}

export class AnthropicProvider implements AIProvider {
    readonly id = 'anthropic'
    readonly name = 'Anthropic'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text'],
        nativeBuiltins: ['web_search'],
        statefulMode: false,
        promptCaching: 'manual',
        attachmentMode: 'inline-base64',
        thinkingSupport: true,
        requiresApiKey: true,
    }

    constructor(private apiKey: string) {}

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const runtimeTools = dedupeTools([
            ...(options.tools ?? []),
            ...getToolsForBuiltins(options.builtins),
        ])
        const messages = toAnthropicMessages(options.messages)
        let finalUsage: unknown
        let finalThinkingDuration: number | undefined

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal?.aborted) break

            const result = await streamAnthropicMessage(this.apiKey, {
                model: options.model,
                systemPrompt: options.systemPrompt,
                thinkingLevel: options.thinkingLevel,
                messages,
                tools: runtimeTools,
                builtins: options.builtins,
                signal: options.signal,
                callbacks: cb,
            })

            finalUsage = result.usage ?? finalUsage
            finalThinkingDuration = result.thinkingDuration ?? finalThinkingDuration

            if (result.toolCalls.length === 0 || result.stopReason !== 'tool_use') {
                cb.onDone({
                    usage: finalUsage,
                    thinkingDuration: finalThinkingDuration,
                })
                return
            }

            messages.push({ role: 'assistant', content: result.assistantContent })
            const toolResults: AnyObj[] = []
            for (const call of result.toolCalls) {
                if (options.signal?.aborted) break
                cb.onToolCall({ id: call.id, name: call.name, arguments: call.input })
                const tool = runtimeTools.find(t => t.name === call.name || t.id === call.name)
                const toolResult = tool
                    ? await executeTool(tool, call.input, options.toolContext
                        ? { ...options.toolContext, currentToolCallId: call.id }
                        : undefined)
                    : { success: false, error: `Unknown tool: ${call.name}` }
                cb.onToolResult(call.id, call.name, toolResult)
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: call.id,
                    content: formatToolResult(toolResult),
                    is_error: !toolResult.success,
                })
            }
            messages.push({ role: 'user', content: toolResults })
        }

        cb.onError(`Anthropic tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`)
    }
}

function toAnthropicMessages(messages: ProviderSendOptions['messages']): AnyObj[] {
    const out: AnyObj[] = []
    for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const content = message.content || ' '
        const last = out[out.length - 1]
        if (last?.role === role && typeof last.content === 'string') {
            last.content += `\n\n${content}`
        } else {
            out.push({ role, content })
        }
    }
    return out
}

async function streamAnthropicMessage(apiKey: string, args: {
    model: string
    systemPrompt?: string
    thinkingLevel?: string
    messages: AnyObj[]
    tools: ToolDef[]
    builtins?: string[]
    signal?: AbortSignal
    callbacks: StreamCallbacks
}): Promise<AnthropicStreamResult> {
    const thinkingBudget = mapAnthropicThinkingBudget(args.thinkingLevel)
    const body: AnyObj = {
        model: args.model,
        max_tokens: thinkingBudget ? Math.max(DEFAULT_MAX_TOKENS, thinkingBudget + 1024) : DEFAULT_MAX_TOKENS,
        messages: args.messages,
        stream: true,
    }
    if (args.systemPrompt?.trim()) body.system = args.systemPrompt.trim()
    const tools = [
        ...args.tools.map(anthropicTool),
        ...anthropicNativeTools(args.builtins),
    ]
    if (tools.length > 0) body.tools = tools
    if (thinkingBudget) body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }

    const headers: Record<string, string> = {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
    }
    if (thinkingBudget && tools.length > 0) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
    }
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: args.signal,
    })

    if (!response.ok) {
        throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`)
    }

    const blocks = new Map<number, AnyObj>()
    const toolJsonByIndex = new Map<number, string>()
    let stopReason: string | undefined
    let usage: unknown
    let thinkingStartedAt: number | null = null
    let thinkingTotalMs = 0

    const startThinking = () => {
        if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
    }
    const stopThinking = () => {
        if (thinkingStartedAt === null) return
        thinkingTotalMs += Date.now() - thinkingStartedAt
        thinkingStartedAt = null
        args.callbacks.onThinkingDone(Math.max(1, Math.round(thinkingTotalMs / 1000)))
    }

    await readSse(response, event => {
        let data: AnyObj
        try {
            data = JSON.parse(event.data) as AnyObj
        } catch {
            return
        }

        const type = typeof data.type === 'string' ? data.type : event.event
        if (type === 'message_start') {
            const message = data.message as AnyObj | undefined
            usage = mergeUsage(usage, message?.usage)
            return
        }

        if (type === 'content_block_start') {
            const index = typeof data.index === 'number' ? data.index : blocks.size
            const block = data.content_block as AnyObj | undefined
            if (!block) return
            if (block.type === 'tool_use') {
                blocks.set(index, {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: {},
                })
                toolJsonByIndex.set(index, '')
            } else if (block.type === 'text') {
                blocks.set(index, { type: 'text', text: typeof block.text === 'string' ? block.text : '' })
            } else if (block.type === 'thinking') {
                blocks.set(index, { type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '' })
                startThinking()
            } else if (block.type === 'server_tool_use') {
                const id = typeof block.id === 'string' ? block.id : `anthropic_server_tool_${index}`
                const name = typeof block.name === 'string' ? block.name : 'server_tool'
                const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                    ? block.input as Record<string, unknown>
                    : {}
                blocks.set(index, { type: 'server_tool_use', id, name, input })
                args.callbacks.onToolCall({ id, name, arguments: input })
            } else if (block.type === 'web_search_tool_result') {
                const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : `anthropic_web_result_${index}`
                blocks.set(index, block)
                args.callbacks.onToolResult(toolUseId, 'web_search', anthropicWebSearchResult(block))
            }
            return
        }

        if (type === 'content_block_delta') {
            const index = typeof data.index === 'number' ? data.index : 0
            const delta = data.delta as AnyObj | undefined
            if (!delta) return
            const block = blocks.get(index)
            if (delta.type === 'text_delta') {
                const text = typeof delta.text === 'string' ? delta.text : ''
                if (text) {
                    stopThinking()
                    if (block?.type === 'text') block.text = String(block.text ?? '') + text
                    else blocks.set(index, { type: 'text', text })
                    args.callbacks.onContent(text)
                }
            } else if (delta.type === 'input_json_delta') {
                toolJsonByIndex.set(index, (toolJsonByIndex.get(index) ?? '') + (typeof delta.partial_json === 'string' ? delta.partial_json : ''))
            } else if (delta.type === 'thinking_delta') {
                const text = typeof delta.thinking === 'string' ? delta.thinking : ''
                if (text) {
                    startThinking()
                    if (block?.type === 'thinking') block.thinking = String(block.thinking ?? '') + text
                    args.callbacks.onThinking(text)
                }
            } else if (delta.type === 'signature_delta') {
                if (block?.type === 'thinking' && typeof delta.signature === 'string') {
                    block.signature = delta.signature
                }
            }
            return
        }

        if (type === 'content_block_stop') {
            const index = typeof data.index === 'number' ? data.index : 0
            const block = blocks.get(index)
            if (block?.type === 'tool_use') {
                block.input = parseJsonObject(toolJsonByIndex.get(index) ?? '')
            }
            return
        }

        if (type === 'message_delta') {
            const delta = data.delta as AnyObj | undefined
            if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason
            usage = mergeUsage(usage, data.usage)
            return
        }

        if (type === 'message_stop') {
            stopThinking()
            return
        }

        if (type === 'error') {
            const error = data.error as AnyObj | undefined
            args.callbacks.onError(typeof error?.message === 'string' ? error.message : 'Anthropic streaming error')
        }
    }, args.signal)

    stopThinking()
    const assistantContent = Array.from(blocks.entries())
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block)
    const toolCalls = assistantContent
        .filter(block => block.type === 'tool_use')
        .map(block => ({
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            input: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                ? block.input as Record<string, unknown>
                : {},
        }))
        .filter(call => call.id && call.name)

    return {
        assistantContent,
        toolCalls,
        stopReason,
        usage,
        thinkingDuration: thinkingTotalMs > 0 ? Math.max(1, Math.round(thinkingTotalMs / 1000)) : undefined,
    }
}

function anthropicNativeTools(builtins: string[] | undefined): AnyObj[] {
    if (!builtins?.includes('web_search')) return []
    return [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
    }]
}

function anthropicWebSearchResult(block: AnyObj): ToolResult {
    const content = block.content
    const error = content && typeof content === 'object' && !Array.isArray(content)
        ? content as AnyObj
        : null
    const isError = error?.type === 'web_search_tool_result_error'
    return {
        success: !isError,
        data: {
            provider: 'anthropic',
            type: block.type,
            tool_use_id: block.tool_use_id,
            content,
        },
        error: isError
            ? `Anthropic web search error: ${String(error?.error_code ?? 'unknown')}`
            : undefined,
    }
}

function mapAnthropicThinkingBudget(level: string | undefined): number | null {
    switch (level) {
        case 'minimal':
        case 'low':
            return 1024
        case 'medium':
            return 2048
        case 'high':
            return 4096
        case 'xhigh':
        case 'max':
            return 8192
        default:
            return null
    }
}

function mergeUsage(current: unknown, next: unknown): unknown {
    if (!current || typeof current !== 'object') return next ?? current
    if (!next || typeof next !== 'object') return current
    return { ...(current as Record<string, unknown>), ...(next as Record<string, unknown>) }
}

function anthropicTool(tool: ToolDef): AnyObj {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
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
