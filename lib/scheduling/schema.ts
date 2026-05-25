import { z } from 'zod'

// ---------------------------------------------------------------------------
// Scheduling domain schema.
//
// A scheduled task is a (schedule) + (action) pair:
//   - schedule: WHEN it fires — one-shot or recurring (presets or raw cron).
//   - action:   WHAT fires — wake an agent with a prompt, OR run one tool
//               deterministically (no model). The orchestrator decides which
//               at creation time: deterministic deferred work ("turn on the
//               light in 7h") is a `tool` action; work that needs reasoning
//               at fire time ("summarize today's email") is an `agent` action.
//
// This module imports nothing but zod — it sits at the bottom of the import
// graph so the tool registry and store can both depend on it without cycles.
// ---------------------------------------------------------------------------

const Timezone = z.string().min(1).max(64)

/** WHEN a task fires. `once.fireAt` is always an absolute epoch (ms); relative
 *  inputs ("in 7h") are normalized to absolute at creation. */
export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('once'),
        /** Absolute epoch ms. */
        fireAt: z.number().int().positive(),
    }),
    z.object({
        kind: z.literal('every'),
        /** Fixed interval, >= 60s to avoid runaway loops. */
        everyMs: z.number().int().min(60_000),
        /** Optional first-fire anchor (epoch ms). Defaults to now + everyMs. */
        startAt: z.number().int().positive().optional(),
    }),
    z.object({
        kind: z.literal('dailyAt'),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        timezone: Timezone,
    }),
    z.object({
        kind: z.literal('weeklyAt'),
        /** 0 = Sunday .. 6 = Saturday. */
        weekdays: z.array(z.number().int().min(0).max(6)).min(1),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        timezone: Timezone,
    }),
    z.object({
        kind: z.literal('cron'),
        /** Standard 5- or 6-field cron expression. */
        expression: z.string().min(1).max(120),
        timezone: Timezone,
    }),
])
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>

/** WHAT a task does when it fires. */
export const ScheduledActionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('agent'),
        /** Agent to wake. Defaults to the orchestrator, which can delegate. */
        agentId: z.string().min(1).max(64).default('orchestrator'),
        /** Instruction sent to the agent at fire time. */
        prompt: z.string().min(1).max(8000),
        /** Opt-in: at fire time the run is told it MAY self-pace via reschedule_task
         *  (tier widen on quiet runs, tighten on activity). Off by default: a fixed
         *  cadence the user explicitly chose ("daily at 8am") must NOT be retuned by
         *  the model. Only set true when the user accepted flexible/adaptive timing. */
        adaptive: z.boolean().optional().default(false),
    }),
    z.object({
        kind: z.literal('tool'),
        /** Registry tool id, e.g. "HomeAssistantSetLight". */
        toolId: z.string().min(1).max(96),
        /** Arguments passed verbatim to the tool. Resolved now, not at fire time. */
        args: z.record(z.string(), z.unknown()).default({}),
        /** Human-readable one-liner of what this does (shown in UI + Inbox). */
        summary: z.string().min(1).max(200),
    }),
    z.object({
        kind: z.literal('monitor'),
        /** Which consolidated monitor this heartbeat drives. System-managed.
         *  - `markets` → Watchlist's market-data tick (lib/monitoring/markets-heartbeat.ts)
         *  - `smart`   → Smart Monitor scheduled agent wake across all watches */
        monitorKind: z.enum(['markets', 'smart']),
    }),
])
export type ScheduledAction = z.infer<typeof ScheduledActionSchema>

export const ScheduledTaskStatusSchema = z.enum([
    'scheduled', // armed, waiting for nextRunAt
    'running',   // currently executing a fire
    'done',      // one-shot completed
    'error',     // last fire failed (recurring tasks keep their schedule)
    'missed',    // one-shot whose fireAt passed while the server was down
    'paused',    // disabled by the user
])
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatusSchema>

export const ScheduledTaskCreatedBySchema = z.enum(['user', 'orchestrator', 'system'])
export type ScheduledTaskCreatedBy = z.infer<typeof ScheduledTaskCreatedBySchema>

/** Full persisted/returned shape. */
export const ScheduledTaskSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    enabled: z.boolean(),
    status: ScheduledTaskStatusSchema,
    action: ScheduledActionSchema,
    schedule: ScheduleSpecSchema,
    nextRunAt: z.number().int().positive().nullable(),
    lastRunAt: z.number().int().positive().nullable(),
    lastRunStatus: z.enum(['ok', 'error', 'missed']).nullable(),
    lastRunError: z.string().nullable(),
    lastConversationId: z.string().nullable(),
    runCount: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    createdBy: ScheduledTaskCreatedBySchema,
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
})
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>

/** Accepted on create (from the UI form or the schedule_task tool). */
export const CreateScheduledTaskInputSchema = z.object({
    title: z.string().min(1).max(200),
    action: ScheduledActionSchema,
    schedule: ScheduleSpecSchema,
    enabled: z.boolean().default(true),
    createdBy: ScheduledTaskCreatedBySchema.default('user'),
})
export type CreateScheduledTaskInput = z.input<typeof CreateScheduledTaskInputSchema>

/** Accepted on update — every field optional; schedule/action replaced wholesale. */
export const UpdateScheduledTaskInputSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    action: ScheduledActionSchema.optional(),
    schedule: ScheduleSpecSchema.optional(),
    enabled: z.boolean().optional(),
})
export type UpdateScheduledTaskInput = z.infer<typeof UpdateScheduledTaskInputSchema>
