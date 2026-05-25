"use client"

import * as React from "react"
import { Check, Circle, MoreVertical, Sparkles, Zap } from "lucide-react"

import { cn } from "@/lib/utils"
import type {
    Exercise,
    LoggedSet,
    PlannedSet,
    WorkoutUnits,
} from "@/lib/workout/schema"
import {
    formatDistance,
    formatDuration,
    formatRepRange,
    formatSetKind,
    formatWeightNumber,
} from "@/lib/workout/format"
import { isNewPersonalBest, type WorkoutSessionApi } from "@/lib/workout/use-workout-session"

import { GlossaryInfo } from "./glossary-info"
import { WeightPicker } from "./weight-picker"
import { RepsPicker } from "./reps-picker"
import { SetActionsMenu } from "./set-actions-menu"

/**
 * One row in an exercise's set list — Phase 2 (interactive).
 *
 * Reads logged data from the session API; mutates it via the same API:
 *   - Click the status indicator → log the set with planned defaults and
 *     auto-start the rest timer. Tap again to un-log.
 *   - Tap the weight or reps value → opens the matching picker popover
 *     and re-logs the set with the new actual on Apply.
 *   - MoreVertical button → SetActionsMenu (skip / fail / note).
 *
 * Visual signals:
 *   - Set-kind colour treatment unchanged from Phase 1.
 *   - "Current" set (the next pending after the last logged) gets a ring.
 *   - PR-achievement triggers a brief golden glow + sparkle animation
 *     when the user logs a set that beats the previous personal best.
 */
