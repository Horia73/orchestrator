import type { ScheduledTask } from './schema'
import {
    claimForRun,
    finishRun,
    getDueCandidates,
    getScheduledTask,
    markMissed,
    markTaskError,
    pruneTerminalOneShots,
    recordManualRun,
    recoverStuckRunning,
} from './store'
import { getActiveProfileId, runWithProfileContext } from '@/lib/profiles/context'
import { listProfiles } from '@/lib/profiles/store'

// ---------------------------------------------------------------------------
// The scheduler tick. This is the ONLY long-lived background loop in the app.
// It is registered once from instrumentation.ts at server boot and guarded by
// a globalThis singleton so dev HMR / repeated imports cannot stack intervals.
// ---------------------------------------------------------------------------

const TICK_MS = 30_000

// A one-shot overdue by more than this came due while the server was down: we
// do NOT silently run a stale real-world action late. We mark it missed and wake
// the agent to assess whether doing it late still makes sense (see the missed
// branch). Smaller overdue (slow tick / brief restart) still runs normally.
const MISSED_GRACE_MS = 5 * 60_000

// How often the tick sweeps terminal one-shots past their retention window. The
// prune itself is cheap; throttling just avoids needless writes/events.
const PRUNE_INTERVAL_MS = 30 * 60_000

interface SchedulerState {
    started: boolean
    timer: ReturnType<typeof setInterval> | null
    ticking: boolean
    inFlight: Set<string>
    lastPruneAt: number
}

const g = globalThis as unknown as { __orchestratorScheduler?: SchedulerState }
const state: SchedulerState = g.__orchestratorScheduler ?? {
    started: false,
    timer: null,
    ticking: false,
    inFlight: new Set<string>(),
    lastPruneAt: 0,
}
// Survive an HMR reload that carried over an older state shape without the field.
if (typeof state.lastPruneAt !== 'number') state.lastPruneAt = 0
g.__orchestratorScheduler = state

function log(msg: string): void {
    console.log(`[scheduler] ${msg}`)
}

function taskRunKey(profileId: string, taskId: string): string {
    return `${profileId}:${taskId}`
}

async function executeAndFinish(profileId: string, task: ScheduledTask, isOnce: boolean, firedAt: number): Promise<void> {
    const key = taskRunKey(profileId, task.id)
    state.inFlight.add(key)
    // A failed one-shot agent/tool action is handed to the recovery wake instead
    // of dying with a raw error. (Recurring tasks re-fire on their own cadence;
    // monitors have their own handling — neither escalates here.)
    const escalateOnError = isOnce && (task.action.kind === 'agent' || task.action.kind === 'tool')
    try {
        await runWithProfileContext({ profileId }, async () => {
            const { runScheduledTask, runSchedulerEscalation } = await import('./run')
            const result = await runScheduledTask(task, firedAt, {
                trigger: 'schedule',
                suppressAutoErrorSurface: escalateOnError,
            })
            finishRun(task.id, {
                ok: result.ok,
                isOnce,
                conversationId: result.conversationId,
                error: result.error,
                nowMs: Date.now(),
            })
            log(`ran "${task.title}" (${task.id}, ${profileId}) → ${result.ok ? 'ok' : 'error'}`)
            if (!result.ok && escalateOnError) {
                log(`escalating failed one-shot "${task.title}" (${task.id}) to the agent`)
                try {
                    await runSchedulerEscalation(task, { kind: 'errored', error: result.error }, Date.now())
                } catch (escErr) {
                    log(`escalation failed for ${task.id}: ${escErr instanceof Error ? escErr.message : String(escErr)}`)
                }
            }
        })
    } catch (err) {
        runWithProfileContext({ profileId }, () => {
            finishRun(task.id, {
                ok: false,
                isOnce,
                conversationId: null,
                error: err instanceof Error ? err.message : 'Unknown error',
                nowMs: Date.now(),
            })
        })
    } finally {
        state.inFlight.delete(key)
    }
}

