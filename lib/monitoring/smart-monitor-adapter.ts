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

import { countEnabledWatches } from '../monitor/store'
import { SMART_MONITOR_POLL_INTERVAL_MS } from './smart-monitor-cheap-pass'

// ---------------------------------------------------------------------------
// System task lifecycle
// ---------------------------------------------------------------------------

/** Fixed Smart Monitor cheap-poll cadence. The task runs the no-model cheap
 *  pass (lib/monitoring/smart-monitor-cheap-pass.ts) at this interval and gates
 *  the AI wake itself. The agent no longer reschedules this task; it tunes its
 *  wake floor/ceiling via minWakeGapMs/maxWakeGapMs in task_state instead. So
 *  boot reconciliation now PINS the cadence to this value (mirrors the markets
 *  heartbeat), rather than honouring an agent-chosen interval. */
const SMART_POLL_INTERVAL_MS = SMART_MONITOR_POLL_INTERVAL_MS

function desiredSmartMonitorSchedule(): { kind: 'every'; everyMs: number } {
    return {
        kind: 'every',
        everyMs: SMART_POLL_INTERVAL_MS,
    }
}

function validMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Return a corrected schedule when the existing one drifts from the fixed
 *  cheap cadence (e.g. a legacy 15-minute or agent-rescheduled task), else
 *  null when it is already correct. */
function repairedSmartMonitorSchedule(existing: {
    schedule: unknown
    nextRunAt: number | null
    lastRunAt: number | null
}): { kind: 'every'; everyMs: number } | null {
    const schedule = existing.schedule
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return desiredSmartMonitorSchedule()
    const spec = schedule as { kind?: unknown; everyMs?: unknown }
    if (spec.kind !== 'every') return desiredSmartMonitorSchedule()
    if (!validMs(spec.everyMs) || spec.everyMs !== SMART_POLL_INTERVAL_MS) {
        return desiredSmartMonitorSchedule()
    }
    return null
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
