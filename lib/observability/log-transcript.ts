import type { ContentSegment, Message, ToolCallReasoningEntry } from '@/lib/types'
import type { RequestLogRow, ToolLogRow } from './schema'

export type RequestLogTranscript = {
    userMessage: Message | null
    assistantMessage: Message
}

/**
 * The Logs detail may borrow reasoning/tool trace data from richer stores, but
 * the visible request preview must stay tied to the request_logs row. Nearby
 * inbox/thread messages often summarize or paraphrase a run and can otherwise
 * make the detail show one source's input beside another source's output.
 */
export function normalizeLogTranscriptForPreview(
    log: RequestLogRow,
    transcript: RequestLogTranscript | null
): RequestLogTranscript | null {
    if (!transcript && !log.inputText && !log.outputText) return null

    return {
        userMessage: messageFromLogInput(log) ?? transcript?.userMessage ?? null,
        assistantMessage: messageFromLogOutput(log, transcript?.assistantMessage ?? null),
    }
}

export function withMissingToolLogReasoning(message: Message, toolLogs: ToolLogRow[] | null): Message {
    if (!toolLogs?.length) return message
    const existing = message.reasoning ?? []

    if (existing.length === 0) {
        const reasoning = toolLogs.map((tool, index) => toolLogReasoningEntry(tool, index, index, true))
        return {
            ...message,
            reasoning,
            contentSegments: message.content ? [{ phase: reasoning.length, content: message.content }] : message.contentSegments,
        }
    }

    const existingCounts = new Map<string, number>()
    for (const entry of existing) {
        if (entry.type !== 'tool_call') continue
        const key = toolIdentity(entry.toolName ?? entry.title)
        existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1)
    }

    const missing: ToolLogRow[] = []
    for (const tool of toolLogs) {
        const key = toolIdentity(tool.toolName)
        const remaining = existingCounts.get(key) ?? 0
        if (remaining > 0) {
            existingCounts.set(key, remaining - 1)
            continue
        }
        missing.push(tool)
    }

    if (missing.length === 0) return message
    const phase = finalContentPhase(existing)
    return {
        ...message,
        reasoning: [
            ...existing,
            ...missing.map((tool, index) => toolLogReasoningEntry(tool, index, phase, true)),
        ],
    }
}

export function toolLogReasoningEntry(
    tool: ToolLogRow,
    index: number,
    phase: number,
    deferDetails = false
): ToolCallReasoningEntry {
    const fallbackId = `log_tool_fallback_${tool.id}`
    return {
        type: 'tool_call',
        id: `log_tool_fallback_${tool.id}_${index}`,
        phase: tool.phase ?? phase,
        toolCallId: tool.toolCallId ?? fallbackId,
        title: tool.title ?? tool.toolName,
        content: tool.errorMessage
            ? `Error: ${tool.errorMessage}`
            : tool.resultText ?? 'Detailed output was not recorded for this older tool call.',
        toolName: tool.toolName,
        args: tool.args ?? undefined,
        deltas: tool.deltas ?? undefined,
        success: tool.success,
        status: tool.success ? 'ok' : 'error',
        startedAt: tool.startedAt,
        endedAt: tool.durationMs === null ? undefined : tool.startedAt + tool.durationMs,
        detailsDeferred: deferDetails,
    }
}

export function deferMessageToolDetails(message: Message): Message {
    return {
        ...message,
        reasoning: deferReasoningToolDetails(message.reasoning),
    }
}

function deferReasoningToolDetails(
    reasoning: Message['reasoning']
): Message['reasoning'] {
    return reasoning?.map((entry) => {
        if (entry.type === 'tool_call') {
            return {
                ...entry,
                content: '',
                args: undefined,
                deltas: undefined,
                detailsDeferred: true,
            }
        }
        if (entry.type === 'agent_call') {
            return { ...entry, reasoning: deferReasoningToolDetails(entry.reasoning) }
        }
        return entry
    })
}

export function findToolCallReasoningEntry(
    reasoning: Message['reasoning'],
    toolCallId: string
): ToolCallReasoningEntry | null {
    for (const entry of reasoning ?? []) {
        if (entry.type === 'tool_call' && entry.toolCallId === toolCallId) {
            return { ...entry, detailsDeferred: false }
        }
        if (entry.type === 'agent_call') {
            const nested = findToolCallReasoningEntry(entry.reasoning, toolCallId)
            if (nested) return nested
        }
    }
    return null
}

function toolIdentity(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase()
}

function messageFromLogInput(log: RequestLogRow): Message | null {
    if (!log.inputText) return null
    return {
        id: `${log.id}:input`,
        role: 'user',
        content: log.inputText,
        timestamp: log.startedAt,
    }
}

function messageFromLogOutput(log: RequestLogRow, source: Message | null): Message {
    const content = log.outputText ?? source?.content ?? ''
    const reasoning = source?.reasoning
    const contentSegments = normalizeAssistantContentSegments({
        rowOutput: log.outputText,
        fallbackContent: content,
        sourceSegments: source?.contentSegments,
        reasoning,
    })

    return {
        ...(source ?? {}),
        id: source?.id ?? log.id,
        role: 'assistant',
        content,
        status: source?.status ?? (log.status === 'streaming' ? undefined : log.status),
        reasoning,
        contentSegments,
        timestamp: source?.timestamp ?? log.endedAt ?? log.startedAt,
        durationMs: source?.durationMs ?? log.durationMs ?? undefined,
    }
}

function normalizeAssistantContentSegments(args: {
    rowOutput: string | null
    fallbackContent: string
    sourceSegments: ContentSegment[] | undefined
    reasoning: Message['reasoning']
}): ContentSegment[] | undefined {
    if (args.rowOutput !== null) {
        if (segmentsMatchContent(args.sourceSegments, args.rowOutput)) {
            return args.sourceSegments
        }
        return args.rowOutput
            ? [{ phase: finalContentPhase(args.reasoning), content: args.rowOutput }]
            : undefined
    }

    if (args.sourceSegments?.length) return args.sourceSegments
    return args.fallbackContent
        ? [{ phase: finalContentPhase(args.reasoning), content: args.fallbackContent }]
        : undefined
}

function segmentsMatchContent(
    segments: ContentSegment[] | undefined,
    content: string
): segments is ContentSegment[] {
    if (!segments?.length) return false
    return segments.map(segment => segment.content).join('') === content
}

function finalContentPhase(reasoning: Message['reasoning']): number {
    if (!reasoning?.length) return 0
    return Math.max(...reasoning.map(entry => Number.isFinite(entry.phase) ? entry.phase : 0)) + 1
}
