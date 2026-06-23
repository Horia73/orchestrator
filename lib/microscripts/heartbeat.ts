import { runMicroscript } from './runner'
import {
    claimMicroscriptForRun,
    countRunnableMicroscripts,
    expireDueMicroscripts,
    listDueMicroscripts,
    recoverRunningMicroscripts,
    recoverStaleRunningMicroscripts,
} from './store'

const MICROSCRIPTS_HEARTBEAT_MS = 60_000
const MAX_SCRIPTS_PER_HEARTBEAT = 10

function desiredMicroscriptsSchedule(): { kind: 'every'; everyMs: number; startAt: number } {
    return {
        kind: 'every',
        everyMs: MICROSCRIPTS_HEARTBEAT_MS,
        startAt: Date.now() + MICROSCRIPTS_HEARTBEAT_MS,
    }
}

function needsScheduleRepair(schedule: unknown): boolean {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return true
    const spec = schedule as { kind?: unknown; everyMs?: unknown }
    if (spec.kind !== 'every') return true
    return typeof spec.everyMs !== 'number' || spec.everyMs < MICROSCRIPTS_HEARTBEAT_MS
}

export async function ensureMicroscriptsHeartbeat(options: { enabled: boolean }): Promise<void> {
    const { listScheduledTasks, createScheduledTask, updateScheduledTask } =
        await import('@/lib/scheduling/store')
    const existing = listScheduledTasks().find(
        (t) => t.action.kind === 'monitor' && t.action.monitorKind === 'microscripts',
    )
    if (existing) {
        if (existing.createdBy === 'system') {
            const patch: Parameters<typeof updateScheduledTask>[1] = {}
            if (existing.enabled !== options.enabled) patch.enabled = options.enabled
            if (needsScheduleRepair(existing.schedule)) patch.schedule = desiredMicroscriptsSchedule()
            if (Object.keys(patch).length > 0) updateScheduledTask(existing.id, patch)
        }
        return
    }
    createScheduledTask({
        title: 'Microscripts',
        action: { kind: 'monitor', monitorKind: 'microscripts' },
        schedule: desiredMicroscriptsSchedule(),
        enabled: options.enabled,
        createdBy: 'system',
    })
}

export function shouldEnableMicroscriptsHeartbeat(): boolean {
    return countRunnableMicroscripts() > 0
}

export async function syncMicroscriptsActivation(): Promise<void> {
    await ensureMicroscriptsHeartbeat({ enabled: shouldEnableMicroscriptsHeartbeat() })
}

export async function wireMicroscripts(): Promise<void> {
    recoverRunningMicroscripts()
    await syncMicroscriptsActivation()
}

export async function runMicroscriptsHeartbeat(options: { now: number }): Promise<{
    summary: string
    processed: number
    expired: number
    errors: number
}> {
    const now = options.now
    const recovered = recoverStaleRunningMicroscripts(now)
    const expired = expireDueMicroscripts(now)
    const due = listDueMicroscripts(now, MAX_SCRIPTS_PER_HEARTBEAT)
    let processed = 0
    let errors = 0

    for (const candidate of due) {
        const claimed = claimMicroscriptForRun(candidate.id, now)
        if (!claimed) continue
        processed += 1
        const result = await runMicroscript(claimed, { trigger: 'schedule', now })
        if (!result.ok) errors += 1
    }

    const parts = [
        `Microscripts heartbeat: ${processed} run(s)`,
        `${expired.length} expired`,
    ]
    if (recovered.length > 0) parts.push(`${recovered.length} stale recovered`)
    if (errors > 0) parts.push(`${errors} error(s)`)
    if (due.length >= MAX_SCRIPTS_PER_HEARTBEAT) {
        parts.push(`hit per-heartbeat cap ${MAX_SCRIPTS_PER_HEARTBEAT}`)
    }
    return {
        summary: `${parts.join(', ')}.`,
        processed,
        expired: expired.length,
        errors,
    }
}
