import type { ContentSegment, Message } from '@/lib/types'
import type { RequestLogRow } from './schema'

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
