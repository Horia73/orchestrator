import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import type { ScheduledAction, ScheduledTask, ScheduleSpec } from '@/lib/scheduling/schema'
import { describeSchedule } from '@/lib/scheduling/compute'
import { floorToMonitorSlot } from '@/lib/monitor/cadence'

// ---------------------------------------------------------------------------
// Agent-facing scheduling tools. The orchestrator decides ONCE, at creation
// time, whether a task needs a model later:
//   - deterministic deferred work ("turn on the light in 7h") → action.type
//     "tool": the resolved tool call runs with no model at fire time.
//   - work needing fresh reasoning/data at fire time ("summarize today's
//     email") → action.type "agent": the agent is woken with a prompt.
// Heavy modules (registry/store) are imported lazily to keep the tool
// registry's import graph acyclic.
// ---------------------------------------------------------------------------

const SYSTEM_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
})()

export const scheduleTaskTool: ToolDef = {
    id: 'schedule_task',
    name: 'schedule_task',
    description: [
        'Schedule one-shot, delayed, bounded, or time-critical work to run later. For ongoing recurring model-owned checks, summaries, maintenance, and persistent monitoring, use Smart Monitor instead.',
        'Decide the action TYPE now:',
        '"tool" — a deterministic deferred action whose intent is fully known now. It runs with NO model at fire time: cheap, instant, reliable. Resolve the exact tool id + args yourself before scheduling.',
        '"agent" — one-shot or bounded future work that needs fresh reasoning, data, or judgement at fire time. The agent (default: you, the orchestrator) is woken with the prompt.',
        'For agent actions you may opt INTO adaptive self-pacing via `action.adaptive: true` only when the user accepted flexible timing. A task created with an explicit fixed cadence MUST stay on that cadence: leave `adaptive` false or omit it.',
        'Results land in the user\'s Inbox. One-shot tasks missed while the app was offline are reported as missed, not run late.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Short label shown in the scheduling list and Inbox.' },
            when: {
                type: 'object',
                description: 'Exactly one timing field. Use timezone for wall-clock timing; defaults to the server timezone.',
                properties: {
                    at: { type: 'string', description: 'One-shot at an absolute time, ISO 8601.' },
                    in: { type: 'string', description: 'One-shot after a relative delay: "90s", "30m", "7h", "3d".' },
                    daily_at: { type: 'string', description: 'Recurring every day at "HH:MM" (24h). Use only for bounded/non-monitor scheduling; ongoing recurring model-owned checks belong in Smart Monitor.' },
                    every: { type: 'string', description: 'Recurring fixed interval, minimum 1m. Use only for bounded/non-monitor scheduling; ongoing recurring model-owned checks belong in Smart Monitor.' },
                    cron: { type: 'string', description: 'Recurring raw cron expression. Use only for bounded/non-monitor scheduling; ongoing recurring model-owned checks belong in Smart Monitor.' },
                    weekly_days: { type: 'array', items: { type: 'string' }, description: 'For weekly timing. Pair with weekly_at.' },
                    weekly_at: { type: 'string', description: 'For weekly: time "HH:MM" on weekly_days.' },
                    timezone: { type: 'string', description: 'IANA timezone for daily_at/weekly/cron. Default: server timezone.' },
                },
            },
            action: {
                type: 'object',
                description: 'What runs when the task fires.',
                properties: {
                    type: { type: 'string', enum: ['tool', 'agent'], description: '"tool" = deterministic, no model. "agent" = wake a model with a prompt.' },
                    prompt: { type: 'string', description: 'agent: the instruction sent at fire time.' },
                    agent_id: { type: 'string', description: 'agent: optional target agent id. Default "orchestrator".' },
                    adaptive: { type: 'boolean', description: 'agent: opt-in to model self-pacing via reschedule_task (default false). Only set true when the user explicitly accepted flexible cadence. NEVER set true for a fixed cadence the user requested.' },
                    tool_id: { type: 'string', description: 'tool: exact registry tool id.' },
                    tool_args: { type: 'object', description: 'tool: arguments object passed verbatim to the tool.' },
                    summary: { type: 'string', description: 'tool: human one-liner of what it does (shown in UI/Inbox).' },
                },
                required: ['type'],
            },
        },
        required: ['title', 'when', 'action'],
    },
    tags: ['scheduling'],
}

