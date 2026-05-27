import { NextResponse } from 'next/server'
import { getRequestLog, getToolLogsForRequest } from '@/lib/observability/store'
import { getConversation } from '@/lib/db'
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

type RequestLogTranscript =
    | {
        type: 'message_pair'
        userMessage: Message | null
        assistantMessage: Message
    }
    | {
        type: 'agent_run'
        promptMessage: Message
        assistantMessage: Message
    }

function getRequestTranscript(log: RequestLogRow): RequestLogTranscript | null {
    const conversation = getConversation(log.conversationId)
    if (!conversation) return null

    const assistantIndex = conversation.messages.findIndex(
        message => message.id === log.id && message.role === 'assistant'
    )
    if (assistantIndex >= 0) {
        return {
            type: 'message_pair',
            userMessage: findUserMessageForAssistant(conversation.messages, assistantIndex, log),
            assistantMessage: conversation.messages[assistantIndex],
        }
    }

    const run = findAgentRun(conversation.messages, log.id)
    if (!run) return null

    return {
        type: 'agent_run',
        promptMessage: {
            id: `${run.runId}:prompt`,
            role: 'user',
            content: run.prompt || log.inputText || '',
            timestamp: run.startedAt || log.startedAt,
        },
        assistantMessage: {
            id: run.runId,
            role: 'assistant',
            content: run.content || log.outputText || '',
            status: run.status === 'running' ? undefined : run.status,
            contentSegments: run.contentSegments ?? (run.content ? [{ phase: 0, content: run.content }] : undefined),
            reasoning: run.reasoning,
            attachments: run.attachments,
            thinkingDuration: run.thinkingDuration,
            timestamp: run.endedAt ?? log.endedAt ?? run.startedAt ?? log.startedAt,
        },
    }
}

function findUserMessageForAssistant(messages: Message[], assistantIndex: number, log: RequestLogRow): Message | null {
    for (let i = assistantIndex - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role === 'user') return message
    }
    if (!log.inputText) return null
    return {
        id: `${log.id}:input`,
        role: 'user',
        content: log.inputText,
        timestamp: log.startedAt,
    }
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
