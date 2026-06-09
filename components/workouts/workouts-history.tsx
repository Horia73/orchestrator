"use client"

import * as React from "react"
import { Activity, Dumbbell, RefreshCw, Ruler, Scale, Trophy, TrendingUp, Weight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
    RecentSessionsList,
    type SessionSummaryRow,
} from "@/components/workouts/recent-sessions-list"
import {
    ExerciseLeaderboard,
    type ExerciseSummary,
} from "@/components/workouts/exercise-leaderboard"
import { MuscleBalance } from "@/components/workouts/muscle-balance"
import { TrainingCalendar } from "@/components/workouts/training-calendar"
import { Sparkline } from "@/components/workouts/sparkline"

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
    const [bodyMetrics, setBodyMetrics] = React.useState<BodyMetricsPayload | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [refreshing, setRefreshing] = React.useState(false)

    const load = React.useCallback(async () => {
        setRefreshing(true)
        setError(null)
        try {
            const [sessRes, exRes, bodyRes] = await Promise.all([
                fetch('/api/workouts/sessions?limit=30'),
                fetch('/api/workouts/exercises'),
                fetch('/api/workouts/body-metrics?limit=12'),
            ])
            if (!sessRes.ok) throw new Error(`Sessions HTTP ${sessRes.status}`)
            if (!exRes.ok) throw new Error(`Exercises HTTP ${exRes.status}`)
            if (!bodyRes.ok) throw new Error(`Body metrics HTTP ${bodyRes.status}`)
            const sj = await sessRes.json() as { sessions: SessionSummaryRow[] }
            const ej = await exRes.json() as { exercises: ExerciseSummary[] }
            const bj = await bodyRes.json() as BodyMetricsPayload
            setSessions(sj.sessions)
            setExercises(ej.exercises)
            setBodyMetrics(bj)
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
                    Your session history and PRs. New sessions appear automatically after you tap <span className="font-medium text-foreground">Finish workout</span>.
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

            {sessions === null ? (
                <div className="h-32 animate-pulse rounded-xl border border-border/40 bg-muted/30" />
            ) : (
                <TrainingCalendar sessions={sessions} />
            )}

            {sessions === null || exercises === null || bodyMetrics === null ? (
                <OverviewSkeleton />
            ) : (
                <ProgressOverview
                    sessions={sessions}
                    exercises={exercises}
                    bodyMetrics={bodyMetrics}
                    onMetricsSaved={() => void load()}
                />
            )}

            {sessions === null ? (
                <div className="h-40 animate-pulse rounded-xl border border-border/40 bg-muted/30" />
            ) : (
                <MuscleBalance sessions={sessions} />
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
                <section className="flex min-w-0 flex-col gap-3">
                    <h2 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/65">
                        Recent sessions
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
                        Per-exercise PRs
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

interface BodyMetricEntry {
    id: string
    recordedAt: string
    heightCm?: number
    weightKg?: number
    bodyFatPct?: number
    musclePct?: number
    notes?: string
}

interface BodyMetricsPayload {
    entries: BodyMetricEntry[]
    latest: BodyMetricEntry | null
    bmi: number | null
    count: number
}

function ProgressOverview({
    sessions,
    exercises,
    bodyMetrics,
    onMetricsSaved,
}: {
    sessions: SessionSummaryRow[]
    exercises: ExerciseSummary[]
    bodyMetrics: BodyMetricsPayload
    onMetricsSaved: () => void
}) {
    const stats = React.useMemo(() => computeProgressStats(sessions, exercises), [sessions, exercises])
    return (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workout progress overview">
            <ProgressCard
                icon={<Dumbbell className="size-4" strokeWidth={1.85} />}
                label="Last 7 days"
                value={`${stats.weekSessions} sessions`}
                sub={`${stats.weekSets} sets · ${Math.round(stats.weekVolume).toLocaleString()} kg`}
            />
            <ProgressCard
                icon={<TrendingUp className="size-4" strokeWidth={1.85} />}
                label="Recent volume"
                value={`${Math.round(stats.recentAvgVolume).toLocaleString()} kg`}
                sub={stats.volumeDeltaLabel}
                accent={stats.volumeDelta > 0}
            />
            <ProgressCard
                icon={<Trophy className="size-4" strokeWidth={1.85} />}
                label="PRs"
                value={`${stats.prCount} PR${stats.prCount === 1 ? '' : 's'}`}
                sub={`${stats.exerciseCount} exercises with history`}
                accent={stats.prCount > 0}
            />
            <BodyMetricsCard payload={bodyMetrics} onSaved={onMetricsSaved} />
        </section>
    )
}

function ProgressCard({
    icon,
    label,
    value,
    sub,
    accent,
}: {
    icon: React.ReactNode
    label: string
    value: string
    sub: string
    accent?: boolean
}) {
    return (
        <div
            className={cn(
                "min-w-0 rounded-lg border border-border/60 bg-card px-3.5 py-3 shadow-sm",
                accent && "border-amber-500/35 bg-amber-500/[0.05]",
            )}
        >
            <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span className={cn("inline-flex", accent && "text-amber-500")}>{icon}</span>
                {label}
            </div>
            <div className="truncate text-xl font-semibold tabular-nums text-foreground">{value}</div>
            <div className="mt-0.5 truncate text-[11.5px] tabular-nums text-muted-foreground">{sub}</div>
        </div>
    )
}

function BodyMetricsCard({
    payload,
    onSaved,
}: {
    payload: BodyMetricsPayload
    onSaved: () => void
}) {
    const latest = payload.latest
    const [open, setOpen] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    // Oldest→newest weight series for the trend sparkline. `entries` arrives
    // newest-first from the API.
    const weightSeries = React.useMemo(
        () => payload.entries
            .map((e) => e.weightKg)
            .filter((w): w is number => typeof w === 'number' && Number.isFinite(w))
            .reverse(),
        [payload.entries],
    )
    const weightDelta = weightSeries.length >= 2
        ? Math.round((weightSeries[weightSeries.length - 1] - weightSeries[0]) * 10) / 10
        : null
    const [draft, setDraft] = React.useState(() => ({
        heightCm: latest?.heightCm?.toString() ?? '',
        weightKg: latest?.weightKg?.toString() ?? '',
        bodyFatPct: latest?.bodyFatPct?.toString() ?? '',
        musclePct: latest?.musclePct?.toString() ?? '',
    }))

    React.useEffect(() => {
        setDraft({
            heightCm: latest?.heightCm?.toString() ?? '',
            weightKg: latest?.weightKg?.toString() ?? '',
            bodyFatPct: latest?.bodyFatPct?.toString() ?? '',
            musclePct: latest?.musclePct?.toString() ?? '',
        })
    }, [latest])

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch('/api/workouts/body-metrics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recordedAt: new Date().toISOString(),
                    heightCm: numberOrUndefined(draft.heightCm),
                    weightKg: numberOrUndefined(draft.weightKg),
                    bodyFatPct: numberOrUndefined(draft.bodyFatPct),
                    musclePct: numberOrUndefined(draft.musclePct),
                }),
            })
            if (!response.ok) {
                const j = await response.json().catch(() => ({})) as { error?: string }
                throw new Error(j.error ?? `HTTP ${response.status}`)
            }
            setOpen(false)
            onSaved()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="min-w-0 rounded-lg border border-border/60 bg-card px-3.5 py-3 shadow-sm">
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Activity className="size-4" strokeWidth={1.85} />
                    Body metrics
                </div>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="rounded-md border border-border bg-background px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {open ? 'Close' : 'Update'}
                </button>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                <MetricLine icon={<Scale className="size-3" />} label="Weight" value={latest?.weightKg ? `${latest.weightKg} kg` : '—'} />
                <MetricLine icon={<Ruler className="size-3" />} label="IMC" value={payload.bmi ? payload.bmi.toString() : '—'} />
                <MetricLine icon={<Weight className="size-3" />} label="Body fat" value={latest?.bodyFatPct ? `${latest.bodyFatPct}%` : '—'} />
                <MetricLine icon={<Activity className="size-3" />} label="Muscle" value={latest?.musclePct ? `${latest.musclePct}%` : '—'} />
            </div>

            {weightSeries.length >= 2 ? (
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
                    <Sparkline
                        values={weightSeries}
                        width={104}
                        height={26}
                        strokeClass="text-foreground/70"
                        ariaLabel="Weight trend"
                    />
                    {weightDelta !== null ? (
                        <span
                            className={cn(
                                "shrink-0 text-[10.5px] font-medium tabular-nums",
                                weightDelta > 0
                                    ? "text-amber-600 dark:text-amber-400"
                                    : weightDelta < 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground",
                            )}
                            title={`Across ${weightSeries.length} logged entries`}
                        >
                            {weightDelta > 0 ? '+' : ''}{weightDelta} kg
                        </span>
                    ) : null}
                </div>
            ) : null}

            {open ? (
                <div className="mt-2 border-t border-border/45 pt-2">
                    <div className="grid grid-cols-2 gap-2">
                        <SmallInput label="Height cm" value={draft.heightCm} onChange={(heightCm) => setDraft((d) => ({ ...d, heightCm }))} />
                        <SmallInput label="Weight kg" value={draft.weightKg} onChange={(weightKg) => setDraft((d) => ({ ...d, weightKg }))} />
                        <SmallInput label="Body fat %" value={draft.bodyFatPct} onChange={(bodyFatPct) => setDraft((d) => ({ ...d, bodyFatPct }))} />
                        <SmallInput label="Muscle %" value={draft.musclePct} onChange={(musclePct) => setDraft((d) => ({ ...d, musclePct }))} />
                    </div>
                    {error ? <div className="mt-1.5 text-[11px] text-rose-500">{error}</div> : null}
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving}
                        className="mt-2 h-8 w-full rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-50"
                    >
                        {saving ? 'Saving…' : 'Save metrics'}
                    </button>
                </div>
            ) : null}
        </div>
    )
}

