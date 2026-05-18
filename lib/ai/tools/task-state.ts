import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'

// A scheduled task's private memory. The current state is injected into the
// run as <task_state>; call this to persist the NEW state for next time
// (e.g. last-seen id/watermark, last observed price, rolling activity baseline
// for adaptive cadence). Scoped to this task only — never a shared file.
// The scheduled-run harness reads these calls from the event stream
// (lib/scheduling/run.ts); the executor itself just acknowledges.
export const setTaskStateTool: ToolDef = {
    id: 'set_task_state',
    name: 'set_task_state',
    description: [
        'Persist this scheduled task\'s private state for its next run (replaces the previous state wholesale).',
        'Use it to remember a watermark/last-seen id so you do not re-report the same item, a last observed value to detect changes, or a rolling activity count for adaptive cadence.',
        'Only meaningful inside a scheduled run. Keep it small and structured.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            state: { type: 'object', description: 'The full new state object to store for next time.' },
        },
        required: ['state'],
    },
    tags: ['scheduling'],
}

export function executeSetTaskState(args: Record<string, unknown>): ToolResult {
    const state = args.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return { success: false, error: 'set_task_state requires a `state` object.' }
    }
    return { success: true, data: { saved: true } }
}
