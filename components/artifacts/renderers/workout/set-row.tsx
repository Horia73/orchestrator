"use client"

import * as React from "react"
import { Check, MoreVertical, Play, Save, SkipForward, Sparkles, Timer, Zap } from "lucide-react"

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
import { findGlossaryTermsInText } from "@/lib/workout/glossary"
import { isNewPersonalBest, type ActiveSetState, type WorkoutSessionApi } from "@/lib/workout/use-workout-session"

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
    groupRestSec,
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
    /** Group-level rest fallback for supersets/circuits. */
    groupRestSec?: number
    /** Bar weight in kg for the plate calculator. */
    barKg?: number
    /** Available plates in kg, descending. */
    plates?: readonly number[]
    /** Highlight as "next to do". */
    isCurrent?: boolean
    className?: string
}) {
    const logged = sessionApi?.getLogged(exercise.id, index - 1)
    const activeSet = sessionApi?.session.activeSet
    const isThisActiveSet = activeSet?.exerciseId === exercise.id && activeSet.setIndex === index - 1
    const status = computeStatus(logged, isThisActiveSet, activeSet?.finishedAt)
    const setKind = plannedSet.kind ?? 'working'

    const [weightPickerOpen, setWeightPickerOpen] = React.useState(false)
    const [repsPickerOpen, setRepsPickerOpen] = React.useState(false)
    const [menuOpen, setMenuOpen] = React.useState(false)
    const [manualEditorOpen, setManualEditorOpen] = React.useState(false)
    const [noteEditorOpen, setNoteEditorOpen] = React.useState(false)
    const [prPulse, setPrPulse] = React.useState(false)
    const activeEditorOpen = isThisActiveSet && !!activeSet?.finishedAt
    const editorActiveSet = activeEditorOpen ? activeSet : undefined
    const editorOpen = activeEditorOpen || manualEditorOpen
    const [draft, setDraft] = React.useState<SetDraft>(() => buildSetDraft(plannedSet, logged, exercise.kind, editorActiveSet))

    const isInteractive = !!interactive && !!sessionApi
    const metricEditable = isInteractive && (status === 'done' || status === 'failed')
    const statusButtonInteractive = isInteractive && (status !== 'pending' || !!sessionApi?.isActive)

    React.useEffect(() => {
        if (!editorOpen) return
        setDraft(buildSetDraft(plannedSet, logged, exercise.kind, editorActiveSet))
    }, [editorOpen, plannedSet, logged, exercise.kind, editorActiveSet])

    React.useEffect(() => {
        if (!isInteractive) setManualEditorOpen(false)
    }, [isInteractive])

    React.useEffect(() => {
        if (!isInteractive) setNoteEditorOpen(false)
    }, [isInteractive])

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
        if (status === 'done' || status === 'failed' || status === 'skipped') {
            sessionApi.undoSet(exercise.id, index - 1)
        } else if (status === 'running') {
            sessionApi.finishActiveSet()
        } else if (status === 'editing') {
            return
        } else {
            if (!sessionApi.isActive) return
            if (sessionApi.session.activeSet) {
                window.alert('Save or cancel the set in progress before starting another.')
                return
            }
            sessionApi.startSet(exercise, index - 1)
        }
    }, [isInteractive, sessionApi, status, exercise, index])

    const handleWeightApply = React.useCallback((newKg: number) => {
        if (!sessionApi) return
        sessionApi.logSet(exercise, index - 1, { actualWeightKg: newKg }, { plannedSet, startRest: false })
        setWeightPickerOpen(false)
    }, [sessionApi, exercise, index, plannedSet])

    const handleRepsApply = React.useCallback((newReps: number) => {
        if (!sessionApi) return
        sessionApi.logSet(exercise, index - 1, { actualReps: newReps }, { plannedSet, startRest: false })
        setRepsPickerOpen(false)
    }, [sessionApi, exercise, index, plannedSet])

    const handleSkip = React.useCallback(() => {
        if (!sessionApi) return
        const existing = sessionApi.getLogged(exercise.id, index - 1)?.skipReason ?? ''
        const reason = window.prompt('Optional reason for skipping:', existing)
        if (reason === null) return
        sessionApi.skipSet(exercise.id, index - 1, reason)
    }, [sessionApi, exercise.id, index])

    const handleMarkFailed = React.useCallback(() => {
        if (!sessionApi) return
        const partial = window.prompt('How many reps did you get? (leave blank if unsure)')
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
        setMenuOpen(false)
        setNoteEditorOpen(true)
    }, [sessionApi])

    const handleSaveNote = React.useCallback((note: string) => {
        if (!sessionApi) return
        sessionApi.setNote(exercise.id, index - 1, note)
        setNoteEditorOpen(false)
    }, [sessionApi, exercise.id, index])

    const handleEditSet = React.useCallback(() => {
        if (!metricEditable) return
        setManualEditorOpen(true)
    }, [metricEditable])

    const editorElapsedSec = editorActiveSet?.finishedAt && editorActiveSet.startedAt
        ? Math.max(0, Math.round((editorActiveSet.finishedAt - editorActiveSet.startedAt) / 1000))
        : loggedDurationSec(logged)

    const handleSaveEditor = React.useCallback(() => {
        if (!sessionApi) return
        const timing = editorTiming(editorActiveSet, logged)
        sessionApi.logSet(exercise, index - 1, draftToLoggedSet(draft, exercise.kind, timing), {
            plannedSet,
            groupRestSec,
            startRest: !!editorActiveSet,
        })
        if (!editorActiveSet) setManualEditorOpen(false)
    }, [sessionApi, editorActiveSet, logged, exercise, index, draft, plannedSet, groupRestSec])

    const handleCancelEditor = React.useCallback(() => {
        if (editorActiveSet) sessionApi?.cancelActiveSet()
        else setManualEditorOpen(false)
    }, [editorActiveSet, sessionApi])

    const detailText = logged?.skipped
        ? `Skipped${logged.skipReason ? `: ${logged.skipReason}` : ''}`
        : logged?.notes ?? plannedSet.notes

    return (
        <li
            className={cn(
                "group/set-row relative grid grid-cols-[auto_minmax(3.75rem,4.75rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors sm:grid-cols-[auto_5rem_1fr_auto_auto]",
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
                interactive={!!statusButtonInteractive}
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
                    interactive={metricEditable}
                    onWeightClick={() => setWeightPickerOpen(true)}
                    onRepsClick={() => setRepsPickerOpen(true)}
                    onEditClick={handleEditSet}
                />
                {detailText ? (
                    <div
                        className={cn(
                            "mt-0.5 truncate text-[11px]",
                            logged?.skipped ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground",
                        )}
                        title={detailText}
                    >
                        {detailText}
                    </div>
                ) : null}
            </div>

            <div className="hidden sm:block">
                <RpePill rpe={plannedSet.rpe} rir={plannedSet.rir} loggedRpe={logged?.actualRpe} loggedRir={logged?.actualRir} />
            </div>

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
                    onEdit={handleEditSet}
                    onSkip={handleSkip}
                    onMarkFailed={handleMarkFailed}
                    onAddNote={handleAddNote}
                    canEdit={metricEditable}
                    canSkip={status !== 'skipped'}
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

            <div className="col-start-3 col-end-5 sm:hidden">
                <RpePill rpe={plannedSet.rpe} rir={plannedSet.rir} loggedRpe={logged?.actualRpe} loggedRir={logged?.actualRir} />
            </div>

            {editorOpen ? (
                <ActiveSetEditor
                    draft={draft}
                    setDraft={setDraft}
                    exerciseKind={exercise.kind}
                    units={units}
                    elapsedSec={editorElapsedSec}
                    onSave={handleSaveEditor}
                    onCancel={handleCancelEditor}
                />
            ) : null}

            {noteEditorOpen ? (
                <SetNoteDialog
                    exerciseName={exercise.name}
                    setIndex={index}
                    initialNote={logged?.notes ?? ''}
                    onSave={handleSaveNote}
                    onCancel={() => setNoteEditorOpen(false)}
                />
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

type SetStatus = 'pending' | 'running' | 'editing' | 'done' | 'failed' | 'skipped' | 'modified'

function computeStatus(logged?: LoggedSet, active?: boolean, finishedAt?: number): SetStatus {
    if (active) return finishedAt ? 'editing' : 'running'
    if (!logged) return 'pending'
    if (logged.skipped) return 'skipped'
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
    const ariaLabel =
        status === 'done' || status === 'failed'
            ? 'Undo set'
            : status === 'skipped'
                ? 'Undo skip'
            : status === 'running'
                ? 'Finish set'
                : status === 'editing'
                    ? 'Edit and save set'
                    : 'Start set timer'
    const inner = (() => {
        switch (status) {
            case 'running':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary motion-safe:animate-pulse">
                        <Timer className="size-3" strokeWidth={2.5} />
                    </span>
                )
            case 'editing':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                        <Save className="size-3" strokeWidth={2.5} />
                    </span>
                )
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
            case 'skipped':
                return (
                    <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
                        <SkipForward className="size-3" strokeWidth={2.5} />
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
                        {setKind === 'amrap' ? <Zap className="size-2.5" /> : <Play className="ml-0.5 size-2.5 fill-current" />}
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
    if (status === 'running') return 'bg-primary/[0.06] ring-1 ring-primary/25'
    if (status === 'editing') return 'bg-emerald-500/[0.06] ring-1 ring-emerald-500/30'
    if (status === 'done') return 'bg-emerald-500/[0.05]'
    if (status === 'failed') return 'bg-rose-500/[0.06]'
    if (status === 'skipped') return 'bg-amber-500/[0.05] opacity-80'
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

interface SetDraft {
    weightKg?: number
    reps?: number
    durationSec?: number
    distanceM?: number
    rpe?: number
    rir?: number
    notes: string
}

function buildSetDraft(
    plannedSet: PlannedSet,
    logged: LoggedSet | undefined,
    exerciseKind: Exercise['kind'],
    activeSet: ActiveSetState | undefined,
): SetDraft {
    const planned = plannedSet as unknown as Record<string, unknown>
    const elapsedSec = activeSet
        ? Math.max(0, Math.round(((activeSet.finishedAt ?? Date.now()) - activeSet.startedAt) / 1000))
        : undefined
    const reps = logged?.actualReps
        ?? logged?.partialReps
        ?? (typeof planned.reps === 'number'
            ? planned.reps
            : Array.isArray(planned.reps)
                ? (planned.reps as [number, number])[1]
                : undefined)

    return {
        weightKg: logged?.actualWeightKg ?? (typeof planned.weightKg === 'number' ? planned.weightKg : undefined),
        reps,
        durationSec: logged?.actualDurationSec
            ?? (exerciseKind === 'interval'
                ? elapsedSec
                : typeof planned.durationSec === 'number'
                    ? planned.durationSec
                    : elapsedSec),
        distanceM: logged?.actualDistanceM ?? (typeof planned.distanceM === 'number' ? planned.distanceM : undefined),
        rpe: logged?.actualRpe,
        rir: logged?.actualRir,
        notes: logged?.notes ?? '',
    }
}

interface EditorTiming {
    startedAtMs: number
    completedAtMs: number
}

function editorTiming(activeSet: ActiveSetState | undefined, logged: LoggedSet | undefined): EditorTiming {
    if (activeSet) {
        return {
            startedAtMs: activeSet.startedAt,
            completedAtMs: activeSet.finishedAt ?? Date.now(),
        }
    }
    const completedAtMs = dateMs(logged?.completedAt) ?? Date.now()
    return {
        startedAtMs: dateMs(logged?.startedAt) ?? completedAtMs,
        completedAtMs,
    }
}

function dateMs(value: string | undefined): number | undefined {
    if (!value) return undefined
    const ms = new Date(value).getTime()
    return Number.isFinite(ms) ? ms : undefined
}

function loggedDurationSec(logged: LoggedSet | undefined): number {
    if (typeof logged?.actualDurationSec === 'number') return logged.actualDurationSec
    const startedAtMs = dateMs(logged?.startedAt)
    const completedAtMs = dateMs(logged?.completedAt)
    if (startedAtMs !== undefined && completedAtMs !== undefined) {
        return Math.max(0, Math.round((completedAtMs - startedAtMs) / 1000))
    }
    return 0
}

function draftToLoggedSet(
    draft: SetDraft,
    exerciseKind: Exercise['kind'],
    timing: EditorTiming,
): Partial<LoggedSet> {
    const logged: Partial<LoggedSet> = {
        completed: true,
        startedAt: new Date(timing.startedAtMs).toISOString(),
        completedAt: new Date(timing.completedAtMs).toISOString(),
        actualRpe: draft.rpe,
        actualRir: draft.rir,
        notes: draft.notes.trim() || undefined,
    }

    if (exerciseKind === 'weighted' || exerciseKind === 'weighted_bw') {
        logged.actualWeightKg = draft.weightKg
        logged.actualReps = draft.reps
    } else if (exerciseKind === 'bodyweight') {
        logged.actualReps = draft.reps
    } else if (exerciseKind === 'hold' || exerciseKind === 'cardio_dur' || exerciseKind === 'interval') {
        logged.actualDurationSec = draft.durationSec
    } else if (exerciseKind === 'cardio_dist') {
        logged.actualDistanceM = draft.distanceM
    }

    return logged
}

function ActiveSetEditor({
    draft,
    setDraft,
    exerciseKind,
    units,
    elapsedSec,
    onSave,
    onCancel,
}: {
    draft: SetDraft
    setDraft: React.Dispatch<React.SetStateAction<SetDraft>>
    exerciseKind: Exercise['kind']
    units: WorkoutUnits
    elapsedSec: number
    onSave: () => void
    onCancel: () => void
}) {
    return (
        <div className="col-span-full mt-1 rounded-lg border border-emerald-500/25 bg-background/90 p-2.5 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                    <Timer className="size-3.5" strokeWidth={1.85} />
                    Set time <span className="tabular-nums">{formatDuration(elapsedSec)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">Confirm your actuals</div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(exerciseKind === 'weighted' || exerciseKind === 'weighted_bw') ? (
                    <NumberField
                        label={`Weight (${units})`}
                        value={draft.weightKg}
                        step={0.5}
                        onChange={(weightKg) => setDraft((d) => ({ ...d, weightKg }))}
                    />
                ) : null}

                {(exerciseKind === 'weighted' || exerciseKind === 'weighted_bw' || exerciseKind === 'bodyweight') ? (
                    <NumberField
                        label="Reps"
                        value={draft.reps}
                        step={1}
                        onChange={(reps) => setDraft((d) => ({ ...d, reps }))}
                    />
                ) : null}

                {(exerciseKind === 'hold' || exerciseKind === 'cardio_dur' || exerciseKind === 'interval') ? (
                    <NumberField
                        label="Duration (sec)"
                        value={draft.durationSec}
                        step={5}
                        inputKind="duration"
                        onChange={(durationSec) => setDraft((d) => ({ ...d, durationSec }))}
                    />
                ) : null}

                {exerciseKind === 'cardio_dist' ? (
                    <NumberField
                        label="Distance (m)"
                        value={draft.distanceM}
                        step={10}
                        inputKind="distance"
                        onChange={(distanceM) => setDraft((d) => ({ ...d, distanceM }))}
                    />
                ) : null}

                <NumberField
                    label="RPE"
                    value={draft.rpe}
                    step={0.5}
                    min={1}
                    max={10}
                    infoTerm="rpe"
                    onChange={(rpe) => setDraft((d) => ({ ...d, rpe }))}
                />
                <NumberField
                    label="RIR"
                    value={draft.rir}
                    step={1}
                    min={0}
                    max={5}
                    infoTerm="rir"
                    onChange={(rir) => setDraft((d) => ({ ...d, rir }))}
                />
            </div>

            <label className="mt-2 block">
                <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                    Note
                </span>
                <input
                    value={draft.notes}
                    onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
                    placeholder="e.g. good form, too heavy, shoulder ok"
                    className="h-10 w-full rounded-md border border-border bg-background px-2.5 text-base text-foreground outline-none transition-shadow focus:ring-2 focus:ring-ring sm:h-9 sm:text-[12.5px]"
                />
            </label>

            <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    onClick={onCancel}
                    className="inline-flex h-8 items-center rounded-md border border-border bg-background px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[11.5px] font-semibold text-white transition-colors hover:bg-emerald-700"
                >
                    <Save className="size-3" strokeWidth={2} />
                    Save set
                </button>
            </div>
        </div>
    )
}

function SetNoteDialog({
    exerciseName,
    setIndex,
    initialNote,
    onSave,
    onCancel,
}: {
    exerciseName: string
    setIndex: number
    initialNote: string
    onSave: (note: string) => void
    onCancel: () => void
}) {
    const [note, setNote] = React.useState(initialNote)
    const textAreaRef = React.useRef<HTMLTextAreaElement>(null)

    React.useEffect(() => {
        textAreaRef.current?.focus()
        textAreaRef.current?.select()
    }, [])

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Set note"
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation()
                    onCancel()
                }
            }}
        >
            <div className="w-full max-w-sm rounded-xl border border-border/70 bg-popover p-4 shadow-xl">
                <div className="text-sm font-semibold text-foreground">
                    Note for set
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {exerciseName} · set {setIndex}
                </p>
                <label className="mt-3 block">
                    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                        Note
                    </span>
                    <textarea
                        ref={textAreaRef}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        maxLength={400}
                        rows={4}
                        placeholder="e.g. good form, too heavy, shoulder ok"
                        className="min-h-28 w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-base leading-relaxed text-foreground outline-none transition-shadow placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-ring sm:text-[13px]"
                    />
                </label>
                <div className="mt-1 text-right text-[10.5px] tabular-nums text-muted-foreground">
                    {note.length}/400
                </div>
                <div className="mt-3 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => onSave(note)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:opacity-90"
                    >
                        <Save className="size-3.5" strokeWidth={2} />
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}

function NumberField({
    label,
    value,
    step,
    min = 0,
    max,
    inputKind = 'number',
    infoTerm,
    onChange,
}: {
    label: string
    value?: number
    step: number
    min?: number
    max?: number
    inputKind?: 'number' | 'duration' | 'distance'
    infoTerm?: string
    onChange: (value: number | undefined) => void
}) {
    return (
        <label className="min-w-0">
            <span className="mb-1 flex min-w-0 items-center gap-1 truncate text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
                {infoTerm ? <GlossaryInfo term={infoTerm} /> : null}
            </span>
            <input
                type="text"
                inputMode={inputKind === 'number' ? (step % 1 === 0 ? "numeric" : "decimal") : "text"}
                value={value ?? ''}
                onChange={(event) => {
                    const raw = event.target.value.trim()
                    if (raw === '') {
                        onChange(undefined)
                        return
                    }
                    const next = parseNumberFieldValue(raw, inputKind)
                    if (next === undefined) return
                    onChange(clampNumber(next, min, max))
                }}
                className="h-10 w-full rounded-md border border-border bg-background px-2 text-right text-base font-semibold tabular-nums text-foreground outline-none transition-shadow focus:ring-2 focus:ring-ring sm:h-9 sm:text-[13px]"
            />
        </label>
    )
}

function parseNumberFieldValue(raw: string, inputKind: 'number' | 'duration' | 'distance'): number | undefined {
    const normalized = raw.trim().toLowerCase().replace(',', '.')
    if (!normalized) return undefined

    if (inputKind === 'duration') {
        const clock = parseClockDuration(normalized)
        if (clock !== undefined) return clock

        let total = 0
        let sawToken = false
        let sawUnit = false
        for (const match of normalized.matchAll(/(-?\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes|m|sec|secs|second|seconds|s)?/g)) {
            const value = Number.parseFloat(match[1])
            if (!Number.isFinite(value)) continue
            sawToken = true
            const unit = match[2]
            if (!unit) {
                total += value
                continue
            }
            sawUnit = true
            if (unit.startsWith('h')) total += value * 3600
            else if (unit === 'm' || unit.startsWith('min')) total += value * 60
            else total += value
        }
        if (sawToken && sawUnit) return total
    }

    if (inputKind === 'distance') {
        const distance = normalized.match(/^(-?\d+(?:\.\d+)?)\s*(km|kilometer|kilometers|m|meter|meters)?$/)
        if (distance) {
            const value = Number.parseFloat(distance[1])
            if (!Number.isFinite(value)) return undefined
            const unit = distance[2]
            return unit?.startsWith('k') ? value * 1000 : value
        }
    }

    const next = Number.parseFloat(normalized)
    return Number.isFinite(next) ? next : undefined
}

function parseClockDuration(value: string): number | undefined {
    if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(value)) return undefined
    const parts = value.split(':').map((part) => Number.parseInt(part, 10))
    if (parts.some((part) => !Number.isFinite(part))) return undefined
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function clampNumber(value: number, min: number, max?: number): number {
    const minBounded = Math.max(min, value)
    return max === undefined ? minBounded : Math.min(max, minBounded)
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
    onEditClick,
}: {
    plannedSet: PlannedSet
    logged?: LoggedSet
    exerciseKind: Exercise['kind']
    units: WorkoutUnits
    interactive: boolean
    onWeightClick: () => void
    onRepsClick: () => void
    onEditClick: () => void
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
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onEditClick : undefined}
                        className={editableClass}
                    >
                        {formatDuration(seconds)}
                    </button>
                </span>
            )
        }
        case 'cardio_dur': {
            const targetMetric = typeof set.targetMetric === 'string' ? set.targetMetric : undefined
            const seconds = logged?.actualDurationSec ?? (set.durationSec as number)
            return (
                <span className="font-medium tabular-nums text-foreground">
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onEditClick : undefined}
                        className={editableClass}
                    >
                        {formatDuration(seconds)}
                    </button>
                    <TargetMetricText text={targetMetric} />
                </span>
            )
        }
        case 'cardio_dist': {
            const targetMetric = typeof set.targetMetric === 'string' ? set.targetMetric : undefined
            const distance = logged?.actualDistanceM ?? (set.distanceM as number)
            return (
                <span className="font-medium tabular-nums text-foreground">
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onEditClick : undefined}
                        className={editableClass}
                    >
                        {formatDistance(distance, units)}
                    </button>
                    <TargetMetricText text={targetMetric} />
                </span>
            )
        }
        case 'interval': {
            const intraRestSec = typeof set.intraRestSec === 'number' ? set.intraRestSec : undefined
            const actualDuration = logged?.actualDurationSec
            return (
                <span className="font-medium tabular-nums text-foreground">
                    <button
                        type="button"
                        disabled={!interactive}
                        onClick={interactive ? onEditClick : undefined}
                        className={editableClass}
                    >
                        {actualDuration !== undefined
                            ? formatDuration(actualDuration)
                            : `${set.rounds as number}×${formatDuration(set.workSec as number)}`}
                    </button>
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

function TargetMetricText({ text }: { text?: string }) {
    if (!text) return null
    const terms = findGlossaryTermsInText(text)
    return (
        <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] font-normal text-muted-foreground">
            · {text}
            {terms.map((term) => (
                <GlossaryInfo key={term} term={term} />
            ))}
        </span>
    )
}
