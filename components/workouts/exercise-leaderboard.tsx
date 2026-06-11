"use client"

import * as React from "react"
import { ChevronDown, Trophy } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/workout/format"
import { muscleLabel } from "@/lib/workout/muscles"
import { useIdlePrefetch } from "@/hooks/use-idle-prefetch"
import { Collapse } from "@/components/ui/collapse"
import { SectionEmpty } from "@/components/workouts/section-card"

export interface ExerciseSummary {
    id: string
    name: string
    kind: string
    muscleGroups: string[]
    personalBest: {
        weightKg?: number
        reps?: number
        durationSec?: number
        distanceM?: number
        estimated1RM?: number
        achievedAt: string
    } | null
    sessionCount: number
    lastSessionDate: string | null
}

const VISIBLE_DEFAULT = 8

/**
 * Per-exercise leaderboard inside the Workouts tab. Rendered as divided rows
 * inside the parent SectionCard. Each row shows current PB and a
 * click-to-expand mini history (last 6 sessions with best set per session
 * and an inline est 1RM trend chart). Long lists collapse behind "Show all".
 *
 * Like the sessions list, each row warms its detail on idle (useIdlePrefetch)
 * so expansion is a smooth height-animated Collapse with the content already in
 * the DOM — no loading text and no sub-100ms spinner flicker.
 */
export function ExerciseLeaderboard({
    exercises,
    className,
}: {
    exercises: ExerciseSummary[]
    className?: string
}) {
    const [showAll, setShowAll] = React.useState(false)

    if (exercises.length === 0) {
        return (
            <SectionEmpty>
                No exercise history yet. Check off sets in a workout to start building it.
            </SectionEmpty>
        )
    }

    const visible = showAll ? exercises : exercises.slice(0, VISIBLE_DEFAULT)
    return (
        <div className={cn("flex flex-col", className)}>
            <ul className="divide-y divide-border/45">
                {visible.map((e) => (
                    <ExerciseRow key={e.id} exercise={e} />
                ))}
            </ul>
            {exercises.length > VISIBLE_DEFAULT ? (
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="border-t border-border/45 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                    {showAll ? "Show fewer" : `Show all ${exercises.length}`}
                </button>
            ) : null}
        </div>
    )
}

interface ExerciseDetailResponse {
    id: string
    name: string
    kind: string
    sessions: Array<{
        date: string
        title: string
        bestSet: {
            actualWeightKg?: number
            actualReps?: number
            actualDurationSec?: number
            actualDistanceM?: number
            actualRpe?: number
        }
        totalVolumeKg: number
        rpeAvg?: number
        estimated1RM: number | null
    }>
    personalBest: ExerciseSummary['personalBest']
}

function ExerciseRow({ exercise }: { exercise: ExerciseSummary }) {
    const [open, setOpen] = React.useState(false)
    const [detail, setDetail] = React.useState<ExerciseDetailResponse | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const inflight = React.useRef<Promise<void> | null>(null)

    // Fetch the detail once and cache it; dedupe idle prefetch + tap onto one
    // in-flight promise. Never rejects — errors land in `error` state.
    const load = React.useCallback(() => {
        if (detail !== null) return Promise.resolve()
        if (inflight.current) return inflight.current
        const run = (async () => {
            setError(null)
            try {
                const r = await fetch(`/api/workouts/exercises/${encodeURIComponent(exercise.id)}`)
                if (!r.ok) {
                    const j = await r.json().catch(() => ({})) as { error?: string }
                    throw new Error(j.error ?? `HTTP ${r.status}`)
                }
                setDetail(await r.json() as ExerciseDetailResponse)
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
            } finally {
                inflight.current = null
            }
        })()
        inflight.current = run
        return run
    }, [detail, exercise.id])

    useIdlePrefetch(load)

    const onToggle = React.useCallback(() => {
        if (open) {
            setOpen(false)
            return
        }
        if (detail !== null || error !== null) {
            setOpen(true)
            return
        }
        // Tapped before the prefetch landed — reveal once content arrives.
        void load().then(() => setOpen(true))
    }, [open, detail, error, load])

    return (
        <li>
            <button
                type="button"
                onClick={() => void onToggle()}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                aria-expanded={open}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                        <h3 className="text-sm font-semibold text-foreground">{exercise.name}</h3>
                        <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                            {exercise.muscleGroups.slice(0, 3).map(muscleLabel).join(' · ')}
                        </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] tabular-nums text-muted-foreground">
                        <span>{exercise.sessionCount} session{exercise.sessionCount === 1 ? '' : 's'}</span>
                        {exercise.lastSessionDate ? (
                            <>
                                <span>·</span>
                                <span>last {exercise.lastSessionDate}</span>
                            </>
                        ) : null}
                    </div>
                </div>
                {exercise.personalBest ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                        <Trophy className="size-3" strokeWidth={2} />
                        {formatPbInline(exercise.personalBest)}
                    </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground/65">
                    <ChevronDown
                        className={cn(
                            "size-4 transition-transform duration-300 ease-out motion-reduce:transition-none",
                            open && "rotate-180",
                        )}
                    />
                </span>
            </button>
            <Collapse open={open}>
                <div
                    className={cn(
                        "border-t border-border/45 bg-muted/15 px-4 py-3 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                        open ? "opacity-100" : "opacity-0",
                    )}
                >
                    {error ? (
                        <div className="text-[12px] text-rose-500">
                            {error} · <button onClick={() => void load().then(() => setOpen(true))} className="underline">retry</button>
                        </div>
                    ) : detail ? (
                        <ExerciseTrend detail={detail} />
                    ) : null}
                </div>
            </Collapse>
        </li>
    )
}

