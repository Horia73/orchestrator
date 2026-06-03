import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import type { InboxDirectAction, InboxReplyAction } from '@/lib/types'

const ACTION_STYLE_VALUES = new Set(['primary', 'secondary', 'destructive'])

const DIRECT_ACTION_TOOLS = new Set<InboxDirectAction['tool']>([
    'gmail.mark_read',
    'gmail.mark_unread',
    'gmail.archive',
    'whatsapp.mark_chat_read',
    'whatsapp.mark_chat_unread',
])

function slugifyActionId(value: string, index: number): string {
    const base = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
    return base || `action_${index + 1}`
}

function normalizeDirectAction(value: unknown): InboxDirectAction | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const tool = typeof raw.tool === 'string' ? raw.tool.trim() : ''
    if (!DIRECT_ACTION_TOOLS.has(tool as InboxDirectAction['tool'])) return undefined

    if (tool.startsWith('gmail.')) {
        const messageId =
            typeof raw.messageId === 'string'
                ? raw.messageId.trim()
                : typeof raw.message_id === 'string'
                    ? (raw.message_id as string).trim()
                    : ''
        if (!messageId) return undefined
        return { tool: tool as 'gmail.mark_read' | 'gmail.mark_unread' | 'gmail.archive', messageId }
    }

    if (tool.startsWith('whatsapp.')) {
        const chatId =
            typeof raw.chatId === 'string'
                ? raw.chatId.trim()
                : typeof raw.chat_id === 'string'
                    ? (raw.chat_id as string).trim()
                    : ''
        if (!chatId) return undefined
        return { tool: tool as 'whatsapp.mark_chat_read' | 'whatsapp.mark_chat_unread', chatId }
    }

    return undefined
}

export function normalizeInboxReplyActions(value: unknown): InboxReplyAction[] | undefined {
    if (!Array.isArray(value)) return undefined
    const actions: InboxReplyAction[] = []
    const used = new Set<string>()

    for (const [index, item] of value.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const raw = item as Record<string, unknown>
        const label = typeof raw.label === 'string' ? raw.label.trim() : ''
        const replyValue = typeof raw.value === 'string' ? raw.value.trim() : ''
        if (!label || !replyValue) continue

        let id = typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim()
            : slugifyActionId(label, index)
        id = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `action_${index + 1}`
        while (used.has(id)) id = `${id}_${index + 1}`
        used.add(id)

        const style = typeof raw.style === 'string' && ACTION_STYLE_VALUES.has(raw.style)
            ? raw.style as InboxReplyAction['style']
            : undefined

        const directAction = normalizeDirectAction(raw.direct_action ?? raw.directAction)

        actions.push({
            id,
            label: label.slice(0, 80),
            value: replyValue.slice(0, 2000),
            style,
            directAction,
        })
        if (actions.length >= 8) break
    }

    return actions.length > 0 ? actions : undefined
}

