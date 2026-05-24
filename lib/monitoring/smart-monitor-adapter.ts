// Smart Monitor system-task adapter — mirrors lib/monitoring/watchlist-adapter.ts.
//
// Owns the single "Smart monitor" system task in Scheduling: creates it
// idempotently, keeps its enabled state in sync with whether there's anything
// to actually do (≥1 enabled watch), and exposes a `wireSmartMonitor()`
// entry called once at boot from instrumentation.ts.
//
// The engine itself (lib/monitoring/smart-monitor.ts) does the work; this
// adapter is just the bridge between the watch store and the scheduler's
// system-task surface.

import { nextMonitorSlotAfter, isMonitorSlotAligned, MONITOR_CADENCE_STEP_MS } from '../monitor/cadence'
import { countEnabledWatches } from '../monitor/store'

// ---------------------------------------------------------------------------
// System task lifecycle
// ---------------------------------------------------------------------------

/** Master tick cadence for the cheap loop. Fixed at 15 minutes and aligned
 *  to wall-clock quarter-hour slots (:00/:15/:30/:45). Per-watch cadences are
 *  adaptive, but they are also quantized to these slots so one model wake can
 *  batch every due integration. */
const SMART_TICK_INTERVAL_MS = MONITOR_CADENCE_STEP_MS

function desiredSmartMonitorSchedule(): { kind: 'every'; everyMs: number; startAt: number } {
    return {
        kind: 'every',
        everyMs: SMART_TICK_INTERVAL_MS,
        startAt: nextMonitorSlotAfter(Date.now()),
    }
}

function needsScheduleRealignment(schedule: unknown): boolean {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return true
    const spec = schedule as { kind?: unknown; everyMs?: unknown; startAt?: unknown }
    if (spec.kind !== 'every') return true
    if (spec.everyMs !== SMART_TICK_INTERVAL_MS) return true
    return typeof spec.startAt !== 'number' || !isMonitorSlotAligned(spec.startAt)
}

/**
 * Idempotently create the single system "Smart monitor" heartbeat task and
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
            if (needsScheduleRealignment(existing.schedule)) {
                patch.schedule = desiredSmartMonitorSchedule()
            }
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
 *  and lines up the next tick. */
export async function wireSmartMonitor(): Promise<void> {
    await syncSmartMonitorActivation()
}
