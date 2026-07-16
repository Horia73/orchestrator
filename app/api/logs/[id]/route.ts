import { NextResponse } from 'next/server'
import { getRequestLogReasoning } from '@/lib/observability/store'
import { getRequestLogDetailAcrossProfiles } from '@/lib/observability/profile-store'
import { getConversation } from '@/lib/db'
import { getInboxConversation, searchTaskRuns } from '@/lib/scheduling/store'
import type { RequestLogRow } from '@/lib/observability/schema'
import type { AgentCallReasoningEntry, Message, ReasoningEntry } from '@/lib/types'
import {
    deferMessageToolDetails,
    findToolCallReasoningEntry,
    normalizeLogTranscriptForPreview,
    toolLogReasoningEntry,
    type RequestLogTranscript,
} from '@/lib/observability/log-transcript'
import { runWithProfileContext } from '@/lib/profiles/context'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(_request, async () => {
        const { id } = await params
        const url = new URL(_request.url)
        const includeInput = url.searchParams.get('includeInput') === '1'
        const detail = getRequestLogDetailAcrossProfiles(id, { includeInput })
        if (!detail) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        const toolCallId = url.searchParams.get('toolCallId')
        if (toolCallId) {
            const fullTranscript = runWithProfileContext(
                { profileId: detail.profile.id, role: detail.profile.role },
                () => getRequestTranscript(detail.row)
            )
            const persistedTool = findToolCallReasoningEntry(
                fullTranscript?.assistantMessage.reasoning,
                toolCallId
            )
            if (persistedTool) return NextResponse.json({ toolCall: persistedTool })

            const fallbackIndex = detail.toolLogs.findIndex((tool) =>
                tool.toolCallId === toolCallId || `log_tool_fallback_${tool.id}` === toolCallId
            )
            if (fallbackIndex >= 0) {
                return NextResponse.json({
                    toolCall: toolLogReasoningEntry(
                        detail.toolLogs[fallbackIndex],
                        fallbackIndex,
                        fallbackIndex,
                        false
                    ),
                })
            }
            return NextResponse.json({ error: 'Tool call not found' }, { status: 404 })
        }
        const transcript = runWithProfileContext(
            { profileId: detail.profile.id, role: detail.profile.role },
            () => normalizeLogTranscriptForPreview(
                detail.row,
                getRequestTranscript(detail.row)
            )
        )
        return NextResponse.json({
            log: detail.row,
            transcript: transcript
                ? { ...transcript, assistantMessage: deferMessageToolDetails(transcript.assistantMessage) }
                : null,
            hasInput: detail.hasInput,
            input: includeInput ? detail.input : null,
            toolLogs: detail.toolLogs.map((tool) => ({
                ...tool,
                args: null,
                resultText: null,
                deltas: null,
            })),
        })
  })
}

function getRequestTranscript(log: RequestLogRow): RequestLogTranscript | null {
    // Several stores can hold this run's transcript — an inbox thread, a user
    // conversation, a delegated agent run, or a scheduled-task run — and they do
    // NOT all carry the same fidelity. The interleaved thinking+tool reasoning
    // that the main chat renders lives only on the richest of them. Gather every
    // candidate in priority order and return the first that actually has
    // reasoning, falling back to the highest-priority bare candidate when none
    // do. Without this a reasoning-less inbox/summary message shadows the
    // scheduled-run record that holds the real step-by-step, and the Logs detail
    // collapses to its lossy text-only view ("nu văd tool calls în logs").
    const candidates = [
        getPersistedLogTranscript(log),
        getInboxThreadTranscript(log),
        getConversationTranscript(log),
        getScheduledRunTranscript(log),
    ]

    let fallback: RequestLogTranscript | null = null
    for (const candidate of candidates) {
        if (!candidate) continue
        if (!fallback) fallback = candidate
        if (transcriptHasReasoning(candidate)) return candidate
    }
    return fallback
}

function transcriptHasReasoning(transcript: RequestLogTranscript): boolean {
    const reasoning = transcript.assistantMessage.reasoning
    return Array.isArray(reasoning) && reasoning.length > 0
}

