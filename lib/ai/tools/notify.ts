import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import type { InboxReplyAction } from '@/lib/types'

const ACTION_STYLE_VALUES = new Set(['primary', 'secondary', 'destructive'])

function slugifyActionId(value: string, index: number): string {
    const base = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
    return base || `action_${index + 1}`
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

        actions.push({
            id,
            label: label.slice(0, 80),
            value: replyValue.slice(0, 2000),
            style,
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
        'When asking the user to choose, include short `actions` buttons. Each action must be a safe user reply, not an autonomous external action; the model will continue in the same Inbox thread when clicked.',
        'Errors are surfaced automatically; you do not need to call this for failures.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Short email-style subject for the Inbox item. Be specific, e.g. "WhatsApp: today\'s schedule changed" or "Garage door left open".' },
            body: { type: 'string', description: 'The concise message to show the user (markdown ok).' },
            actions: {
                type: 'array',
                description: 'Optional quick-reply buttons shown under the Inbox message. Use for choices like archive/keep, summarize now/later, approve/skip. Max 8.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Stable short id, e.g. "archive_selected".' },
                        label: { type: 'string', description: 'Short button label.' },
                        value: { type: 'string', description: 'The exact user reply sent when clicked.' },
                        style: { type: 'string', enum: ['primary', 'secondary', 'destructive'], description: 'Optional visual intent.' },
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