export function SetRow({
    index,
    plannedSet,
    exercise,
    units,
    sessionApi,
    isCurrent = false,
    interactive,
    barKg,
    plates,
    className,
}: {
    /** 1-based index inside the exercise's planned set list. */
    index: number
    plannedSet: PlannedSet
    exercise: Exercise
    units: WorkoutUnits
    /** When passed, the row is interactive and reads/writes session state.
     *  Omitted in static-preview surfaces (Phase 1 dev preview kept). */
    sessionApi?: WorkoutSessionApi
    /** Whether the workout session has started — sets are inert before Start. */
    interactive?: boolean
    /** Bar weight in kg for the plate calculator. */
    barKg?: number
    /** Available plates in kg, descending. */
    plates?: readonly number[]
    /** Highlight as "next to do". */
    isCurrent?: boolean
    className?: string
}) {
    const logged = sessionApi?.getLogged(exercise.id, index - 1)
    const status = computeStatus(logged)
    const setKind = plannedSet.kind ?? 'working'

    const [weightPickerOpen, setWeightPickerOpen] = React.useState(false)
    const [repsPickerOpen, setRepsPickerOpen] = React.useState(false)
    const [menuOpen, setMenuOpen] = React.useState(false)
    const [prPulse, setPrPulse] = React.useState(false)

    const isInteractive = interactive && !!sessionApi

    // PR celebration: when status flips from pending → done AND the logged
    // set beats the PB, briefly pulse a sparkle and a golden ring.
    const prevStatus = React.useRef(status)
    React.useEffect(() => {
        if (
            prevStatus.current === 'pending'
            && status === 'done'
            && isNewPersonalBest(exercise, logged)
        ) {
            setPrPulse(true)
            const id = window.setTimeout(() => setPrPulse(false), 1800)
            return () => window.clearTimeout(id)
        }
        prevStatus.current = status
    }, [status, exercise, logged])

    const handleCheckClick = React.useCallback(() => {
        if (!isInteractive || !sessionApi) return
        if (status === 'done' || status === 'failed') {
            sessionApi.undoSet(exercise.id, index - 1)
        } else {
            sessionApi.logSet(exercise, index - 1, undefined, {
                plannedSet,
                startRest: true,
            })
        }
    }, [isInteractive, sessionApi, status, exercise, index, plannedSet])

    const handleWeightApply = React.useCallback((newKg: number) => {
        if (!sessionApi) return
        sessionApi.logSet(exercise, index - 1, { actualWeightKg: newKg }, { plannedSet, startRest: status !== 'done' })
        setWeightPickerOpen(false)
    }, [sessionApi, exercise, index, plannedSet, status])

    const handleRepsApply = React.useCallback((newReps: number) => {
        if (!sessionApi) return
        sessionApi.logSet(exercise, index - 1, { actualReps: newReps }, { plannedSet, startRest: status !== 'done' })
        setRepsPickerOpen(false)
    }, [sessionApi, exercise, index, plannedSet, status])

    const handleSkip = React.useCallback(() => {
        if (!sessionApi) return
        sessionApi.undoSet(exercise.id, index - 1)
    }, [sessionApi, exercise.id, index])

    const handleMarkFailed = React.useCallback(() => {
        if (!sessionApi) return
        const partial = window.prompt('Câte reps ai apucat? (lasă gol dacă nu știi)')
        const partialReps = partial && /^\d+$/.test(partial) ? parseInt(partial, 10) : undefined
        sessionApi.logSet(
            exercise,
            index - 1,
            { failed: true, partialReps, completed: true },
            { plannedSet, startRest: false },
        )
    }, [sessionApi, exercise, index, plannedSet])

    const handleAddNote = React.useCallback(() => {
        if (!sessionApi) return
        const existing = sessionApi.getLogged(exercise.id, index - 1)?.notes ?? ''
        const note = window.prompt('Notă pentru acest set:', existing)
        if (note === null) return
        sessionApi.logSet(
            exercise,
            index - 1,
            { notes: note.trim() || undefined, completed: status === 'done' || status === 'failed' },
            { plannedSet, startRest: false },
        )
    }, [sessionApi, exercise, index, plannedSet, status])

    return (
        <li
            className={cn(
                "group/set-row relative grid grid-cols-[auto_5rem_1fr_auto_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                rowKindClass(setKind, status),
                isCurrent && isInteractive && status === 'pending' && "ring-2 ring-primary/40 ring-offset-1 ring-offset-background",
                prPulse && "ring-2 ring-amber-400/80 ring-offset-1 ring-offset-background motion-safe:animate-pulse",
                className,
            )}
            data-set-kind={setKind}
            data-set-status={status}
        >
            <StatusButton
                status={status}
                setKind={setKind}
                interactive={!!isInteractive}
                onClick={handleCheckClick}
            />

            <div className="flex flex-col leading-tight">
                <span className="text-[11px] font-medium tabular-nums text-foreground/55">
                    Set {index}
                </span>
                {setKind !== 'working' ? (
                    <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] font-medium uppercase tracking-wider", setKindBadgeClass(setKind))}>
                        {formatSetKind(setKind)}
                        <GlossaryInfo term={setKind} />
                    </span>
                ) : null}
            </div>

            <div className="min-w-0">
                <PrimaryMetric
                    plannedSet={plannedSet}
                    logged={logged}
                    exerciseKind={exercise.kind}
                    units={units}
                    interactive={!!isInteractive}
                    onWeightClick={() => setWeightPickerOpen(true)}
                    onRepsClick={() => setRepsPickerOpen(true)}
                />
                {(plannedSet.notes || logged?.notes) ? (
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={logged?.notes ?? plannedSet.notes}>
                        {logged?.notes ?? plannedSet.notes}
                    </div>
                ) : null}
            </div>

            <RpePill rpe={plannedSet.rpe} rir={plannedSet.rir} loggedRpe={logged?.actualRpe} loggedRir={logged?.actualRir} />

            <div className="relative">
                <button
                    type="button"
                    aria-label="Set actions"
                    title="Set actions"
                    disabled={!isInteractive}
                    onClick={() => setMenuOpen((o) => !o)}
                    className={cn(
                        "flex size-7 items-center justify-center rounded-md text-muted-foreground/55 transition-colors",
                        "hover:bg-muted hover:text-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
                    )}
                >
                    <MoreVertical className="size-3.5" />
                </button>
                <SetActionsMenu
                    open={menuOpen}
                    onClose={() => setMenuOpen(false)}
                    onSkip={handleSkip}
                    onMarkFailed={handleMarkFailed}
                    onAddNote={handleAddNote}
                    canSkip={status === 'done' || status === 'failed'}
                    canMarkFailed={true}
                />
            </div>

            {prPulse ? (
                <span
                    aria-hidden
                    className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 text-amber-500 motion-safe:animate-ping"
                >
                    <Sparkles className="size-3.5" strokeWidth={1.85} />
                </span>
            ) : null}

            {weightPickerOpen && (
                <div className="absolute right-0 top-full z-30 mt-1">
                    <WeightPicker
                        initialKg={
                            (logged?.actualWeightKg
                                ?? (plannedSet as unknown as { weightKg?: number }).weightKg
                                ?? 0)
                        }
                        barKg={barKg}
                        plates={plates}
                        reps={
                            typeof logged?.actualReps === 'number'
                                ? logged.actualReps
                                : typeof (plannedSet as unknown as { reps?: number | [number, number] }).reps === 'number'
                                    ? ((plannedSet as unknown as { reps: number }).reps)
                                    : Array.isArray((plannedSet as unknown as { reps?: unknown }).reps)
                                        ? (((plannedSet as unknown as { reps: [number, number] }).reps)[1])
                                        : undefined
                        }
                        onApply={handleWeightApply}
                        onClose={() => setWeightPickerOpen(false)}
                    />
                </div>
            )}

            {repsPickerOpen && (
                <div className="absolute right-0 top-full z-30 mt-1">
                    <RepsPicker
                        initialReps={
                            logged?.actualReps
                            ?? (typeof (plannedSet as unknown as { reps?: number | [number, number] }).reps === 'number'
                                ? ((plannedSet as unknown as { reps: number }).reps)
                                : Array.isArray((plannedSet as unknown as { reps?: unknown }).reps)
                                    ? (((plannedSet as unknown as { reps: [number, number] }).reps)[1])
                                    : 0)
                        }
                        plannedRange={(plannedSet as unknown as { reps?: number | [number, number] }).reps}
                        onApply={handleRepsApply}
                        onClose={() => setRepsPickerOpen(false)}
                    />
                </div>
            )}
        </li>
    )
}

