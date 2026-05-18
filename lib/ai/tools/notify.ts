import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'

// Explicit "surface this to the user" signal for scheduled runs. A scheduled
// task is SILENT by default — its full output is always kept in the task's
// Past runs (audit), but it only reaches the user's Inbox if the agent calls
// this tool. The scheduled-run harness reads these calls from the run's event
// stream (see lib/scheduling/run.ts); the executor itself just acknowledges.
export const notifyInboxTool: ToolDef = {
    id: 'notify_inbox',
    name: 'notify_inbox',
    description: [
        'Surface a message to the user\'s Inbox. Use ONLY inside a scheduled run, and ONLY when the result meets the task\'s notify criteria (something changed, something needs the user, an error).',
        'If nothing is noteworthy, do NOT call this — the run still gets recorded in Past runs, just silently. Default to staying silent.',
        'Errors are surfaced automatically; you do not need to call this for failures.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Optional short headline for the Inbox item.' },
            body: { type: 'string', description: 'The concise message to show the user (markdown ok).' },
        },
        required: ['body'],
    },
    tags: ['scheduling'],
}

export function executeNotifyInbox(args: Record<string, unknown>): ToolResult {
    const body = typeof args.body === 'string' ? args.body.trim() : ''
    if (!body) return { success: false, error: 'notify_inbox requires a non-empty body.' }
    return { success: true, data: { queued: true } }
}