// The run's OWN interleaved transcript, persisted at completion. This is the
// most reliable source — no fuzzy time/text matching, and it exists for
// background/scheduled/sub-agent runs that never land in a conversation. When
// present it lets the Logs detail render exactly like the main chat.
function getPersistedLogTranscript(log: RequestLogRow): RequestLogTranscript | null {
    const persisted = getRequestLogReasoning(log.id)
    if (!persisted || (!persisted.reasoning?.length && !persisted.contentSegments?.length)) {
        return null
    }
    const content = log.outputText ?? ''
    const reasoning = persisted.reasoning ?? undefined
    return {
        userMessage: messageFromLogInput(log),
        assistantMessage: {
            id: log.id,
            role: 'assistant',
            content,
            status: log.status === 'streaming' ? undefined : log.status,
            reasoning,
            contentSegments:
                persisted.contentSegments
                ?? (content ? [{ phase: finalContentPhase(reasoning), content }] : undefined),
            timestamp: log.endedAt ?? log.startedAt,
        },
    }
}

function getConversationTranscript(log: RequestLogRow): RequestLogTranscript | null {
    const conversation = getConversation(log.conversationId)
    if (!conversation) return null

    const assistantMessage = conversation.messages.find(
        message => message.id === log.id && message.role === 'assistant'
    )
    if (assistantMessage) {
        const assistantIndex = conversation.messages.indexOf(assistantMessage)
        return {
            userMessage: findUserMessageForAssistant(conversation.messages, assistantIndex, log),
            assistantMessage,
        }
    }

    const run = findAgentRun(conversation.messages, log.id)
    if (run) {
        return {
            userMessage: messageFromAgentPrompt(run, log),
            assistantMessage: messageFromAgentRun(run, log),
        }
    }
    return null
}

function getScheduledRunTranscript(log: RequestLogRow): RequestLogTranscript | null {
    const scheduledRunMessage = messageFromScheduledRun(log)
    if (!scheduledRunMessage) return null
    return {
        userMessage: messageFromLogInput(log),
        assistantMessage: scheduledRunMessage,
    }
}

function getInboxThreadTranscript(log: RequestLogRow): RequestLogTranscript | null {
    if (!shouldPreferInboxThreadTranscript(log)) return null

    const inbox = getInboxConversation(log.conversationId)
    if (!inbox) return null

    const assistantMessage = findInboxAssistantMessageForLog(inbox.messages, log)
    if (!assistantMessage) return null

    const assistantIndex = inbox.messages.indexOf(assistantMessage)
    return {
        userMessage: findUserMessageForAssistant(
            inbox.messages,
            assistantIndex,
            log,
            { fallbackToLogInput: false },
        ),
        assistantMessage,
    }
}

function shouldPreferInboxThreadTranscript(log: RequestLogRow): boolean {
    const parentRequestId = log.parentRequestId ?? ''
    // Scheduled wakes keep their full run transcript.
    // Inbox replies and microscript notifications mirror the Inbox thread.
    return parentRequestId.startsWith('inbox_') || parentRequestId.startsWith('microscript_')
}

function findInboxAssistantMessageForLog(messages: Message[], log: RequestLogRow): Message | null {
    const byId = messages.find(message => message.id === log.id && message.role === 'assistant')
    if (byId) return byId

    const end = log.endedAt ?? log.startedAt
    const minTimestamp = log.startedAt - 5_000
    const maxTimestamp = end + 60 * 60_000
    let best: { message: Message; score: number } | null = null

    for (const message of messages) {
        if (message.role !== 'assistant') continue
        if (message.timestamp < minTimestamp || message.timestamp > maxTimestamp) continue

        let score = Math.max(1, 60 * 60_000 - Math.abs(message.timestamp - end))
        const logOutput = (log.outputText ?? '').trim()
        const content = message.content.trim()
        if (logOutput && content === logOutput) score += 1_000_000
        else if (logOutput && (content.includes(logOutput) || logOutput.includes(content))) score += 500_000
        if (message.reasoning?.length) score += 50_000
        if (message.contentSegments?.length) score += 50_000
        if (message.status === log.status) score += 10_000

        if (!best || score > best.score) best = { message, score }
    }

    return best?.message ?? null
}