type SetStatus = 'pending' | 'done' | 'failed' | 'modified'

function computeStatus(logged?: LoggedSet): SetStatus {
    if (!logged) return 'pending'
    if (logged.failed) return 'failed'
    if (!logged.completed) return 'pending'
    return 'done'
}

function StatusButton({
    status,
    setKind,
    interactive,
    onClick,
}: {
    status: SetStatus
    setKind: string
    interactive: boolean
    onClick: () => void
}) {
    const ariaLabel = status === 'done' ? 'Anulează setul' : status === 'failed' ? 'Anulează setul' : 'Marchează setul ca făcut'
    const inner = (() => {
        switch (status) {
            case 'done':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                        <Check className="size-3" strokeWidth={3} />
                    </span>
                )
            case 'failed':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-rose-500/20 text-rose-600 dark:text-rose-400">
                        <span className="text-[11px] font-bold">×</span>
                    </span>
                )
            case 'modified':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-400">
                        <Check className="size-3" strokeWidth={3} />
                    </span>
                )
            default:
                return (
                    <span className={cn(
                        "flex size-5 items-center justify-center rounded-full border-2",
                        setKind === 'amrap'
                            ? "border-violet-500/55 text-violet-500"
                            : setKind === 'top_set'
                                ? "border-primary/65 text-primary"
                                : "border-border text-muted-foreground/55",
                    )}>
                        {setKind === 'amrap' ? <Zap className="size-2.5" /> : <Circle className="size-2 fill-current" />}
                    </span>
                )
        }
    })()
    return (
        <button
            type="button"
            aria-label={ariaLabel}
            title={ariaLabel}
            disabled={!interactive}
            onClick={onClick}
            className={cn(
                "flex items-center justify-center rounded-full transition-transform",
                interactive && "cursor-pointer hover:scale-110 active:scale-95",
                !interactive && "cursor-default",
            )}
        >
            {inner}
        </button>
    )
}

function rowKindClass(setKind: string, status: SetStatus): string {
    if (status === 'done') return 'bg-emerald-500/[0.05]'
    if (status === 'failed') return 'bg-rose-500/[0.06]'
    if (status === 'modified') return 'bg-amber-500/[0.06]'
    switch (setKind) {
        case 'warmup':
            return 'opacity-75'
        case 'top_set':
            return 'border-l-2 border-primary/60 pl-2'
        case 'drop_set':
            return 'bg-amber-500/[0.04]'
        case 'amrap':
            return 'bg-violet-500/[0.04]'
        case 'cluster':
            return 'bg-sky-500/[0.04]'
        default:
            return ''
    }
}

function setKindBadgeClass(setKind: string): string {
    switch (setKind) {
        case 'warmup': return 'text-muted-foreground'
        case 'top_set': return 'text-primary'
        case 'back_off': return 'text-muted-foreground'
        case 'drop_set': return 'text-amber-600 dark:text-amber-400'
        case 'amrap': return 'text-violet-600 dark:text-violet-400'
        case 'cluster': return 'text-sky-600 dark:text-sky-400'
        default: return 'text-muted-foreground'
    }
}