function formatPbInline(pb: NonNullable<ExerciseSummary['personalBest']>): string {
    if (pb.weightKg !== undefined && pb.reps !== undefined) return `${pb.weightKg} kg × ${pb.reps}`
    if (pb.durationSec !== undefined) return formatDuration(pb.durationSec)
    if (pb.reps !== undefined) return `${pb.reps} reps`
    if (pb.distanceM !== undefined) return `${pb.distanceM} m`
    return ''
}

/**
 * Tiny est-1RM trend strip + last 6 sessions list. SVG sparkline only —
 * no chart library, keeps the bundle lean.
 */
function ExerciseTrend({ detail }: { detail: ExerciseDetailResponse }) {
    const points = React.useMemo(() => {
        // Oldest first for the sparkline.
        const sorted = [...detail.sessions].reverse()
        return sorted
            .map((s, i) => ({
                x: i,
                y: s.estimated1RM ?? s.bestSet.actualWeightKg ?? 0,
                date: s.date,
            }))
            .filter((p) => p.y > 0)
    }, [detail.sessions])

    return (
        <div className="flex flex-col gap-3">
            {points.length >= 2 ? <Sparkline points={points} /> : null}
            <ul className="flex flex-col gap-1">
                {detail.sessions.slice(0, 6).map((s, i) => (
                    <li
                        key={`${s.date}-${i}`}
                        className="flex items-center gap-2 rounded-md bg-background/65 px-2.5 py-1.5 text-[12px]"
                    >
                        <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{s.date}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground/85">{s.title}</span>
                        <span className="shrink-0 text-foreground tabular-nums">
                            {s.bestSet.actualWeightKg !== undefined
                                ? `${s.bestSet.actualWeightKg} × ${s.bestSet.actualReps ?? '?'}`
                                : s.bestSet.actualDurationSec !== undefined
                                    ? formatDuration(s.bestSet.actualDurationSec)
                                    : s.bestSet.actualReps !== undefined
                                        ? `${s.bestSet.actualReps} reps`
                                        : '—'}
                        </span>
                        {typeof s.estimated1RM === 'number' ? (
                            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                                ~{s.estimated1RM}
                            </span>
                        ) : null}
                        {typeof s.rpeAvg === 'number' ? (
                            <span className="shrink-0 rounded bg-foreground/[0.06] px-1 text-[10px] tabular-nums text-muted-foreground">
                                RPE {s.rpeAvg}
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>
        </div>
    )
}

function Sparkline({ points }: { points: Array<{ x: number; y: number; date: string }> }) {
    const w = 280
    const h = 48
    const padX = 4
    const padY = 6
    const ys = points.map((p) => p.y)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const yRange = Math.max(0.5, maxY - minY)
    const xMax = points.length - 1
    const path = points
        .map((p, i) => {
            const x = padX + (i / xMax) * (w - padX * 2)
            const y = padY + (1 - (p.y - minY) / yRange) * (h - padY * 2)
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
        })
        .join(' ')
    const lastPoint = points[points.length - 1]
    const lastX = padX + (xMax === 0 ? 0 : 1) * (w - padX * 2)
    const lastY = padY + (1 - (lastPoint.y - minY) / yRange) * (h - padY * 2)
    return (
        <div className="flex items-center gap-3">
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-primary" aria-label="Est. 1RM trend">
                <path d={path} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={lastX} cy={lastY} r={2.5} fill="currentColor" />
            </svg>
            <div className="flex flex-col text-[10.5px] text-muted-foreground tabular-nums">
                <span>min {Math.round(minY)}</span>
                <span>max {Math.round(maxY)}</span>
                <span className="text-primary">now {Math.round(lastPoint.y)}</span>
            </div>
        </div>
    )
}