export const listTasksTool: ToolDef = {
    id: 'list_tasks',
    name: 'list_tasks',
    description: 'List all scheduled tasks with their status, schedule, next run, and last run outcome.',
    input_schema: { type: 'object', properties: {} },
    tags: ['scheduling'],
}

export const cancelTaskTool: ToolDef = {
    id: 'cancel_task',
    name: 'cancel_task',
    description: 'Permanently delete a scheduled task by id. Use list_tasks first to find the id.',
    input_schema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Id of the task to delete.' } },
        required: ['task_id'],
    },
    tags: ['scheduling'],
}

// --- normalization helpers -------------------------------------------------

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function parseDurationMs(value: string): number | null {
    const match = DURATION_RE.exec(value)
    if (!match) return null
    return Math.round(Number(match[1]) * UNIT_MS[match[2].toLowerCase()])
}

function parseHM(value: string): { hour: number; minute: number } | null {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value)
    if (!m) return null
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (hour > 23 || minute > 59) return null
    return { hour, minute }
}

const WEEKDAYS: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
    thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}

function parseWeekdays(days: unknown): number[] | null {
    if (!Array.isArray(days) || days.length === 0) return null
    const out: number[] = []
    for (const d of days) {
        if (typeof d === 'number' && d >= 0 && d <= 6) { out.push(d); continue }
        if (typeof d === 'string') {
            const key = d.trim().toLowerCase()
            if (key in WEEKDAYS) { out.push(WEEKDAYS[key]); continue }
        }
        return null
    }
    return Array.from(new Set(out))
}

function normalizeSchedule(when: Record<string, unknown>): { spec: ScheduleSpec } | { error: string } {
    const tz = typeof when.timezone === 'string' && when.timezone.trim() ? when.timezone.trim() : SYSTEM_TZ
    const now = Date.now()

    if (typeof when.at === 'string' && when.at.trim()) {
        const ts = Date.parse(when.at)
        if (Number.isNaN(ts)) return { error: `Could not parse "at" time: ${when.at}` }
        if (ts <= now) return { error: 'The "at" time is in the past.' }
        return { spec: { kind: 'once', fireAt: ts } }
    }
    if (typeof when.in === 'string' && when.in.trim()) {
        const ms = parseDurationMs(when.in)
        if (ms == null || ms <= 0) return { error: `Could not parse "in" duration: ${when.in}` }
        return { spec: { kind: 'once', fireAt: now + ms } }
    }
    if (typeof when.daily_at === 'string' && when.daily_at.trim()) {
        const hm = parseHM(when.daily_at)
        if (!hm) return { error: `Could not parse "daily_at": ${when.daily_at}` }
        return { spec: { kind: 'dailyAt', hour: hm.hour, minute: hm.minute, timezone: tz } }
    }
    if (when.weekly_days !== undefined || (typeof when.weekly_at === 'string' && when.weekly_at)) {
        const weekdays = parseWeekdays(when.weekly_days)
        if (!weekdays) return { error: 'weekly_days must be a non-empty list like ["mon","wed"].' }
        const hm = typeof when.weekly_at === 'string' ? parseHM(when.weekly_at) : null
        if (!hm) return { error: 'weekly_at must be "HH:MM".' }
        return { spec: { kind: 'weeklyAt', weekdays, hour: hm.hour, minute: hm.minute, timezone: tz } }
    }
    if (typeof when.every === 'string' && when.every.trim()) {
        const ms = parseDurationMs(when.every)
        if (ms == null || ms < 60_000) return { error: 'every must be a duration of at least 1m.' }
        return { spec: { kind: 'every', everyMs: ms } }
    }
    if (typeof when.cron === 'string' && when.cron.trim()) {
        return { spec: { kind: 'cron', expression: when.cron.trim(), timezone: tz } }
    }
    return { error: 'No timing provided. Set one of: at, in, daily_at, every, weekly_days+weekly_at, cron.' }
}

function validMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function intervalAnchorForReschedule(task: ScheduledTask, next: Extract<ScheduleSpec, { kind: 'every' }>, ctx: ToolExecutionContext | undefined, now: number): number {
    if (task.schedule.kind === 'every' && validMs(task.schedule.startAt)) return task.schedule.startAt

    const scheduledFiredAt = ctx?.scheduledTaskId === task.id && validMs(ctx.scheduledFiredAt)
        ? ctx.scheduledFiredAt
        : null
    if (task.action.kind === 'monitor' && task.action.monitorKind === 'smart') {
        const base = scheduledFiredAt ?? (validMs(task.lastRunAt) ? task.lastRunAt : validMs(task.nextRunAt) ? task.nextRunAt : now + next.everyMs)
        return floorToMonitorSlot(base)
    }

    if (scheduledFiredAt !== null) return scheduledFiredAt
    if (task.schedule.kind === 'every' && validMs(task.nextRunAt)) return task.nextRunAt
    return now + next.everyMs
}

async function normalizeAction(action: Record<string, unknown>): Promise<{ action: ScheduledAction } | { error: string }> {
    const type = action.type
    if (type === 'agent') {
        const prompt = typeof action.prompt === 'string' ? action.prompt.trim() : ''
        if (!prompt) return { error: 'action.prompt is required for type "agent".' }
        const agentId = typeof action.agent_id === 'string' && action.agent_id.trim() ? action.agent_id.trim() : 'orchestrator'
        const { getAgent } = await import('@/lib/ai/agents/registry')
        if (!getAgent(agentId)) return { error: `Unknown agent_id: ${agentId}` }
        const adaptive = action.adaptive === true
        return { action: { kind: 'agent', agentId, prompt, adaptive } }
    }
    if (type === 'tool') {
        const toolId = typeof action.tool_id === 'string' ? action.tool_id.trim() : ''
        if (!toolId) return { error: 'action.tool_id is required for type "tool".' }
        const { getTool } = await import('@/lib/ai/tools/registry')
        if (!getTool(toolId)) return { error: `Unknown tool_id: ${toolId}` }
        const args = (action.tool_args && typeof action.tool_args === 'object' && !Array.isArray(action.tool_args))
            ? action.tool_args as Record<string, unknown>
            : {}
        const summary = typeof action.summary === 'string' && action.summary.trim()
            ? action.summary.trim()
            : `Run ${toolId}`
        return { action: { kind: 'tool', toolId, args, summary } }
    }
    return { error: 'action.type must be "tool" or "agent".' }
}

// --- executors -------------------------------------------------------------

export async function executeScheduleTask(args: Record<string, unknown>): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return { success: false, error: 'title is required.' }
    if (!args.when || typeof args.when !== 'object' || Array.isArray(args.when)) {
        return { success: false, error: 'when object is required.' }
    }
    if (!args.action || typeof args.action !== 'object' || Array.isArray(args.action)) {
        return { success: false, error: 'action object is required.' }
    }

    const sched = normalizeSchedule(args.when as Record<string, unknown>)
    if ('error' in sched) return { success: false, error: sched.error }
    const act = await normalizeAction(args.action as Record<string, unknown>)
    if ('error' in act) return { success: false, error: act.error }

    try {
        const { createScheduledTask } = await import('@/lib/scheduling/store')
        const task = createScheduledTask({
            title,
            action: act.action,
            schedule: sched.spec,
            enabled: true,
            createdBy: 'orchestrator',
        })
        return {
            success: true,
            data: {
                task_id: task.id,
                title: task.title,
                schedule: describeSchedule(task.schedule),
                next_run: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
                action: task.action.kind === 'tool'
                    ? { type: 'tool', tool: task.action.toolId }
                    : task.action.kind === 'monitor'
                        ? { type: 'monitor', monitor: task.action.monitorKind }
                        : { type: 'agent', agent: task.action.agentId },
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create scheduled task.' }
    }
}

export async function executeListTasks(): Promise<ToolResult> {
    const { listScheduledTasks } = await import('@/lib/scheduling/store')
    const tasks = listScheduledTasks().map(t => ({
        task_id: t.id,
        title: t.title,
        status: t.status,
        enabled: t.enabled,
        schedule: describeSchedule(t.schedule),
        action: t.action.kind === 'tool'
            ? `tool:${t.action.toolId}`
            : t.action.kind === 'monitor'
                ? `monitor:${t.action.monitorKind}`
                : `agent:${t.action.agentId}`,
        next_run: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
        last_run: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
        last_run_status: t.lastRunStatus,
    }))
    return { success: true, data: { count: tasks.length, tasks } }
}

export async function executeCancelTask(args: Record<string, unknown>): Promise<ToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (!taskId) return { success: false, error: 'task_id is required.' }
    const { deleteScheduledTask } = await import('@/lib/scheduling/store')
    const deleted = deleteScheduledTask(taskId)
    return deleted
        ? { success: true, data: { task_id: taskId, deleted: true } }
        : { success: false, error: `No scheduled task with id ${taskId}.` }
}

