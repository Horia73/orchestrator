"use client"

import * as React from "react"

import type {
    Exercise,
    LoggedSet,
    PlannedSet,
    WorkoutArtifact,
} from "./schema"
import { estimated1RM } from "./one-rep-max"

// ---------------------------------------------------------------------------
// Workout session state.
//
// This hook owns ALL mutable state for an in-progress workout. The artifact
// payload is the static plan; everything the user does (start, check a set,
// adjust weight mid-workout, run the rest timer, finish) lives here.
//
// Storage strategy: localStorage, keyed by sessionId. The sessionId is
// embedded in the artifact by the model and stays stable across artifact
// version updates, so the same session resumes whether the renderer
// remounts, the page reloads, or the artifact source changes slightly.
//
// We write through a debounced effect (250ms) so chains of rapid actions
// don't thrash localStorage. State is restored on mount before any render
// of children (so they see the persisted values, not a flash of defaults).
//
// Rest timer is Date.now()-based — the same trick we use in the recipe
// TimerChip. A throttled tab, a backgrounded phone, or system sleep all
// recompute correctly from the absolute end timestamp.
// ---------------------------------------------------------------------------

const STORAGE_VERSION = 1
const STORAGE_KEY_PREFIX = 'workout:session:'

/**
 * Per-exercise session log. Mirrors the schema's `logged[]` but lives
 * outside the artifact so we don't mutate the artifact body itself.
 */
export interface ExerciseSessionLog {
    /** Sets in order — index aligns with the planned[i] until the user
     *  adds freestyle sets at the end. */
    sets: LoggedSet[]
    /** Whether the user explicitly skipped this exercise. */
    skipped?: boolean
}

/**
 * Rest timer state. When `endsAt` is set, the timer is running. The
 * `restTimerKey` lets the timer bar pulse-restart when a new rest fires
 * even if the duration happens to match.
 */
export interface RestState {
    /** Total duration in seconds (for the progress bar). */
    durationSec: number
    /** Date.now() value when the rest started. */
    startedAt: number
    /** Date.now() value when the rest ends — single source of truth. */
    endsAt: number
    /** Which exercise (and set index) the rest is for, for the label. */
    exerciseId: string
    exerciseName: string
    setIndex: number
    /** Increments each time we (re)start so the bar can replay its enter
     *  animation even if endsAt accidentally matches a previous one. */
    key: number
}

export interface ActiveSetState {
    /** Date.now() value when the working set started. */
    startedAt: number
    /** Date.now() value when the user tapped Finish. Undefined while running. */
    finishedAt?: number
    exerciseId: string
    exerciseName: string
    setIndex: number
    key: number
}

export interface WorkoutSessionState {
    sessionId: string
    /** ISO timestamp; unset until user hits Start. */
    startedAt?: string
    /** ISO timestamp; unset until user hits Finish. */
    completedAt?: string
    /** Per-exercise logs, keyed by exercise.id. */
    logsByExerciseId: Record<string, ExerciseSessionLog>
    /** Optional current rest timer state. */
    rest?: RestState
    /** Optional current working-set timer. A set is logged only after
     *  Finish -> edit actuals -> Save. */
    activeSet?: ActiveSetState
    /** Schema version for forward-migration tolerance. */
    _v: number
}

const EMPTY_STATE = (sessionId: string): WorkoutSessionState => ({
    sessionId,
    logsByExerciseId: {},
    _v: STORAGE_VERSION,
})

function storageKey(sessionId: string) {
    return STORAGE_KEY_PREFIX + sessionId
}

/**
 * Read persisted state. Returns empty state if missing, malformed, or from
 * an incompatible storage version. Never throws.
 */
function readPersistedState(sessionId: string): WorkoutSessionState {
    if (typeof window === 'undefined') return EMPTY_STATE(sessionId)
    try {
        const raw = window.localStorage.getItem(storageKey(sessionId))
        if (!raw) return EMPTY_STATE(sessionId)
        const parsed = JSON.parse(raw) as Partial<WorkoutSessionState>
        if (!parsed || parsed.sessionId !== sessionId || parsed._v !== STORAGE_VERSION) {
            return EMPTY_STATE(sessionId)
        }
        // Clear stale rest timer — if the page was closed mid-rest, when
        // we come back the rest is meaningless; better to drop it than
        // resume an alert from 6 hours ago.
        if (parsed.rest && parsed.rest.endsAt && parsed.rest.endsAt < Date.now() - 10 * 60 * 1000) {
            parsed.rest = undefined
        }
        if (parsed.activeSet?.startedAt && parsed.activeSet.startedAt < Date.now() - 12 * 60 * 60 * 1000) {
            parsed.activeSet = undefined
        }
        return {
            sessionId,
            startedAt: parsed.startedAt,
            completedAt: parsed.completedAt,
            logsByExerciseId: parsed.logsByExerciseId ?? {},
            rest: parsed.rest,
            activeSet: parsed.activeSet,
            _v: STORAGE_VERSION,
        }
    } catch {
        return EMPTY_STATE(sessionId)
    }
}

