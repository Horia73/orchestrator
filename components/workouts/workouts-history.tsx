"use client"

import * as React from "react"
import { RefreshCw, Trophy } from "lucide-react"

import { cn } from "@/lib/utils"
import {
    RecentSessionsList,
    type SessionSummaryRow,
} from "@/components/workouts/recent-sessions-list"
import {
    ExerciseLeaderboard,
    type ExerciseSummary,
} from "@/components/workouts/exercise-leaderboard"

/**
 * Workouts history dashboard — the visual the Library page mounts under
 * its Workouts tab. Extracted from the original /workouts page so the
 * same composition can be reused inside Library and any future surface.
 *
 * Self-contained: owns its own fetch, refresh, and error states. The
 * parent (Library or /workouts redirect target) only needs to render it.
 */
export function WorkoutsHistory({
    className,
}: {
    className?: string
}) {
    const [sessions, setSessions] = React.useState<SessionSummaryRow[] | null>(null)
    const [exercises, setExercises] = React.useState<ExerciseSummary[] | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [refreshing, setRefreshing] = React.useState(false)

    const load = React.useCallback(async () => {
        setRefreshing(true)
        setError(null)
        try {
            const [sessRes, exRes] = await Promise.all([
                fetch('/api/workouts/sessions?limit=30'),
                fetch('/api/workouts/exercises'),
            ])
            if (!sessRes.ok) throw new Error(`Sessions HTTP ${sessRes.status}`)
            if (!exRes.ok) throw new Error(`Exercises HTTP ${exRes.status}`)
            const sj = await sessRes.json() as { sessions: SessionSummaryRow[] }
            const ej = await exRes.json() as { exercises: ExerciseSummary[] }
            setSessions(sj.sessions)
            setExercises(ej.exercises)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setRefreshing(false)
        }
    }, [])

    React.useEffect(() => {
        void load()
    }, [load])

    return (
        <div className={cn("flex flex-col gap-6", className)}>
            <div className="flex items-end justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                    Istoricul sesiunilor și PR-urile tale. Sesiunile noi apar automat după ce apeși <span className="font-medium text-foreground">Finish workout</span>.
                </p>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={refreshing}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground",
                        "disabled:cursor-default disabled:opacity-50",
                    )}
                >
                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                    Refresh
                </button>
            </div>

            {error ? (
                <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
                    {error}
                </div>
            ) : null}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
                <section className="flex min-w-0 flex-col gap-3">
                    <h2 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/65">
                        Sesiuni recente
                    </h2>
                    {sessions === null ? (
                        <SkeletonRows count={4} />
                    ) : (
                        <RecentSessionsList sessions={sessions} />
                    )}
                </section>

                <section className="flex min-w-0 flex-col gap-3">
                    <h2 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/65">
                        <Trophy className="size-3 text-amber-500" strokeWidth={2} />
                        PR-uri pe exerciții
                    </h2>
                    {exercises === null ? (
                        <SkeletonRows count={6} />
                    ) : (
                        <ExerciseLeaderboard exercises={exercises} />
                    )}
                </section>
            </div>
        </div>
    )
}

function SkeletonRows({ count }: { count: number }) {
    return (
        <ul className="flex flex-col gap-2">
            {Array.from({ length: count }).map((_, i) => (
                <li
                    key={i}
                    className="h-16 animate-pulse rounded-xl border border-border/40 bg-muted/30"
                />
            ))}
        </ul>
    )
}