async function tick(): Promise<void> {
    if (state.ticking) return
    state.ticking = true
    try {
        for (const profile of listProfiles()) {
            await runWithProfileContext(
                { profileId: profile.id, role: profile.role },
                () => tickProfile(profile.id)
            )
        }

        // Periodic housekeeping: drop terminal one-shots past their retention
        // window so completed/missed/failed throwaway tasks don't pile up.
        const now = Date.now()
        if (now - state.lastPruneAt >= PRUNE_INTERVAL_MS) {
            state.lastPruneAt = now
            for (const profile of listProfiles()) {
                try {
                    runWithProfileContext(
                        { profileId: profile.id, role: profile.role },
                        () => {
                            const pruned = pruneTerminalOneShots(now)
                            if (pruned.length > 0) {
                                log(`pruned ${pruned.length} terminal one-shot task(s) for ${profile.id}`)
                            }
                        }
                    )
                } catch (err) {
                    log(`prune failed for ${profile.id}: ${err instanceof Error ? err.message : String(err)}`)
                }
            }
        }
    } catch (err) {
        log(`tick error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
        state.ticking = false
    }
}

async function tickProfile(profileId: string): Promise<void> {
    const now = Date.now()
    const due = getDueCandidates(now)
    for (const task of due) {
        if (state.inFlight.has(taskRunKey(profileId, task.id))) continue

        // One-shot that came due while we were offline → missed, not run on
        // its original schedule. Instead of a dead "it was not executed"
        // notice, wake the agent to assess whether doing it late still makes
        // sense (benign/idempotent actions may be carried out; stale or risky
        // ones are surfaced for the user to decide).
        if (
            task.schedule.kind === 'once' &&
            task.nextRunAt != null &&
            now - task.nextRunAt > MISSED_GRACE_MS
        ) {
            const dueAt = task.nextRunAt
            const missed = markMissed(task.id, now)
            if (missed) {
                log(`missed "${missed.title}" (${missed.id}, ${profileId})`)
                const key = taskRunKey(profileId, task.id)
                if (!state.inFlight.has(key)) {
                    state.inFlight.add(key)
                    void runWithProfileContext({ profileId }, async () => {
                        try {
                            const { runSchedulerEscalation } = await import('./run')
                            await runSchedulerEscalation(missed, { kind: 'missed', dueAt }, now)
                            log(`assessed missed one-shot "${missed.title}" (${missed.id}, ${profileId})`)
                        } catch (err) {
                            // Fall back to a passive notice so the miss is never silent.
                            try {
                                const { postInboxNotice } = await import('./run')
                                postInboxNotice(
                                    missed,
                                    `⚠️ Missed scheduled task **${missed.title}** — it was due ${new Date(
                                        dueAt,
                                    ).toISOString()} but the app was not running.`,
                                )
                            } catch { /* notice best-effort */ }
                            log(`missed-assessment failed for ${missed.id}: ${err instanceof Error ? err.message : String(err)}`)
                        } finally {
                            state.inFlight.delete(key)
                        }
                    })
                }
            }
            continue
        }

        let claimed
        try {
            claimed = claimForRun(task.id, now)
        } catch (err) {
            markTaskError(task.id, err instanceof Error ? err.message : 'Schedule compute failed', now)
            continue
        }
        if (!claimed) continue
        void executeAndFinish(profileId, claimed.task, claimed.isOnce, now)
    }
}

/** Idempotent. Safe to call repeatedly (HMR, multiple imports). */
export function startScheduler(): void {
    if (state.started) return
    state.started = true

    for (const profile of listProfiles()) {
        try {
            const recovered = runWithProfileContext(
                { profileId: profile.id, role: profile.role },
                () => recoverStuckRunning(Date.now())
            )
            if (recovered.length > 0) {
                void import('./run')
                    .then(({ postInboxNotice }) => {
                        for (const task of recovered) {
                            try {
                                runWithProfileContext(
                                    { profileId: profile.id, role: profile.role },
                                    () => postInboxNotice(
                                        task,
                                        `⚠️ Scheduled task **${task.title}** was interrupted by a restart and did not complete. It was not re-run.`,
                                    )
                                )
                            } catch { /* best-effort */ }
                        }
                    })
                    .catch(() => { /* best-effort */ })
                log(`recovered ${recovered.length} interrupted one-shot task(s) for ${profile.id}`)
            }
        } catch (err) {
            log(`boot recovery failed for ${profile.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    state.timer = setInterval(() => { void tick() }, TICK_MS)
    // First sweep shortly after boot so already-due tasks don't wait a full tick.
    setTimeout(() => { void tick() }, 4_000)
    log(`started (tick ${TICK_MS / 1000}s)`)
}

/**
 * Manual "Run now" for a single task. Bypasses the due check and does NOT
 * consume/disarm the schedule (a test run shouldn't mark a one-shot done).
 */
export async function runTaskNow(id: string): Promise<{ ok: boolean; conversationId: string | null; error?: string }> {
    const profileId = getActiveProfileId()
    const key = taskRunKey(profileId, id)
    if (state.inFlight.has(key)) {
        return { ok: false, conversationId: null, error: 'Task is already running.' }
    }
    const task = getScheduledTask(id)
    if (!task) return { ok: false, conversationId: null, error: 'Task not found.' }
    if (task.action.kind === 'monitor' && task.action.monitorKind === 'smart') {
        return {
            ok: false,
            conversationId: null,
            error: 'Smart Monitor runs automatically; manual checks are disabled.',
        }
    }

    state.inFlight.add(key)
    try {
        const now = Date.now()
        const { runScheduledTask } = await import('./run')
        const result = await runScheduledTask(task, now, { trigger: 'manual' })
        recordManualRun(id, {
            ok: result.ok,
            conversationId: result.conversationId,
            error: result.error,
            nowMs: Date.now(),
        })
        return { ok: result.ok, conversationId: result.conversationId, error: result.error }
    } finally {
        state.inFlight.delete(key)
    }
}
