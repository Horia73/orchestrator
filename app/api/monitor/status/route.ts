import { NextResponse } from 'next/server'
import { countEnabledWatches, getNextDueTime, listMonitorWatches } from '@/lib/monitor/store'
import { syncSmartMonitorActivation } from '@/lib/monitoring/smart-monitor-adapter'
import { listScheduledTasks } from '@/lib/scheduling/store'

// Header status endpoint for the /monitor page. Returns:
//   - heartbeat: whether the consolidated system task exists, its enabled
//     state, last run time, next fire estimate
//   - counts: how many watches are enabled / paused / errored
//   - next_due_at: earliest pending nextCheckAt across all enabled watches
//
// Read-only; fast (one COUNT + one list of system tasks).
export async function GET() {
    try {
        // Self-heal stale heartbeat state before reporting status. This covers
        // cases where watches are enabled but the system task stayed paused
        // because the app missed the watch-change event.
        await syncSmartMonitorActivation()

        const tasks = listScheduledTasks().filter(
            (t) => t.action.kind === 'monitor' && t.action.monitorKind === 'smart',
        )
        const heartbeat = tasks[0]
            ? {
                  id: tasks[0].id,
                  enabled: tasks[0].enabled,
                  status: tasks[0].status,
                  next_run_at: tasks[0].nextRunAt,
                  last_run_at: tasks[0].lastRunAt,
                  last_run_status: tasks[0].lastRunStatus,
                  last_run_error: tasks[0].lastRunError,
                  schedule: tasks[0].schedule,
              }
            : null

        const enabledCount = countEnabledWatches()
        const allWatches = listMonitorWatches()
        const erroredCount = allWatches.filter(
            (w) => w.enabled && w.consecutiveErrors > 0,
        ).length

        return NextResponse.json({
            heartbeat,
            counts: {
                total: allWatches.length,
                enabled: enabledCount,
                paused: allWatches.length - enabledCount,
                errored: erroredCount,
            },
            next_due_at: getNextDueTime(),
        })
    } catch (error) {
        console.error('Failed to load monitor status', error)
        return NextResponse.json({ error: 'Failed to load status' }, { status: 500 })
    }
}
