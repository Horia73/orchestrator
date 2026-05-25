"use client"

import * as React from "react"
import { Clock, ListChecks, Weight } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutArtifact } from "@/lib/workout/schema"
import { formatDuration } from "@/lib/workout/format"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

import { GlossaryInfo } from "./glossary-info"

/**
 * Stats strip. Two modes:
 *
 *   - **Pre-start / static**: shows planned totals (sets, exercises, planned
 *     tonnage). Compact pill row, informational only.
 *   - **Live during session**: ticking elapsed timer, X/Y sets done, running
 *     actual tonnage. Visible progress bar across the bottom.
 *
 * Drives the user's sense of progress through the workout — like a marathon
 * mile-marker board. Updates every second when the session is active.
 */
export function WorkoutProgressStats({
    workout,
    sessionApi,
    className,
}: {
    workout: WorkoutArtifact
    sessionApi?: WorkoutSessionApi
    className?: string
}) {
    const isLive = sessionApi?.isActive ?? false
    const plannedStats = React.useMemo(() => computePlannedStats(workout), [workout])

    // Tick once a second only while the session is live so we can update the
    // elapsed clock. No-op subscription otherwise.
    const [nowMs, setNowMs] = React.useState<number | null>(null)
    React.useEffect(() => {
        if (!isLive) {
            setNowMs(null)
            return
        }
        setNowMs(Date.now())
        const id = window.setInterval(() => setNowMs(Date.now()), 1000)
        return () => window.clearInterval(id)
    }, [isLive])

    const liveStats = React.useMemo(() => {
        if (!sessionApi) return null
        return computeLiveStats(workout, sessionApi)
    }, [workout, sessionApi])

    if (plannedStats.totalSets === 0) return null

    const showLive = !!sessionApi && (sessionApi.isActive || sessionApi.isFinished)
    const completedFraction = liveStats ? liveStats.setsDone / Math.max(1, plannedStats.totalSets) : 0
    const elapsed = showLive && sessionApi?.session.startedAt
        ? Math.floor(((sessionApi.session.completedAt ? new Date(sessionApi.session.completedAt).getTime() : (nowMs ?? new Date(sessionApi.session.startedAt).getTime())) - new Date(sessionApi.session.startedAt).getTime()) / 1000)
        : 0

    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg border border-border/45 bg-muted/30",
                className,
            )}
        >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[11.5px] text-foreground/75">
                <div className="inline-flex items-center gap-1.5">
                    <ListChecks className="size-3.5 text-foreground/55" aria-hidden strokeWidth={1.85} />
                    <span className="tabular-nums">
                        {showLive ? (
                            <>
                                <span className="font-semibold text-foreground">{liveStats?.setsDone ?? 0}</span>
                                <span className="text-muted-foreground">/{plannedStats.totalSets}</span>
                                <span className="ml-0.5"> sets</span>
                            </>
                        ) : (
                            <>
                                <span className="font-semibold text-foreground">{plannedStats.totalSets}</span> sets
                                <span className="ml-0.5"> · </span>
                                <span className="font-semibold text-foreground">{plannedStats.exerciseCount}</span> exerciții
                            </>
                        )}
                    </span>
                </div>
                {showLive ? (
                    <div className="inline-flex items-center gap-1.5">
                        <Clock className="size-3.5 text-foreground/55" aria-hidden strokeWidth={1.85} />
                        <span className="tabular-nums font-semibold text-foreground">
                            {formatDuration(elapsed)}
                        </span>
                    </div>
                ) : null}
                <div className="ml-auto inline-flex items-center gap-1 tabular-nums">
                    <Weight className="size-3.5 text-foreground/55" aria-hidden strokeWidth={1.85} />
                    {showLive ? (
                        <>
                            <span>
                                Tonnage
                                <GlossaryInfo term="tonnage" />:
                            </span>
                            <span className="font-semibold text-foreground">
                                {Math.round(liveStats?.actualTonnageKg ?? 0).toLocaleString()}
                            </span>{' '}
                            <span className="text-muted-foreground">/ {Math.round(plannedStats.totalVolumeKg).toLocaleString()}</span>
                            <span className="ml-0.5">{workout.units}</span>
                        </>
                    ) : (
                        plannedStats.totalVolumeKg > 0 ? (
                            <>
                                <span>Planned tonnage<GlossaryInfo term="tonnage" />:</span>
                                <span className="font-semibold text-foreground">{Math.round(plannedStats.totalVolumeKg).toLocaleString()}</span>
                                <span className="ml-0.5">{workout.units}</span>
                            </>
                        ) : null
                    )}
                </div>
            </div>
            {showLive ? (
                <div className="relative h-1 w-full bg-muted/55">
                    <div
                        className="h-full bg-primary transition-[width] duration-300 ease-out"
                        style={{ width: `${Math.min(100, completedFraction * 100)}%` }}
                    />
                </div>
            ) : null}
        </div>
    )
}

interface PlannedStats {
    totalSets: number
    exerciseCount: number
    totalVolumeKg: number
}

function computePlannedStats(workout: WorkoutArtifact): PlannedStats {
    let totalSets = 0
    let exerciseCount = 0
    let totalVolumeKg = 0
    for (const group of workout.groups) {
        // Rounds multiply intended *workload* (you move that much over all
        // circuit passes), but NOT the visible set rows — the UI shows one
        // row per planned[i] regardless of rounds. Keep set counts matching
        // what's actually checkable so summary cards don't disagree with
        // this strip.
        const rounds = group.rounds ?? 1
        for (const ex of group.exercises) {
            exerciseCount++
            for (const set of ex.planned) {
                totalSets += 1
                if (ex.kind === 'weighted' && 'weightKg' in set && set.weightKg !== undefined && 'reps' in set) {
                    const reps = typeof set.reps === 'number' ? set.reps : Array.isArray(set.reps) ? (set.reps[0] + set.reps[1]) / 2 : 0
                    totalVolumeKg += set.weightKg * reps * rounds
                }
            }
        }
    }
    return { totalSets, exerciseCount, totalVolumeKg }
}

interface LiveStats {
    setsDone: number
    actualTonnageKg: number
}

function computeLiveStats(workout: WorkoutArtifact, sessionApi: WorkoutSessionApi): LiveStats {
    let setsDone = 0
    let actualTonnageKg = 0
    for (const group of workout.groups) {
        for (const ex of group.exercises) {
            for (let i = 0; i < ex.planned.length; i++) {
                const logged = sessionApi.getLogged(ex.id, i)
                if (logged?.completed && !logged.failed) setsDone++
                if (logged?.completed && logged.actualWeightKg !== undefined && logged.actualReps !== undefined) {
                    actualTonnageKg += logged.actualWeightKg * logged.actualReps
                }
            }
        }
    }
    return { setsDone, actualTonnageKg }
}