/**
 * Build the initial planned values for a set, used as defaults when the
 * user checks a set without adjusting anything.
 */
function plannedDefaults(plannedSet: PlannedSet, exerciseKind: Exercise['kind']): LoggedSet {
    const set = plannedSet as unknown as Record<string, unknown>
    const completedAt = new Date().toISOString()
    const base: LoggedSet = { completed: true, completedAt }
    switch (exerciseKind) {
        case 'weighted':
        case 'weighted_bw':
            if (typeof set.weightKg === 'number') base.actualWeightKg = set.weightKg
            if (typeof set.reps === 'number') base.actualReps = set.reps
            else if (Array.isArray(set.reps)) base.actualReps = (set.reps as [number, number])[1]
            return base
        case 'bodyweight':
            if (typeof set.reps === 'number') base.actualReps = set.reps
            else if (Array.isArray(set.reps)) base.actualReps = (set.reps as [number, number])[1]
            return base
        case 'hold':
            if (typeof set.durationSec === 'number') base.actualDurationSec = set.durationSec
            return base
        case 'cardio_dur':
            if (typeof set.durationSec === 'number') base.actualDurationSec = set.durationSec
            return base
        case 'cardio_dist':
            if (typeof set.distanceM === 'number') base.actualDistanceM = set.distanceM
            return base
        case 'interval':
            return base
    }
}

/**
 * Pick the rest duration to use after a given set: per-set override wins,
 * else exercise.defaultRestSec, else the artifact's group restBetweenSec,
 * else 90s safe default.
 */
function resolveRestSec(set: PlannedSet, exercise: Exercise, fallbackGroupRest?: number): number {
    const setRest = (set as unknown as { restSec?: number }).restSec
    if (typeof setRest === 'number') return setRest
    if (typeof exercise.defaultRestSec === 'number') return exercise.defaultRestSec
    if (typeof fallbackGroupRest === 'number') return fallbackGroupRest
    return 90
}

export interface WorkoutSessionApi {
    /** Current snapshot of the session. Re-renders on every change. */
    session: WorkoutSessionState
    /** Whether the user has tapped Start. */
    isActive: boolean
    /** True after Finish; renderer should show the summary. */
    isFinished: boolean
    /** Tap Start — sets startedAt and unlocks set check-ins. */
    start: () => void
    /** Tap Finish — sets completedAt. */
    finish: () => void
    /** Restart from scratch (clears local state). Used after Finish or for "Discard". */
    reset: () => void
    /** Log (or re-log) a set with optional overrides for actuals. */
    logSet: (
        exercise: Exercise,
        setIndex: number,
        overrides?: Partial<LoggedSet>,
        opts?: { plannedSet?: PlannedSet; groupRestSec?: number; startRest?: boolean }
    ) => void
    /** Clear the log for a set (mark not-done). */
    undoSet: (exerciseId: string, setIndex: number) => void
    /** Start/finish/cancel a working set timer before actuals are saved. */
    startSet: (exercise: Exercise, setIndex: number) => void
    finishActiveSet: () => void
    cancelActiveSet: () => void
    /** Mark an exercise skipped (or unskip). */
    setSkipped: (exerciseId: string, skipped: boolean) => void
    /** Append a freestyle set after the planned ones. */
    addSet: (exercise: Exercise, plannedSet: PlannedSet) => void
    /** Rest timer controls. */
    startRest: (durationSec: number, label: { exerciseId: string; exerciseName: string; setIndex: number }) => void
    adjustRest: (deltaSec: number) => void
    skipRest: () => void
    /** Get the logged set for an exercise+index, or undefined. */
    getLogged: (exerciseId: string, setIndex: number) => LoggedSet | undefined
}

