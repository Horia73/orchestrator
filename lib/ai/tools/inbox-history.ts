import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { listInboxDirectActions } from '@/lib/scheduling/store'
import { numberArg, stringArg } from './helpers'

export const inboxActionHistoryTool: ToolDef = {
    id: 'inbox_action_history',
    name: 'inbox_action_history',
    description: [
        'Returns the recent one-click direct actions the user performed on Inbox quick-reply buttons (mark read/unread/archive on Gmail or WhatsApp).',
        'Treat these as preference signals: if the user repeatedly marks unread certain WhatsApp chats, or archives certain Gmail messages without reading, prefer surfacing future similar items the same way (include matching direct_action buttons in notify_inbox).',
        'These rows skip the model — the user performed them deliberately. Consider them stronger than chat-time hints.',
        'You may consolidate consistent patterns into MEMORY.md or USER.md once they are clearly stable.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            limit: {
                type: 'integer',
                description: 'Maximum rows to return. Defaults to 30, capped at 200.',
            },
            source_kind: {
                type: 'string',
                enum: ['gmail', 'whatsapp'],
                description: 'Optional filter to one source.',
            },
            since_ms: {
                type: 'integer',
                description: 'Optional epoch milliseconds; only entries newer than this are returned.',
            },
        },
    },
    tags: ['read', 'inbox', 'memory'],
}

export async function executeInboxActionHistory(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = Math.max(1, Math.min(200, Math.floor(numberArg(args, ['limit'], 30))))
    const rawSource = stringArg(args, ['source_kind', 'sourceKind'])
    const sourceKind = rawSource === 'gmail' || rawSource === 'whatsapp' ? rawSource : undefined
    const sinceArg = numberArg(args, ['since_ms', 'sinceMs', 'since'], 0)
    const since = Number.isFinite(sinceArg) && sinceArg > 0 ? sinceArg : undefined

    const entries = listInboxDirectActions({ limit, sourceKind, since })
    return {
        success: true,
        data: {
            count: entries.length,
            entries: entries.map(entry => ({
                ts: entry.createdAt,
                tool: entry.tool,
                source_kind: entry.sourceKind,
                source_target: entry.sourceTarget,
                result: entry.result,
                error: entry.errorMessage,
                action_id: entry.actionId,
                conversation_id: entry.conversationId,
            })),
        },
    }
}
