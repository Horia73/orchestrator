import type {
    AIProvider,
    ProviderCapabilities,
    ProviderSendOptions,
    StreamCallbacks,
    ToolDef,
    ToolResult,
} from '@/lib/ai/agents/types'
import { executeTool } from '@/lib/ai/tools/executor'
import { getEnvValue } from '@/lib/config'
import {
    ensureLMStudioModelLoaded,
    LM_STUDIO_API_KEY_ENV,
    LM_STUDIO_DEFAULT_CONTEXT_TOKENS,
    lmStudioChatCompletionsUrl,
    lmStudioJsonHeaders,
} from '@/lib/lm-studio'
import { readSse } from './sse'

const MAX_TOOL_ROUNDS = 25

interface AnyObj { [key: string]: unknown }

interface LMStudioToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

interface StreamedLMStudioResponse {
    assistantText: string
    toolCalls: LMStudioToolCall[]
    usage?: unknown
}

export const LM_STUDIO_CAPABILITIES: ProviderCapabilities = {
    kinds: ['text'],
    nativeBuiltins: [],
    statefulMode: false,
    promptCaching: 'none',
    attachmentMode: 'none',
    thinkingSupport: false,
    requiresApiKey: true,
}

export class LMStudioProvider implements AIProvider {
    readonly id = 'lm-studio'
    readonly name = 'LM Studio'
    readonly capabilities = LM_STUDIO_CAPABILITIES

    constructor(private readonly baseUrl: string) {}

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const apiKey = getEnvValue(LM_STUDIO_API_KEY_ENV)
        const contextLength = numericModelOption(options.modelOptions, 'lm_studio_context_length') ?? LM_STUDIO_DEFAULT_CONTEXT_TOKENS
        await ensureLMStudioModelLoaded(this.baseUrl, options.model, apiKey, {
            contextLength,
        })

        const runtimeTools = dedupeTools(options.tools ?? [])
        const messages = toLMStudioMessages(options)
        let finalUsage: unknown

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal?.aborted) break

            const result = await streamLMStudioChat(this.baseUrl, {
                model: options.model,
                messages,
                tools: runtimeTools,
                apiKey,
                signal: options.signal,
                callbacks: cb,
            })

            finalUsage = accumulateUsage(finalUsage, result.usage)

            if (result.toolCalls.length === 0) {
                cb.onDone({ usage: finalUsage })
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
                const toolResult = tool
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

        cb.onError(`LM Studio tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`)
    }
}

function toLMStudioMessages(options: ProviderSendOptions): AnyObj[] {
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

async function streamLMStudioChat(baseUrl: string, args: {
    model: string
    messages: AnyObj[]
    tools: ToolDef[]
    apiKey?: string | null
    signal?: AbortSignal
    callbacks: StreamCallbacks
}): Promise<StreamedLMStudioResponse> {
    const body: AnyObj = {
        model: args.model,
        messages: args.messages,
        stream: true,
    }
    if (args.tools.length > 0) {
        body.tools = args.tools.map(lmStudioTool)
        body.tool_choice = 'auto'
    }

    const response = await fetch(lmStudioChatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers: lmStudioJsonHeaders(args.apiKey),
        body: JSON.stringify(body),
        signal: args.signal,
    })

    if (!response.ok) {
        throw new Error(`LM Studio chat failed (${response.status}): ${await response.text().catch(() => '')}`)
    }

    let assistantText = ''
    let usage: unknown
    let streamError: string | null = null
    const toolCalls = new Map<number, {
        id: string
        name: string
        argumentsJson: string
    }>()

    await readSse(response, event => {
        if (event.data === '[DONE]') return
        let data: AnyObj
        try {
            data = JSON.parse(event.data) as AnyObj
        } catch {
            return
        }

        const error = data.error
        if (error) {
            streamError = typeof error === 'string'
                ? error
                : objectValue(error)?.message && typeof objectValue(error)?.message === 'string'
                    ? objectValue(error)?.message as string
                    : 'LM Studio streaming error'
            return
        }

        usage = data.usage ?? usage
        const choices = Array.isArray(data.choices) ? data.choices as AnyObj[] : []
        for (const choice of choices) {
            const delta = objectValue(choice.delta)
            if (!delta) continue

            const content = stringValue(delta.content)
            if (content) {
                assistantText += content
                args.callbacks.onContent(content)
            }

            const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as AnyObj[] : []
            for (const rawCall of rawToolCalls) {
                const index = typeof rawCall.index === 'number' ? rawCall.index : toolCalls.size
                const existing = toolCalls.get(index) ?? {
                    id: `lm_studio_tool_${index}`,
                    name: '',
                    argumentsJson: '',
                }
                const id = stringValue(rawCall.id)
                if (id) existing.id = id
                const fn = objectValue(rawCall.function)
                const name = stringValue(fn?.name)
                if (name) existing.name = existing.name || name
                const argsDelta = stringValue(fn?.arguments)
                if (argsDelta) existing.argumentsJson += argsDelta
                toolCalls.set(index, existing)
            }
        }
    }, args.signal)

    if (streamError) throw new Error(streamError)

    return {
        assistantText,
        toolCalls: Array.from(toolCalls.values())
            .filter(call => call.name)
            .map(call => ({
                id: call.id,
                name: call.name,
                arguments: parseArguments(call.argumentsJson),
            })),
        usage,
    }
}

function lmStudioTool(tool: ToolDef): AnyObj {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        },
    }
}

function parseArguments(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {}
    try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {}
    } catch {
        return {}
    }
}

function formatToolResult(result: ToolResult): string {
    try {
        return JSON.stringify(result)
    } catch {
        return String(result)
    }
}

function objectValue(value: unknown): AnyObj | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyObj : null
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function dedupeTools(items: ToolDef[]): ToolDef[] {
    const seen = new Set<string>()
    const out: ToolDef[] = []
    for (const item of items) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        out.push(item)
    }
    return out
}

function accumulateUsage(a: unknown, b: unknown): unknown {
    if (!a) return b
    if (!b) return a
    if (!isUsageObject(a) || !isUsageObject(b)) return b
    const out: Record<string, unknown> = { ...a }
    for (const [key, value] of Object.entries(b)) {
        const prev = out[key]
        out[key] = typeof prev === 'number' && typeof value === 'number'
            ? prev + value
            : value
    }
    return out
}

function isUsageObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function numericModelOption(options: ProviderSendOptions['modelOptions'], key: string): number | null {
    const value = options?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
    if (typeof value === 'string') {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
    }
    return null
}
