import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    createMonitorWatch,
    listMonitorWatches,
    type MonitorWatch,
} from '@/lib/monitor/store'
import { syncSmartMonitorActivation } from '@/lib/monitoring/smart-monitor-adapter'
import { describeAction, describeRule } from '@/lib/monitor/describe'
import { WatchSourceSchema } from '@/lib/monitor/schema'
import { runWithRequestProfile } from "@/lib/profiles/server"

// Compact row shared between list + create response. The /monitor page never
// needs the entire MonitorWatch shape in the table view — full detail lives
// in GET /api/monitor/watches/[id].
function compactRow(w: MonitorWatch) {
    return {
        id: w.id,
        title: w.title,
        source: w.source,
        target: w.target,
        rule_description: describeRule(w.rule),
        enabled: w.enabled,
        cadence_seconds: w.cadence.current,
        cadence_adaptive: w.cadence.adaptive,
        allowed_action_count: w.allowedActions.length,
        allowed_actions: w.allowedActions.map(describeAction),
        suppress_pattern_count: w.suppressPatterns.length,
        next_check_at: w.nextCheckAt,
        last_checked_at: w.lastCheckedAt,
        last_fired_at: w.lastFiredAt,
        consecutive_errors: w.consecutiveErrors,
        last_error: w.lastError,
        active_runs: w.state.activeRuns,
        quiet_runs: w.state.quietRuns,
        notify_quiet_hours: w.notify.quietHours ?? null,
        created_by: w.createdBy,
        created_at: w.createdAt,
        updated_at: w.updatedAt,
    }
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || name === 'DuplicateMonitorSourceError' || err instanceof SyntaxError
}

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        try {
            const url = new URL(request.url)
            const sourceParam = url.searchParams.get('source')
            const enabledParam = url.searchParams.get('enabled')

            const filter: { source?: ReturnType<typeof WatchSourceSchema.parse>; enabled?: boolean } = {}
            if (sourceParam) {
                const parsed = WatchSourceSchema.safeParse(sourceParam)
                if (!parsed.success) {
                    return NextResponse.json(
                        { error: `Unknown source "${sourceParam}".` },
                        { status: 400 },
                    )
                }
                filter.source = parsed.data
            }
            if (enabledParam === 'true') filter.enabled = true
            else if (enabledParam === 'false') filter.enabled = false

            const watches = listMonitorWatches(filter).map(compactRow)
            return NextResponse.json({ watches })
        } catch (error) {
            console.error('Failed to list monitor watches', error)
            return NextResponse.json({ error: 'Failed to list watches' }, { status: 500 })
        }
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const body = await request.json()
            const watch = createMonitorWatch(body)
            await syncSmartMonitorActivation()
            return NextResponse.json({ watch: compactRow(watch) })
        } catch (error) {
            if (isBadInput(error)) {
                return NextResponse.json(
                    { error: error instanceof Error ? error.message : 'Invalid watch' },
                    { status: 400 },
                )
            }
            console.error('Failed to create monitor watch', error)
            return NextResponse.json({ error: 'Failed to create watch' }, { status: 500 })
        }
  })
}
