import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    deleteMonitorWatch,
    getMonitorWatch,
    updateMonitorWatch,
    type MonitorWatch,
} from '@/lib/monitor/store'
import { syncSmartMonitorActivation } from '@/lib/monitoring/smart-monitor-adapter'
import { describeAction, describeRule } from '@/lib/monitor/describe'
import { runWithRequestProfile } from "@/lib/profiles/server"

// Detail view — includes the structured rule + rendered description side by
// side, the full notify policy, raw state JSON (for debug), and every active
// suppress pattern with its rendered description and hit count.
function fullView(w: MonitorWatch) {
    return {
        id: w.id,
        title: w.title,
        source: w.source,
        target: w.target,
        enabled: w.enabled,
        rule: w.rule,
        rule_description: describeRule(w.rule),
        allowed_actions: w.allowedActions.map((a) => ({ raw: a, description: describeAction(a) })),
        cadence: w.cadence,
        notify: w.notify,
        state: w.state,
        suppress_patterns: w.suppressPatterns.map((p) => ({
            id: p.id,
            reason: p.reason,
            rule: p.rule,
            rule_description: describeRule(p.rule),
            created_at: p.createdAt,
            expires_at: p.expiresAt,
            match_count: p.matchCount,
            last_matched_at: p.lastMatchedAt,
        })),
        next_check_at: w.nextCheckAt,
        last_checked_at: w.lastCheckedAt,
        last_fired_at: w.lastFiredAt,
        consecutive_errors: w.consecutiveErrors,
        last_error: w.lastError,
        follow_up: w.followUp
            ? {
                expectation: w.followUp.expectation,
                deadline_at: w.followUp.deadlineAt,
                on_deadline: w.followUp.onDeadline,
                status: w.followUp.resolvedAt
                    ? ('resolved' as const)
                    : w.followUp.deadlineFiredAt
                        ? ('deadline_passed' as const)
                        : ('waiting' as const),
            }
            : null,
        created_by: w.createdBy,
        created_at: w.createdAt,
        updated_at: w.updatedAt,
    }
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || err instanceof SyntaxError
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(_request, async () => {
        try {
            const { id } = await params
            const w = getMonitorWatch(id)
            if (!w) return NextResponse.json({ error: 'Watch not found' }, { status: 404 })
            return NextResponse.json({ watch: fullView(w) })
        } catch (error) {
            console.error('Failed to get monitor watch', error)
            return NextResponse.json({ error: 'Failed to get watch' }, { status: 500 })
        }
  })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const { id } = await params
            const body = await request.json()
            const w = updateMonitorWatch(id, body)
            if (!w) return NextResponse.json({ error: 'Watch not found' }, { status: 404 })
            await syncSmartMonitorActivation()
            return NextResponse.json({ watch: fullView(w) })
        } catch (error) {
            if (isBadInput(error)) {
                return NextResponse.json(
                    { error: error instanceof Error ? error.message : 'Invalid update' },
                    { status: 400 },
                )
            }
            console.error('Failed to update monitor watch', error)
            return NextResponse.json({ error: 'Failed to update watch' }, { status: 500 })
        }
  })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const { id } = await params
            const ok = deleteMonitorWatch(id)
            if (!ok) return NextResponse.json({ error: 'Watch not found' }, { status: 404 })
            await syncSmartMonitorActivation()
            return NextResponse.json({ success: true })
        } catch (error) {
            console.error('Failed to delete monitor watch', error)
            return NextResponse.json({ error: 'Failed to delete watch' }, { status: 500 })
        }
  })
}