// Explicit "surface this to the user" signal for scheduled runs. A scheduled
// task is SILENT by default — its full output is always kept in the task's
// Past runs (audit), but it only reaches the user's Inbox if the agent calls
// this tool. The scheduled-run harness reads these calls from the run's event
// stream (see lib/scheduling/run.ts); the executor itself just acknowledges.
export const notifyInboxTool: ToolDef = {
    id: 'notify_inbox',
    name: 'notify_inbox',
    description: [
        'Surface a message to the user\'s Inbox. Use inside a scheduled run only when the result meets the task\'s notify criteria (something changed, something needs the user, an error), or inside an inline Inbox follow-up when you need quick-reply buttons.',
        'If nothing is noteworthy, do NOT call this — the run still gets recorded in Past runs, just silently. Default to staying silent.',
        'Use `title` as an email-style Inbox subject whenever you surface something user-facing. Make it specific to the result, not a generic source label like "Smart monitor" or "Scheduled run".',
        'Write `body` as the message the user reads in their Inbox — written to them, like an email, not a run log. Lead with the point (what changed, what you need, the decision to make), then include as much detail as is genuinely useful to the user; write as long as the content warrants, no artificial length limit. NEVER paste your run narration, step-by-step reasoning, internal bookkeeping, or run/tool ids into it (no "first I run the microscript", "now I read the journal", "I persisted task_state with..."). All of that stays in the run output / Past runs; the Inbox shows only this clean, user-facing message.',
        'When asking the user to choose, include short `actions` buttons. Each action carries a `value` text reply, optionally a `direct_action` that executes a small whitelisted tool WITHOUT invoking the model when clicked.',
        'Use `direct_action` for non-destructive housekeeping on the source item: gmail.mark_read/mark_unread/archive against a gmail messageId, or whatsapp.mark_chat_read/mark_chat_unread against a whatsapp chat_id. The source ids are available in the candidate context when the trigger came from a monitor watcher. Do not invent ids.',
        'Use direct_action only when the user has indicated (in memory, history, or this conversation) a preference for one-click housekeeping; otherwise leave it out and rely on the plain value reply, which routes back through the model. Direct actions skip all model-level reasoning, so they must be safe to perform without further confirmation.',
        'If the message contains obvious next decisions such as archive/keep, mark read/unread, approve/skip, reply/dismiss, summarize now/later, or review first, include `actions` so the user does not have to type the same decision manually.',
        'If the surfaced result is a rich compact artifact, you may include an <artifact> block in `body`. For large or mobile-first artifacts such as workouts, use display="fullscreen" and keep the prose body short; Inbox will show a launch card.',
        'Errors are surfaced automatically; you do not need to call this for failures.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Short email-style subject for the Inbox item. Be specific, e.g. "WhatsApp: today\'s schedule changed" or "Garage door left open".' },
            body: { type: 'string', description: 'The user-facing message shown in the Inbox (markdown ok), written to the user like an email — lead with the point, then as much useful detail as the content warrants (no length limit). Not a run log: no process narration, step-by-step reasoning, or internal bookkeeping. May include one artifact tag when the Inbox item needs a rich card or fullscreen launch surface.' },
            actions: {
                type: 'array',
                description: 'Optional quick-reply buttons shown under the Inbox message. Use for choices like archive/keep, summarize now/later, approve/skip. Max 8.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Stable short id, e.g. "archive_selected".' },
                        label: { type: 'string', description: 'Short button label.' },
                        value: { type: 'string', description: 'The exact user reply sent when clicked, unless direct_action is set.' },
                        style: { type: 'string', enum: ['primary', 'secondary', 'destructive'], description: 'Optional visual intent.' },
                        direct_action: {
                            type: 'object',
                            description: 'Optional. If set, clicking the button executes this whitelisted tool server-side without invoking the model. Use only for non-destructive housekeeping on the source item.',
                            properties: {
                                tool: {
                                    type: 'string',
                                    enum: [
                                        'gmail.mark_read',
                                        'gmail.mark_unread',
                                        'gmail.archive',
                                        'whatsapp.mark_chat_read',
                                        'whatsapp.mark_chat_unread',
                                    ],
                                    description: 'Whitelisted tool id.',
                                },
                                messageId: { type: 'string', description: 'Gmail message id (required for gmail.* tools).' },
                                chatId: { type: 'string', description: 'WhatsApp chat id (required for whatsapp.* tools).' },
                            },
                            required: ['tool'],
                        },
                    },
                    required: ['label', 'value'],
                },
            },
        },
        required: ['body'],
    },
    tags: ['scheduling'],
}

export function executeNotifyInbox(args: Record<string, unknown>): ToolResult {
    const body = typeof args.body === 'string' ? args.body.trim() : ''
    if (!body) return { success: false, error: 'notify_inbox requires a non-empty body.' }
    return {
        success: true,
        data: {
            queued: true,
            actions: normalizeInboxReplyActions(args.actions),
        },
    }
}