function findUserMessageForAssistant(
    messages: Message[],
    assistantIndex: number,
    log: RequestLogRow,
    options: { fallbackToLogInput?: boolean } = {},
): Message | null {
    for (let i = assistantIndex - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role === 'user') return message
    }
    if (options.fallbackToLogInput === false) return null
    return messageFromLogInput(log)
}

function messageFromAgentPrompt(run: AgentCallReasoningEntry, log: RequestLogRow): Message | null {
    const content = run.prompt || log.inputText || ''
    if (!content) return null
    return {
        id: `${run.runId}:prompt`,
        role: 'user',
        content,
        timestamp: run.startedAt || log.startedAt,
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

function messageFromAgentRun(run: AgentCallReasoningEntry, log: RequestLogRow): Message {
    return {
        id: run.runId,
        role: 'assistant',
        content: run.content || log.outputText || '',
        status: run.status === 'running' ? undefined : run.status,
        contentSegments: run.contentSegments ?? (run.content ? [{ phase: 0, content: run.content }] : undefined),
        reasoning: run.reasoning,
        attachments: run.attachments,
        thinkingDuration: run.thinkingDuration,
        timestamp: run.endedAt ?? log.endedAt ?? run.startedAt ?? log.startedAt,
    }
}

function messageFromScheduledRun(log: RequestLogRow): Message | null {
    const windowMs = 10 * 60 * 1000
    const candidates = searchTaskRuns({
        startedAfter: Math.max(0, log.startedAt - windowMs),
        limit: 200,
    }).runs
        .filter(run => Math.abs(run.startedAt - log.startedAt) <= windowMs)
        .sort((a, b) => scheduledRunScore(log, b) - scheduledRunScore(log, a))

    const run = candidates[0]
    if (!run || scheduledRunScore(log, run) <= 0) return null

    const content = run.summary || log.outputText || ''
    return {
        id: log.id,
        role: 'assistant',
        content,
        status: run.status === 'ok' ? 'ok' : 'error',
        contentSegments: run.contentSegments ?? (content ? [{ phase: finalContentPhase(run.reasoning), content }] : undefined),
        reasoning: run.reasoning,
        attachments: run.attachments,
        timestamp: run.endedAt ?? log.endedAt ?? log.startedAt,
    }
}

function scheduledRunScore(log: RequestLogRow, run: { startedAt: number; summary: string; reasoning?: ReasoningEntry[] }): number {
    const delta = Math.abs(run.startedAt - log.startedAt)
    let score = Math.max(1, 10 * 60 * 1000 - delta)
    const logOutput = (log.outputText ?? '').trim()
    const summary = run.summary.trim()
    if (logOutput && summary && logOutput === summary) score += 10 * 60 * 1000
    if (logOutput && summary && (logOutput.includes(summary) || summary.includes(logOutput))) score += 60_000
    // A run that captured the interleaved reasoning must outrank any
    // reasoning-less run in the window — that record is the only one the Logs
    // detail can render exactly like the main chat. Use a weight larger than the
    // max possible time+text score (~1.26M) so reasoning presence dominates the
    // pick instead of raw time proximity.
    if (run.reasoning?.length) score += 5_000_000
    return score
}

function finalContentPhase(reasoning: ReasoningEntry[] | undefined): number {
    if (!reasoning?.length) return 0
    return Math.max(...reasoning.map(entry => Number.isFinite(entry.phase) ? entry.phase : 0)) + 1
}

function findAgentRun(messages: Message[], runId: string): AgentCallReasoningEntry | null {
    for (const message of messages) {
        const found = findAgentRunInReasoning(message.reasoning, runId)
        if (found) return found
    }
    return null
}

function findAgentRunInReasoning(reasoning: ReasoningEntry[] | undefined, runId: string): AgentCallReasoningEntry | null {
    if (!reasoning) return null
    for (const entry of reasoning) {
        if (entry.type !== 'agent_call') continue
        if (entry.runId === runId) return entry
        const nested = findAgentRunInReasoning(entry.reasoning, runId)
        if (nested) return nested
    }
    return null
}
