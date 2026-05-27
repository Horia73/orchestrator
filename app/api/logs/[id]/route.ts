import { NextResponse } from 'next/server'
import { getRequestLog, getToolLogsForRequest } from '@/lib/observability/store'
import { getConversation } from '@/lib/db'
import { searchTaskRuns } from '@/lib/scheduling/store'
import type { RequestLogRow } from '@/lib/observability/schema'
import type { AgentCallReasoningEntry, Message, ReasoningEntry } from '@/lib/types'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const log = getRequestLog(id)
    if (!log) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const toolLogs = getToolLogsForRequest(id)
    const transcript = getRequestTranscript(log)
    return NextResponse.json({ log, toolLogs, transcript })
}

type RequestLogTranscript = {
    userMessage: Message | null
    assistantMessage: Message
}

function getRequestTranscript(log: RequestLogRow): RequestLogTranscript | null {
    const conversation = getConversation(log.conversationId)
    if (conversation) {
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
    }

    const scheduledRunMessage = messageFromScheduledRun(log)
    if (scheduledRunMessage) {
        return {
            userMessage: messageFromLogInput(log),
            assistantMessage: scheduledRunMessage,
        }
    }

    return null
}

function findUserMessageForAssistant(messages: Message[], assistantIndex: number, log: RequestLogRow): Message | null {
    for (let i = assistantIndex - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role === 'user') return message
    }
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
    if (run.reasoning?.length) score += 30_000
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