export function useWorkoutSession(
    sessionId: string,
    workout: WorkoutArtifact,
): WorkoutSessionApi {
    const [session, setSession] = React.useState<WorkoutSessionState>(() => readPersistedState(sessionId))

    // Persist on change with debouncing. We coalesce rapid mutations so a
    // burst of "check, check, check" only writes once.
    const saveTimer = React.useRef<number | null>(null)
    React.useEffect(() => {
        if (typeof window === 'undefined') return
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
            try {
                window.localStorage.setItem(storageKey(sessionId), JSON.stringify(session))
            } catch {
                /* quota / privacy mode — fail silently */
            }
        }, 250)
        return () => {
            if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        }
    }, [session, sessionId])

    const isActive = !!session.startedAt && !session.completedAt
    const isFinished = !!session.completedAt

    const start = React.useCallback(() => {
        setSession((s) => (s.startedAt ? s : { ...s, startedAt: new Date().toISOString() }))
    }, [])

    const finish = React.useCallback(() => {
        setSession((s) => ({ ...s, completedAt: new Date().toISOString(), rest: undefined, activeSet: undefined }))
    }, [])

    const reset = React.useCallback(() => {
        setSession(EMPTY_STATE(sessionId))
    }, [sessionId])

    const ensureLog = (state: WorkoutSessionState, exerciseId: string): ExerciseSessionLog => {
        return state.logsByExerciseId[exerciseId] ?? { sets: [] }
    }

    const logSet = React.useCallback<WorkoutSessionApi['logSet']>(
        (exercise, setIndex, overrides, opts) => {
            const plannedSet = opts?.plannedSet ?? exercise.planned[setIndex]
            if (!plannedSet) return
            const restSec = resolveRestSec(plannedSet, exercise, opts?.groupRestSec)
            const wantsRest = opts?.startRest ?? true

            setSession((s) => {
                // Auto-start the session if user checks a set without explicit start.
                const startedAt = s.startedAt ?? new Date().toISOString()

                const prevLog = ensureLog(s, exercise.id)
                const existing = prevLog.sets[setIndex]
                const defaults = plannedDefaults(plannedSet, exercise.kind)
                const completedAt = overrides?.completedAt ?? new Date().toISOString()
                const startedAtForSet = overrides?.startedAt ?? existing?.startedAt ?? new Date().toISOString()
                const next: LoggedSet = {
                    ...defaults,
                    ...existing,
                    ...overrides,
                    completed: true,
                    completedAt,
                    startedAt: startedAtForSet,
                }
                const sets = prevLog.sets.slice()
                sets[setIndex] = next
                const logsByExerciseId = {
                    ...s.logsByExerciseId,
                    [exercise.id]: { ...prevLog, sets },
                }

                const rest: RestState | undefined = wantsRest
                    ? {
                        durationSec: restSec,
                        startedAt: Date.now(),
                        endsAt: Date.now() + restSec * 1000,
                        exerciseId: exercise.id,
                        exerciseName: exercise.name,
                        setIndex,
                        key: (s.rest?.key ?? 0) + 1,
                    }
                    : s.rest

                const activeSet = s.activeSet?.exerciseId === exercise.id && s.activeSet.setIndex === setIndex
                    ? undefined
                    : s.activeSet

                return { ...s, startedAt, logsByExerciseId, rest, activeSet }
            })
        },
        [],
    )

    const undoSet = React.useCallback((exerciseId: string, setIndex: number) => {
        setSession((s) => {
            const prevLog = s.logsByExerciseId[exerciseId]
            if (!prevLog) return s
            const sets = prevLog.sets.slice()
            sets[setIndex] = { completed: false }
            const activeSet = s.activeSet?.exerciseId === exerciseId && s.activeSet.setIndex === setIndex
                ? undefined
                : s.activeSet
            return {
                ...s,
                activeSet,
                logsByExerciseId: {
                    ...s.logsByExerciseId,
                    [exerciseId]: { ...prevLog, sets },
                },
            }
        })
    }, [])

    const startSet = React.useCallback<WorkoutSessionApi['startSet']>((exercise, setIndex) => {
        const nowMs = Date.now()
        const nowIso = new Date(nowMs).toISOString()
        setSession((s) => ({
            ...s,
            startedAt: s.startedAt ?? nowIso,
            completedAt: undefined,
            rest: undefined,
            activeSet: {
                startedAt: nowMs,
                exerciseId: exercise.id,
                exerciseName: exercise.name,
                setIndex,
                key: (s.activeSet?.key ?? 0) + 1,
            },
        }))
    }, [])

    const finishActiveSet = React.useCallback(() => {
        setSession((s) => {
            if (!s.activeSet || s.activeSet.finishedAt) return s
            return {
                ...s,
                activeSet: {
                    ...s.activeSet,
                    finishedAt: Date.now(),
                },
            }
        })
    }, [])

    const cancelActiveSet = React.useCallback(() => {
        setSession((s) => ({ ...s, activeSet: undefined }))
    }, [])

    const setSkipped = React.useCallback((exerciseId: string, skipped: boolean) => {
        setSession((s) => {
            const prevLog = ensureLog(s, exerciseId)
            return {
                ...s,
                logsByExerciseId: {
                    ...s.logsByExerciseId,
                    [exerciseId]: { ...prevLog, skipped },
                },
            }
        })
    }, [])

    const addSet = React.useCallback<WorkoutSessionApi['addSet']>(
        (exercise, plannedSet) => {
            const now = new Date().toISOString()
            const defaults = plannedDefaults(plannedSet, exercise.kind)
            setSession((s) => {
                const prevLog = ensureLog(s, exercise.id)
                const sets = prevLog.sets.slice()
                // Append at the end. Index is sets.length (after push).
                sets.push({ ...defaults, completed: true, completedAt: now, startedAt: now })
                return {
                    ...s,
                    startedAt: s.startedAt ?? now,
                    logsByExerciseId: {
                        ...s.logsByExerciseId,
                        [exercise.id]: { ...prevLog, sets },
                    },
                    // Don't auto-start rest — the user just confirmed the values;
                    // they can start rest manually if they want it.
                }
            })
        },
        [],
    )

    const startRest = React.useCallback<WorkoutSessionApi['startRest']>((durationSec, label) => {
        setSession((s) => ({
            ...s,
            rest: {
                durationSec,
                startedAt: Date.now(),
                endsAt: Date.now() + durationSec * 1000,
                exerciseId: label.exerciseId,
                exerciseName: label.exerciseName,
                setIndex: label.setIndex,
                key: (s.rest?.key ?? 0) + 1,
            },
        }))
    }, [])

    const adjustRest = React.useCallback((deltaSec: number) => {
        setSession((s) => {
            if (!s.rest) return s
            const newEnds = s.rest.endsAt + deltaSec * 1000
            // Don't let adjustments push into the past or comically far future.
            if (newEnds <= Date.now()) {
                return { ...s, rest: undefined }
            }
            return {
                ...s,
                rest: {
                    ...s.rest,
                    endsAt: newEnds,
                    durationSec: Math.round((newEnds - s.rest.startedAt) / 1000),
                },
            }
        })
    }, [])

    const skipRest = React.useCallback(() => {
        setSession((s) => ({ ...s, rest: undefined }))
    }, [])

    const getLogged = React.useCallback(
        (exerciseId: string, setIndex: number): LoggedSet | undefined => {
            return session.logsByExerciseId[exerciseId]?.sets[setIndex]
        },
        [session.logsByExerciseId],
    )

    // Auto-clear expired rest state on mount and every ~30s — defense against
    // a stale rest persisting after a page reload past its endsAt.
    React.useEffect(() => {
        const checkExpiry = () => {
            setSession((s) => {
                if (!s.rest) return s
                // Keep the rest visible for 30s after it expires (so the user
                // sees "Rest done!" even if they were focused elsewhere), then
                // clear automatically.
                if (s.rest.endsAt < Date.now() - 30_000) {
                    return { ...s, rest: undefined }
                }
                return s
            })
        }
        checkExpiry()
        const id = window.setInterval(checkExpiry, 30_000)
        return () => window.clearInterval(id)
    }, [])

    // Defensive: workout reference is not used in callbacks above, but expose
    // for derived computations callers might want.
    void workout

    return {
        session,
        isActive,
        isFinished,
        start,
        finish,
        reset,
        logSet,
        undoSet,
        startSet,
        finishActiveSet,
        cancelActiveSet,
        setSkipped,
        addSet,
        startRest,
        adjustRest,
        skipRest,
        getLogged,
    }
}