function RpePill({
    rpe,
    rir,
    loggedRpe,
    loggedRir,
}: {
    rpe?: number
    rir?: number
    loggedRpe?: number
    loggedRir?: number
}) {
    const value = loggedRpe ?? loggedRir ?? rpe ?? rir
    const isLogged = loggedRpe !== undefined || loggedRir !== undefined
    const label = loggedRpe !== undefined || rpe !== undefined ? 'RPE' : 'RIR'
    if (value === undefined) return <span className="w-0" aria-hidden />
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums",
                isLogged
                    ? "bg-foreground/10 text-foreground"
                    : "bg-foreground/[0.04] text-muted-foreground",
            )}
            title={isLogged ? `Logged ${label} ${value}` : `Target ${label} ${value}`}
        >
            {label} {value}
            <GlossaryInfo term={label.toLowerCase()} />
        </span>
    )
}

type AnyPlanned = Record<string, unknown> & { reps?: unknown }

function PrimaryMetric({
    plannedSet,
    logged,
    exerciseKind,
    units,
    interactive,
    onWeightClick,
    onRepsClick,
}: {
    plannedSet: PlannedSet
    logged?: LoggedSet
    exerciseKind: Exercise['kind']
    units: WorkoutUnits
    interactive: boolean
    onWeightClick: () => void
    onRepsClick: () => void
}) {
    const set = plannedSet as unknown as AnyPlanned
    const editableClass = interactive
        ? "cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-foreground/[0.06] -mx-1 -my-0.5"
        : ""

    switch (exerciseKind) {
        case 'weighted':
        case 'weighted_bw': {
            const plannedWeight = typeof set.weightKg === 'number' ? set.weightKg : undefined
            const plannedReps = set.reps
            const actualWeight = logged?.actualWeightKg
            const actualReps = logged?.actualReps ?? logged?.partialReps
            const weightStr = actualWeight !== undefined
                ? formatWeightNumber(actualWeight)
                : plannedWeight !== undefined
                    ? formatWeightNumber(plannedWeight)
                    : '–'
            const repsStr = actualReps !== undefined
                ? actualReps.toString()
                : plannedReps !== undefined
                    ? formatRepRange(plannedReps as never)
                    : '–'
            return (
                <span className="font-medium tabular-nums text-foreground">
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onWeightClick : undefined}
                        className={editableClass}
                    >
                        {weightStr}<span className="ml-0.5 text-muted-foreground/60">{units}</span>
                    </button>
                    <span className="mx-1 text-muted-foreground/60">×</span>
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onRepsClick : undefined}
                        className={editableClass}
                    >
                        {repsStr}
                    </button>
                    {logged?.failed && logged.partialReps !== undefined ? (
                        <span className="ml-1 text-[11px] text-rose-500">/ failed</span>
                    ) : null}
                </span>
            )
        }
        case 'bodyweight': {
            const actualReps = logged?.actualReps
            const plannedReps = set.reps
            const repsStr = actualReps !== undefined
                ? actualReps.toString()
                : plannedReps !== undefined
                    ? formatRepRange(plannedReps as never)
                    : '–'
            return (
                <span className="font-medium tabular-nums text-foreground">
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onRepsClick : undefined}
                        className={editableClass}
                    >
                        {repsStr} <span className="text-muted-foreground/60">reps</span>
                    </button>
                </span>
            )
        }
        case 'hold': {
            const seconds = logged?.actualDurationSec ?? (set.durationSec as number)
            return (
                <span className="font-medium tabular-nums text-foreground">
                    {formatDuration(seconds)}
                </span>
            )
        }
        case 'cardio_dur': {
            const targetMetric = typeof set.targetMetric === 'string' ? set.targetMetric : undefined
            return (
                <span className="font-medium tabular-nums text-foreground">
                    {formatDuration(set.durationSec as number)}
                    {targetMetric ? (
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">· {targetMetric}</span>
                    ) : null}
                </span>
            )
        }
        case 'cardio_dist': {
            const targetMetric = typeof set.targetMetric === 'string' ? set.targetMetric : undefined
            return (
                <span className="font-medium tabular-nums text-foreground">
                    {formatDistance(set.distanceM as number, units)}
                    {targetMetric ? (
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">· {targetMetric}</span>
                    ) : null}
                </span>
            )
        }
        case 'interval': {
            const intraRestSec = typeof set.intraRestSec === 'number' ? set.intraRestSec : undefined
            return (
                <span className="font-medium tabular-nums text-foreground">
                    {set.rounds as number}×{formatDuration(set.workSec as number)}
                    {intraRestSec ? (
                        <span className="text-muted-foreground/60"> / {formatDuration(intraRestSec)}</span>
                    ) : null}
                </span>
            )
        }
        default:
            return null
    }
}