function MetricLine({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode
    label: string
    value: string
}) {
    return (
        <div className="min-w-0">
            <div className="inline-flex items-center gap-1 text-muted-foreground/75">
                {icon}
                {label}
            </div>
            <div className="truncate font-semibold tabular-nums text-foreground">{value}</div>
        </div>
    )
}

function SmallInput({
    label,
    value,
    onChange,
}: {
    label: string
    value: string
    onChange: (value: string) => void
}) {
    return (
        <label>
            <span className="mb-1 block truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
            </span>
            <input
                type="number"
                inputMode="decimal"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-right text-[12.5px] font-semibold tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
        </label>
    )
}

function OverviewSkeleton() {
    return (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg border border-border/40 bg-muted/30" />
            ))}
        </section>
    )
}

function computeProgressStats(sessions: SessionSummaryRow[], exercises: ExerciseSummary[]) {
    const now = Date.now()
    const weekSessions = sessions.filter((session) => {
        const t = new Date(session.startedAt).getTime()
        return Number.isFinite(t) && now - t <= 7 * 86_400_000
    })
    const recent = sessions.slice(0, 5)
    const previous = sessions.slice(5, 10)
    const recentAvgVolume = average(recent.map((session) => session.totalVolumeKg))
    const previousAvgVolume = average(previous.map((session) => session.totalVolumeKg))
    const volumeDelta = previousAvgVolume > 0 ? recentAvgVolume - previousAvgVolume : 0
    return {
        weekSessions: weekSessions.length,
        weekSets: weekSessions.reduce((sum, session) => sum + session.totalSetsCompleted, 0),
        weekVolume: weekSessions.reduce((sum, session) => sum + session.totalVolumeKg, 0),
        recentAvgVolume,
        volumeDelta,
        volumeDeltaLabel: previousAvgVolume > 0
            ? `${volumeDelta >= 0 ? '+' : ''}${Math.round(volumeDelta).toLocaleString()} kg vs prior 5`
            : 'avg over last 5 sessions',
        prCount: sessions.reduce((sum, session) => sum + session.prCount, 0),
        exerciseCount: exercises.length,
    }
}

function average(values: number[]): number {
    const clean = values.filter((value) => Number.isFinite(value))
    if (clean.length === 0) return 0
    return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function numberOrUndefined(value: string): number | undefined {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : undefined
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
