"use client"

import * as React from "react"
import { CheckCircle2, Cloud, CloudOff, ListChecks, RotateCcw, Sparkles, Star, Timer, Trophy, XCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutArtifact } from "@/lib/workout/schema"
import { buildSessionLog, type PrEvent, type SessionLog } from "@/lib/workout/save-session"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"
import { formatDuration } from "@/lib/workout/format"

/**
 * Post-finish summary card.
 *
 * Mounts when `sessionApi.isFinished` is true. Auto-fires the save-session
 * API on first mount, then shows:
 *   - Header strip with totals (time, sets, tonnage)
 *   - PRs detected (auriu, highlighted)
 *   - Per-exercise actuals vs planned
 *   - Save status (Saving… / Saved ✓ / Failed)
 *   - "Start again" reset
 *
 * Save status falls back gracefully if the API isn't reachable (preview
 * pages, offline). The session is still in localStorage; the user can hit
 * "Try again" to retry.
 */
export function SessionSummary({
    workout,
    sessionApi,
    artifactId,
    className,
}: {
    workout: WorkoutArtifact
    sessionApi: WorkoutSessionApi
    /** Stable artifact row id — required for the save API. When missing
     *  (e.g. dev preview without a backing artifact), we skip the save. */
    artifactId?: string
    className?: string
}) {
    const log = React.useMemo<SessionLog>(
        () => buildSessionLog(workout, sessionApi.session),
        [workout, sessionApi.session],
    )

    type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'unavailable'
    const [saveStatus, setSaveStatus] = React.useState<SaveStatus>('idle')
    const [saveError, setSaveError] = React.useState<string | null>(null)
    const savedKeyRef = React.useRef<string | null>(null)

    const triggerSave = React.useCallback(async () => {
        if (!artifactId) {
            setSaveStatus('unavailable')
            return
        }
        // Include the editable log payload so post-finish changes re-save,
        // while identical remounts still avoid duplicate API calls.
        const key = JSON.stringify({
            sessionId: sessionApi.session.sessionId,
            startedAt: sessionApi.session.startedAt ?? '',
            completedAt: sessionApi.session.completedAt ?? '',
            logsByExerciseId: sessionApi.session.logsByExerciseId,
            addedGroups: sessionApi.session.addedGroups,
            feedback: sessionApi.session.feedback,
        })
        if (savedKeyRef.current === key) return
        savedKeyRef.current = key
        setSaveStatus('saving')
        setSaveError(null)
        try {
            const resp = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/save-workout-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: sessionApi.session }),
            })
            if (!resp.ok) {
                let detail = `HTTP ${resp.status}`
                try {
                    const j = await resp.json() as { error?: string }
                    if (j.error) detail = j.error
                } catch { /* ignore */ }
                throw new Error(detail)
            }
            setSaveStatus('saved')
        } catch (e) {
            setSaveStatus('error')
            setSaveError(e instanceof Error ? e.message : String(e))
        }
    }, [artifactId, sessionApi.session])

    React.useEffect(() => {
        void triggerSave()
    }, [triggerSave])

    return (
        <section
            className={cn(
                "flex flex-col gap-4 rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.08] via-emerald-500/[0.04] to-transparent p-4 shadow-sm",
                "animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500",
                className,
            )}
            aria-label="Session summary"
        >
            <header className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-5" strokeWidth={1.85} />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-foreground">Session complete</h2>
                    <p className="text-[12.5px] text-muted-foreground">
                        Nice work — here&apos;s the recap.
                    </p>
                </div>
                <SaveStatusBadge status={saveStatus} error={saveError} onRetry={() => { savedKeyRef.current = null; void triggerSave() }} />
            </header>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile
                    icon={<Timer className="size-3.5" strokeWidth={1.85} />}
                    label="Duration"
                    value={formatDuration(log.totalDurationSec)}
                    sub={log.setSummary.avgSetSec !== undefined
                        ? `sets avg ${formatDuration(Math.round(log.setSummary.avgSetSec))}`
                        : undefined}
                />
                <StatTile
                    icon={<ListChecks className="size-3.5" strokeWidth={1.85} />}
                    label="Sets"
                    value={`${log.totalSetsCompleted}/${log.totalSetsPlanned}`}
                    sub={[
                        log.totalSetsFailed ? `${log.totalSetsFailed} failed` : null,
                        countSkippedSets(log) ? `${countSkippedSets(log)} skipped` : null,
                    ].filter(Boolean).join(' · ') || undefined}
                />
                <StatTile
                    icon={<Sparkles className="size-3.5" strokeWidth={1.85} />}
                    label="Tonnage"
                    value={`${Math.round(log.totalVolumeKg).toLocaleString()} ${workout.units}`}
                />
                <StatTile
                    icon={<Trophy className="size-3.5" strokeWidth={1.85} />}
                    label="PRs"
                    value={log.prs.length.toString()}
                    accent={log.prs.length > 0}
                />
            </div>

            {log.feedback ? <SessionFeedback feedback={log.feedback} /> : null}

            {log.prs.length > 0 ? <PrList prs={log.prs} /> : null}

            <ExerciseRecap log={log} units={workout.units} />

            <footer className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={() => sessionApi.reset()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <RotateCcw className="size-3" />
                    Start again
                </button>
            </footer>
        </section>
    )
}