export const rescheduleTaskTool: ToolDef = {
    id: 'reschedule_task',
    name: 'reschedule_task',
    description: [
        'Change the cadence/timing of an existing scheduled task (keeps its history and state).',
        'For Smart Monitor, the agent starts from the consolidated heartbeat and chooses the next recurring cadence or wall-clock schedule itself.',
        'For the ongoing Smart Monitor task, use recurring timing (every/daily_at/weekly/cron), not one-shot in/at unless the user explicitly wants the task to stop after one more run.',
        'Use list_tasks to find the id; pass the same timing fields as schedule_task (in/at/daily_at/weekly/every/cron).',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'Id of the task to reschedule.' },
            when: {
                type: 'object',
                description: 'New timing — exactly one of: in, at, daily_at, every, cron, or weekly_days+weekly_at. timezone for wall-clock kinds.',
                properties: {
                    at: { type: 'string', description: 'One-shot absolute ISO 8601.' },
                    in: { type: 'string', description: 'One-shot relative: "90s","30m","7h","3d".' },
                    daily_at: { type: 'string', description: 'Recurring daily "HH:MM".' },
                    every: { type: 'string', description: 'Recurring fixed interval.' },
                    cron: { type: 'string', description: 'Recurring cron expression.' },
                    weekly_days: { type: 'array', items: { type: 'string' }, description: 'For weekly: ["mon","wed"].' },
                    weekly_at: { type: 'string', description: 'For weekly: "HH:MM".' },
                    timezone: { type: 'string', description: 'IANA timezone for daily_at/weekly/cron.' },
                },
            },
        },
        required: ['task_id', 'when'],
    },
    tags: ['scheduling'],
}

export async function executeRescheduleTask(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    if (!taskId) return { success: false, error: 'task_id is required.' }
    if (!args.when || typeof args.when !== 'object' || Array.isArray(args.when)) {
        return { success: false, error: 'when object is required.' }
    }
    const sched = normalizeSchedule(args.when as Record<string, unknown>)
    if ('error' in sched) return { success: false, error: sched.error }
    try {
        const { getScheduledTask, updateScheduledTask } = await import('@/lib/scheduling/store')
        const current = getScheduledTask(taskId)
        if (!current) return { success: false, error: `No scheduled task with id ${taskId}.` }
        const now = Date.now()
        const schedule =
            sched.spec.kind === 'every' && !validMs(sched.spec.startAt)
                ? {
                      ...sched.spec,
                      startAt: intervalAnchorForReschedule(current, sched.spec, ctx, now),
                  }
                : sched.spec
        const task = updateScheduledTask(taskId, { schedule })
        if (!task) return { success: false, error: `No scheduled task with id ${taskId}.` }
        return {
            success: true,
            data: {
                task_id: task.id,
                schedule: describeSchedule(task.schedule),
                next_run: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to reschedule task.' }
    }
}

export const scheduleTools: ToolDef[] = [scheduleTaskTool, listTasksTool, cancelTaskTool, rescheduleTaskTool]
