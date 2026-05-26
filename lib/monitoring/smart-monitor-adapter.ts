// Smart Monitor system-task adapter — mirrors lib/monitoring/watchlist-adapter.ts.
//
// Owns the single "Smart monitor" system task in Scheduling: creates it
// idempotently, keeps its enabled state in sync with whether there's anything
// to actually do (≥1 enabled watch), and exposes a `wireSmartMonitor()`
// entry called once at boot from instrumentation.ts.
//
// The scheduled run wakes the orchestrator with context from
// lib/monitoring/smart-monitor.ts; this adapter is just the bridge between the
// watch store and the scheduler's system-task surface.

import {
    floorToMonitorSlot,
    isMonitorSlotAligned,
    nextMonitorSlotAfter,
    MONITOR_CADENCE_STEP_MS,
} from '../monitor/cadence'
import { countEnabledWatches } from '../monitor/store'

// ---------------------------------------------------------------------------
// System task lifecycle
// ---------------------------------------------------------------------------

/** Default Smart Monitor wake cadence. The agent may later reschedule this
 *  single system task; boot reconciliation only repairs invalid schedules and
 *  does not force a valid agent-chosen cadence back to 15 minutes. */
const SMART_DEFAULT_INTERVAL_MS = MONITOR_CADENCE_STEP_MS

function desiredSmartMonitorSchedule(): { kind: 'every'; everyMs: number; startAt: number } {
    return {
        kind: 'every',
        everyMs: SMART_DEFAULT_INTERVAL_MS,
        startAt: nextMonitorSlotAfter(Date.now()),
    }
}

function validMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function snappedIntervalMs(value: number): number {
    const snapped = Math.round(value / MONITOR_CADENCE_STEP_MS) * MONITOR_CADENCE_STEP_MS
    return Math.max(MONITOR_CADENCE_STEP_MS, snapped)
}

function repairedSmartMonitorSchedule(existing: {
    schedule: unknown
    nextRunAt: number | null
    lastRunAt: number | null
}): { kind: 'every'; everyMs: number; startAt: number } | null {
    const schedule = existing.schedule
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return desiredSmartMonitorSchedule()
    const spec = schedule as {
        kind?: unknown
        everyMs?: unknown
        startAt?: unknown
        fireAt?: unknown
    }
    if (spec.kind === 'once') return desiredSmartMonitorSchedule()
    if (spec.kind !== 'every') return null
    if (!validMs(spec.everyMs)) return desiredSmartMonitorSchedule()

    const everyMs = snappedIntervalMs(spec.everyMs)
    const startAt = validMs(spec.startAt) && isMonitorSlotAligned(spec.startAt)
        ? spec.startAt
        : floorToMonitorSlot(
            validMs(existing.lastRunAt)
                ? existing.lastRunAt
                : validMs(existing.nextRunAt)
                    ? existing.nextRunAt
                    : nextMonitorSlotAfter(Date.now()),
        )
    if (everyMs === spec.everyMs && startAt === spec.startAt) return null
    return { kind: 'every', everyMs, startAt }
}

/**
 * Idempotently create the single system "Smart monitor" agent wake task and
 * (re)align its enabled state with `shouldEnableSmartMonitor()`. Called at
 * boot AND after any change to a watch (so toggling the last watch off
 * disables the task; turning a watch on re-arms it).
 */
export async function ensureSmartMonitorHeartbeat(options: {
    enabled: boolean
}): Promise<void> {
    const { listScheduledTasks, createScheduledTask, updateScheduledTask } =
        await import('@/lib/scheduling/store')

    const existing = listScheduledTasks().find(
        (t) => t.action.kind === 'monitor' && t.action.monitorKind === 'smart',
    )
    if (existing) {
        if (existing.createdBy === 'system') {
            const patch: Parameters<typeof updateScheduledTask>[1] = {}
            if (existing.enabled !== options.enabled) patch.enabled = options.enabled
            const repairedSchedule = repairedSmartMonitorSchedule(existing)
            if (repairedSchedule) patch.schedule = repairedSchedule
            if (Object.keys(patch).length > 0) {
                updateScheduledTask(existing.id, patch)
            }
        }
        return
    }
    createScheduledTask({
        title: 'Smart monitor',
        action: { kind: 'monitor', monitorKind: 'smart' },
        schedule: desiredSmartMonitorSchedule(),
        enabled: options.enabled,
        createdBy: 'system',
    })
}

/** Should the system task be enabled? Yes iff the user has at least one
 *  enabled watch. With zero watches the task exists but is paused — zero
 *  cost at zero configuration. */
export function shouldEnableSmartMonitor(): boolean {
    return countEnabledWatches() > 0
}

/** Reconcile the system task's enabled state against the current watch
 *  store. Called by any code path that creates/updates/deletes a watch
 *  (the watch store fires `monitor_watches.changed` — wire a listener at
 *  the API/UI layer in Step 8). Safe to call repeatedly. */
export async function syncSmartMonitorActivation(): Promise<void> {
    await ensureSmartMonitorHeartbeat({ enabled: shouldEnableSmartMonitor() })
}

/** Idempotent boot entry. Creates the system task (paused if no watches yet)
 *  and keeps any valid agent-managed schedule intact. */
export async function wireSmartMonitor(): Promise<void> {
    await syncSmartMonitorActivation()
}