function SessionFeedback({ feedback }: { feedback: NonNullable<SessionLog['feedback']> }) {
    return (
        <div className="rounded-xl border border-border/45 bg-background/55 p-3">
            <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Session feedback
            </div>
            {feedback.rating ? (
                <div className="flex items-center gap-1 text-amber-500" aria-label={`${feedback.rating} out of 5 stars`}>
                    {[1, 2, 3, 4, 5].map((value) => (
                        <Star
                            key={value}
                            className={cn("size-4", value <= feedback.rating! && "fill-current")}
                            strokeWidth={1.85}
                        />
                    ))}
                    <span className="ml-1 text-[12px] font-medium text-foreground">{feedback.rating}/5</span>
                </div>
            ) : null}
            {feedback.notes ? (
                <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/85">
                    {feedback.notes}
                </p>
            ) : null}
        </div>
    )
}

function StatTile({
    icon,
    label,
    value,
    sub,
    accent,
}: {
    icon: React.ReactNode
    label: string
    value: string
    sub?: string
    accent?: boolean
}) {
    return (
        <div
            className={cn(
                "flex flex-col gap-0.5 rounded-lg border border-border/45 bg-background/65 px-2.5 py-2",
                accent && "border-amber-500/40 bg-amber-500/[0.06]",
            )}
        >
            <div className="flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                <span className={cn("inline-flex", accent && "text-amber-500")}>{icon}</span>
                {label}
            </div>
            <div className={cn(
                "text-base font-semibold tabular-nums leading-tight text-foreground",
                accent && "text-amber-700 dark:text-amber-300",
            )}>
                {value}
            </div>
            {sub ? (
                <div className="text-[10.5px] tabular-nums text-muted-foreground">{sub}</div>
            ) : null}
        </div>
    )
}

function PrList({ prs }: { prs: readonly PrEvent[] }) {
    return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                <Trophy className="size-3.5" strokeWidth={2} />
                {prs.length} {prs.length === 1 ? 'PR' : 'PRs'} today
            </div>
            <ul className="flex flex-col gap-1.5">
                {prs.map((pr, i) => (
                    <li key={`${pr.exerciseId}-${pr.kind}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
                        <span className="font-semibold text-foreground">{pr.exerciseName}</span>
                        <span className="text-foreground/85">{pr.label}</span>
                        {pr.previousLabel ? (
                            <span className="text-[11px] text-muted-foreground">
                                ← was {pr.previousLabel}
                            </span>
                        ) : null}
                        <PrKindBadge kind={pr.kind} />
                    </li>
                ))}
            </ul>
        </div>
    )
}

function PrKindBadge({ kind }: { kind: PrEvent['kind'] }) {
    const label = (() => {
        switch (kind) {
            case 'weight': return 'Weight PR'
            case 'reps': return 'Rep PR'
            case 'estimated_1rm': return '1RM PR'
            case 'duration': return 'Hold PR'
            case 'distance': return 'Distance PR'
        }
    })()
    return (
        <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
            {label}
        </span>
    )
}

function ExerciseRecap({ log, units }: { log: SessionLog; units: string }) {
    return (
        <div className="flex flex-col gap-1">
            <div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Recap
            </div>
            <ul className="flex flex-col gap-1">
                {log.exercises.map((ex) => {
                    const completed = ex.loggedSets.filter((s) => s.completed && !s.failed).length
                    const failed = ex.loggedSets.filter((s) => s.failed).length
                    const skipped = ex.loggedSets.filter((s) => s.skipped).length
                    return (
                        <li key={ex.id} className="flex items-center gap-2 rounded-md bg-background/55 px-2.5 py-1.5 text-[12.5px]">
                            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{ex.name}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                {completed}/{ex.plannedSetCount}
                                {failed ? <span className="ml-1 text-rose-500">· {failed} failed</span> : null}
                                {skipped ? <span className="ml-1 text-amber-600 dark:text-amber-300">· {skipped} skipped</span> : null}
                            </span>
                            {ex.totalVolumeKg > 0 ? (
                                <span className="shrink-0 tabular-nums text-foreground/65">
                                    {Math.round(ex.totalVolumeKg).toLocaleString()} {units}
                                </span>
                            ) : null}
                            {ex.setTiming.avgSetSec !== undefined ? (
                                <span className="shrink-0 tabular-nums text-foreground/65">
                                    avg {formatDuration(Math.round(ex.setTiming.avgSetSec))}
                                </span>
                            ) : null}
                            {ex.skipped ? <span className="text-[11px] text-muted-foreground italic">skipped</span> : null}
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

function countSkippedSets(log: SessionLog): number {
    return log.exercises.reduce((sum, exercise) => {
        return sum + exercise.loggedSets.filter((set) => set.skipped).length
    }, 0)
}

function SaveStatusBadge({
    status,
    error,
    onRetry,
}: {
    status: 'idle' | 'saving' | 'saved' | 'error' | 'unavailable'
    error: string | null
    onRetry: () => void
}) {
    if (status === 'idle' || status === 'unavailable') {
        return status === 'unavailable' ? (
            <span
                className="inline-flex items-center gap-1 rounded-full bg-muted/55 px-2 py-0.5 text-[10.5px] text-muted-foreground"
                title="Preview mode — session not persisted"
            >
                <CloudOff className="size-3" />
                preview
            </span>
        ) : null
    }
    if (status === 'saving') {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/55 px-2 py-0.5 text-[10.5px] text-muted-foreground">
                <Cloud className="size-3 motion-safe:animate-pulse" />
                Saving…
            </span>
        )
    }
    if (status === 'saved') {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="size-3" />
                Saved
            </span>
        )
    }
    return (
        <button
            type="button"
            onClick={onRetry}
            title={error ?? undefined}
            className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10.5px] text-rose-700 transition-colors hover:bg-rose-500/25 dark:text-rose-300"
        >
            <XCircle className="size-3" />
            Save failed · retry
        </button>
    )
}