// ---------------------------------------------------------------------------
// PR detection — compares a logged set to the artifact's personalBest and
// returns true if it's a new best (heavier weight × reps, longer hold, etc.)
// Used by the SetRow to trigger a brief celebration animation.
// ---------------------------------------------------------------------------

export function isNewPersonalBest(
    exercise: Exercise,
    logged: LoggedSet | undefined,
): boolean {
    if (!logged?.completed || logged.failed) return false
    const pb = exercise.personalBest
    if (!pb) return false

    switch (exercise.kind) {
        case 'weighted':
        case 'weighted_bw': {
            if (logged.actualWeightKg === undefined || logged.actualReps === undefined) return false
            // Beat the absolute weight × reps product, OR same weight with more reps.
            if (pb.weightKg !== undefined && pb.reps !== undefined) {
                if (logged.actualWeightKg > pb.weightKg) return true
                if (logged.actualWeightKg === pb.weightKg && logged.actualReps > pb.reps) return true
                // Estimated 1RM also counts — a higher single-set 1RM is a "rep PR".
                if (pb.estimated1RM !== undefined) {
                    const est = estimated1RM(logged.actualWeightKg, logged.actualReps)
                    if (est !== null && est > pb.estimated1RM) return true
                }
            }
            return false
        }
        case 'bodyweight': {
            if (logged.actualReps === undefined || pb.reps === undefined) return false
            return logged.actualReps > pb.reps
        }
        case 'hold': {
            if (logged.actualDurationSec === undefined || pb.durationSec === undefined) return false
            return logged.actualDurationSec > pb.durationSec
        }
        case 'cardio_dist': {
            if (logged.actualDistanceM === undefined || pb.distanceM === undefined) return false
            return logged.actualDistanceM > pb.distanceM
        }
        default:
            return false
    }
}
