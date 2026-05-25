import type { ScheduledTask } from './schema'
import {
    claimForRun,
    finishRun,
    getDueCandidates,
    getScheduledTask,
    markMissed,
    markTaskError,
    recordManualRun,
    recoverStuckRunning,
} from './store'

// ---------------------------------------------------------------------------
// The scheduler tick. This is the ONLY long-lived background loop in the app.
// It is registered once from instrumentation.ts at server boot and guarded by
// a globalThis singleton so dev HMR / repeated imports cannot stack intervals.
// ---------------------------------------------------------------------------

const TICK_MS = 30_000

// A one-shot overdue by more than this was missed while the server was down:
// we do NOT run stale real-world actions late — we mark them missed and post
// an Inbox notice. Smaller overdue (slow tick / brief restart) still runs.
const MISSED_GRACE_MS = 5 * 60_000

interface SchedulerState {
    started: boolean
    timer: ReturnType<typeof setInterval> | null
    ticking: boolean
    inFlight: Set<string>
}

const g = globalThis as unknown as { __orchestratorScheduler?: SchedulerState }
const state: SchedulerState = g.__orchestratorScheduler ?? {
    started: false,
    timer: null,
    ticking: false,
    inFlight: new Set<string>(),
}
g.__orchestratorScheduler = state

function log(msg: string): void {
    console.log(`[scheduler] ${msg}`)
}

async function executeAndFinish(task: ScheduledTask, isOnce: boolean, firedAt: number): Promise<void> {
    state.inFlight.add(task.id)
    try {
        const { runScheduledTask } = await import('./run')
        const result = await runScheduledTask(task, firedAt)
        finishRun(task.id, {
            ok: result.ok,
            isOnce,
            conversationId: result.conversationId,
            error: result.error,
            nowMs: Date.now(),
        })
        log(`ran "${task.title}" (${task.id}) → ${result.ok ? 'ok' : 'error'}`)
    } catch (err) {
        finishRun(task.id, {
            ok: false,
            isOnce,
            conversationId: null,
            error: err instanceof Error ? err.message : 'Unknown error',
            nowMs: Date.now(),
        })
    } finally {
        state.inFlight.delete(task.id)
    }
}

async function tick(): Promise<void> {
    if (state.ticking) return
    state.ticking = true
    try {
        const now = Date.now()
        const due = getDueCandidates(now)
        for (const task of due) {
            if (state.inFlight.has(task.id)) continue

            // One-shot that came due while we were offline → missed, not run.
            if (
                task.schedule.kind === 'once' &&
                task.nextRunAt != null &&
                now - task.nextRunAt > MISSED_GRACE_MS
            ) {
                const missed = markMissed(task.id, now)
                if (missed) {
                    try {
                        const { postInboxNotice } = await import('./run')
                        postInboxNotice(
                            missed,
                            `⚠️ Missed scheduled task **${missed.title}** — it was due ${new Date(
                                task.nextRunAt,
                            ).toISOString()} but the app was not running. It was not executed.`,
                        )
                    } catch { /* notice best-effort */ }
                    log(`missed "${missed.title}" (${missed.id})`)
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
            void executeAndFinish(claimed.task, claimed.isOnce, now)
        }
    } catch (err) {
        log(`tick error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
        state.ticking = false
    }
}

/** Idempotent. Safe to call repeatedly (HMR, multiple imports). */
export function startScheduler(): void {
    if (state.started) return
    state.started = true

    try {
        const recovered = recoverStuckRunning(Date.now())
        if (recovered.length > 0) {
            void import('./run')
                .then(({ postInboxNotice }) => {
                    for (const task of recovered) {
                        try {
                            postInboxNotice(
                                task,
                                `⚠️ Scheduled task **${task.title}** was interrupted by a restart and did not complete. It was not re-run.`,
                            )
                        } catch { /* best-effort */ }
                    }
                })
                .catch(() => { /* best-effort */ })
        }
        if (recovered.length > 0) log(`recovered ${recovered.length} interrupted one-shot task(s)`)
    } catch (err) {
        log(`boot recovery failed: ${err instanceof Error ? err.message : String(err)}`)
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
    if (state.inFlight.has(id)) {
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

    state.inFlight.add(id)
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
        state.inFlight.delete(id)
    }
}
