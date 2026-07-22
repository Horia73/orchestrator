"use client"

import * as React from "react"

import type {
    Exercise,
    ExerciseGroup,
    LoggedSet,
    PlannedSet,
    WorkoutArtifact,
} from "./schema"
import { clearActiveWorkoutSummary, writeActiveWorkoutSummary } from "./active-workout"
import { estimated1RM } from "./one-rep-max"
import { buildEffectiveWorkout, normalizeAddedGroups } from "./session-plan"

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
const MAX_REST_SPAN_MS = 12 * 60 * 60 * 1000
const STALE_COMPLETED_REST_MS = 12 * 60 * 60 * 1000

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

/**
 * Validate and repair a persisted rest timer. `startedAt`/`endsAt` are the
 * source of truth, so an old payload with `durationSec: 0` can be recovered
 * when its timestamps still describe a real pause.
 */
export function normalizePersistedRestState(value: unknown): RestState | undefined {
    if (!value || typeof value !== 'object') return undefined
    const candidate = value as Partial<RestState>
    if (
        typeof candidate.startedAt !== 'number'
        || !Number.isFinite(candidate.startedAt)
        || typeof candidate.endsAt !== 'number'
        || !Number.isFinite(candidate.endsAt)
        || candidate.endsAt <= candidate.startedAt
        || candidate.endsAt - candidate.startedAt > MAX_REST_SPAN_MS
        || typeof candidate.exerciseId !== 'string'
        || !candidate.exerciseId.trim()
        || typeof candidate.exerciseName !== 'string'
        || !candidate.exerciseName.trim()
        || typeof candidate.setIndex !== 'number'
        || !Number.isFinite(candidate.setIndex)
    ) {
        return undefined
    }

    return {
        durationSec: Math.max(1, Math.round((candidate.endsAt - candidate.startedAt) / 1000)),
        startedAt: candidate.startedAt,
        endsAt: candidate.endsAt,
        exerciseId: candidate.exerciseId,
        exerciseName: candidate.exerciseName,
        setIndex: Math.max(0, Math.floor(candidate.setIndex)),
        key: typeof candidate.key === 'number' && Number.isFinite(candidate.key)
            ? Math.max(1, Math.floor(candidate.key))
            : 1,
    }
}

export interface RestEvent {
    exerciseId: string
    exerciseName: string
    setIndex: number
    plannedSec: number
    startedAt: string
    endedAt: string
    elapsedSec: number
    status: 'completed' | 'skipped' | 'replaced' | 'stopped'
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

export interface WorkoutSessionFeedback {
    rating?: number
    notes?: string
}

export interface WorkoutSetRef {
    exerciseId: string
    exerciseName: string
    setIndex: number
}

export interface WorkoutSessionState {
    sessionId: string
    /** ISO timestamp; unset until user hits Start. */
    startedAt?: string
    /** ISO timestamp; unset until user hits Finish. */
    completedAt?: string
    /** Per-exercise logs, keyed by exercise.id. */
    logsByExerciseId: Record<string, ExerciseSessionLog>
    /** Exercise groups the user added during this session. */
    addedGroups?: ExerciseGroup[]
    /** Completed/cleared rest periods, used by history and coaching tools. */
    restEvents?: RestEvent[]
    /** Optional current rest timer state. */
    rest?: RestState
    /** Optional current working-set timer. A set is logged only after
     *  Finish -> edit actuals -> Save. */
    activeSet?: ActiveSetState
    /** Optional user feedback captured when finishing the session. */
    feedback?: WorkoutSessionFeedback
    /** ISO timestamp of the last persist. Used to reconcile localStorage vs
     *  the server copy on hydration (newer wins). Stamped at write time. */
    updatedAt?: string
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
 * Coerce an arbitrary persisted payload (from localStorage OR the server) into
 * a clean session state. Returns empty state if missing, malformed, the wrong
 * session, or from an incompatible storage version. Never throws.
 */
function coercePersistedSession(raw: unknown, sessionId: string): WorkoutSessionState {
    const parsed = raw as (Partial<WorkoutSessionState> & { updatedAt?: string }) | null
    if (!parsed || typeof parsed !== 'object' || parsed.sessionId !== sessionId || parsed._v !== STORAGE_VERSION) {
        return EMPTY_STATE(sessionId)
    }
    const restEvents = normalizeRestEvents((parsed as { restEvents?: unknown }).restEvents)
    let rest = normalizePersistedRestState(parsed.rest)
    let activeSet = parsed.activeSet
    // Keep an expired pause visible as "Rest done" through ordinary app
    // backgrounding/reloads. Only discard it when it is clearly from an
    // abandoned session many hours later.
    if (rest && rest.endsAt < Date.now() - STALE_COMPLETED_REST_MS) {
        restEvents.push(restToEvent(rest, 'completed', rest.endsAt))
        rest = undefined
    }
    if (activeSet?.startedAt && activeSet.startedAt < Date.now() - 12 * 60 * 60 * 1000) {
        activeSet = undefined
    }
    return {
        sessionId,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
        logsByExerciseId: parsed.logsByExerciseId ?? {},
        addedGroups: normalizeAddedGroups((parsed as { addedGroups?: unknown }).addedGroups),
        restEvents,
        rest,
        activeSet,
        feedback: normalizeSessionFeedback((parsed as { feedback?: unknown }).feedback),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        _v: STORAGE_VERSION,
    }
}

/**
 * Read persisted state from localStorage. Returns empty state if missing,
 * malformed, or from an incompatible storage version. Never throws.
 */
function readPersistedState(sessionId: string): WorkoutSessionState {
    if (typeof window === 'undefined') return EMPTY_STATE(sessionId)
    try {
        const raw = window.localStorage.getItem(storageKey(sessionId))
        if (!raw) return EMPTY_STATE(sessionId)
        return coercePersistedSession(JSON.parse(raw), sessionId)
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
        case 'resistance':
            if (typeof set.load === 'number') base.actualLoad = set.load
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
 * Choose the duration shown in the post-set editor. A running timer is an
 * observation, so it must win over the programmed target; an already saved
 * duration remains authoritative when reopening the editor.
 */
export function resolveTimedSetDraftDuration(
    plannedDurationSec: number | undefined,
    loggedDurationSec: number | undefined,
    measuredDurationSec: number | undefined,
    hasActiveTimer: boolean,
): number | undefined {
    if (loggedDurationSec !== undefined) return loggedDurationSec
    if (hasActiveTimer) return measuredDurationSec
    return plannedDurationSec ?? measuredDurationSec
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

/** Build a timestamp-backed rest timer. Zero means an intentional no-rest set
 * (for example a drop set), so no empty 0:00 bar is created. */
export function createRestState(
    durationSec: number,
    label: { exerciseId: string; exerciseName: string; setIndex: number },
    key: number,
    startedAt = Date.now(),
): RestState | undefined {
    if (!Number.isFinite(durationSec)) return undefined
    const cleanDurationSec = Math.max(0, Math.round(durationSec))
    if (cleanDurationSec === 0) return undefined
    return {
        durationSec: cleanDurationSec,
        startedAt,
        endsAt: startedAt + cleanDurationSec * 1000,
        exerciseId: label.exerciseId,
        exerciseName: label.exerciseName,
        setIndex: Math.max(0, Math.floor(label.setIndex)),
        key: Math.max(1, Math.floor(key)),
    }
}

function normalizeRestEvents(value: unknown): RestEvent[] {
    if (!Array.isArray(value)) return []
    return value.slice(0, 500).flatMap((event): RestEvent[] => {
        if (!event || typeof event !== 'object') return []
        const candidate = event as Partial<RestEvent>
        const status = candidate.status
        if (
            typeof candidate.exerciseId !== 'string'
            || typeof candidate.exerciseName !== 'string'
            || typeof candidate.setIndex !== 'number'
            || typeof candidate.plannedSec !== 'number'
            || typeof candidate.startedAt !== 'string'
            || typeof candidate.endedAt !== 'string'
            || typeof candidate.elapsedSec !== 'number'
            || !['completed', 'skipped', 'replaced', 'stopped'].includes(String(status))
        ) {
            return []
        }
        return [{
            exerciseId: candidate.exerciseId,
            exerciseName: candidate.exerciseName,
            setIndex: Math.max(0, Math.floor(candidate.setIndex)),
            plannedSec: Math.max(0, Math.round(candidate.plannedSec)),
            startedAt: candidate.startedAt,
            endedAt: candidate.endedAt,
            elapsedSec: Math.max(0, Math.round(candidate.elapsedSec)),
            status: status as RestEvent['status'],
        }]
    })
}

function restToEvent(rest: RestState, status: RestEvent['status'], endedAtMs = Date.now()): RestEvent {
    const plannedSec = Math.max(0, Math.round((rest.endsAt - rest.startedAt) / 1000))
    const elapsedSec = Math.max(0, Math.round((endedAtMs - rest.startedAt) / 1000))
    return {
        exerciseId: rest.exerciseId,
        exerciseName: rest.exerciseName,
        setIndex: rest.setIndex,
        plannedSec,
        startedAt: new Date(rest.startedAt).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        elapsedSec,
        status,
    }
}

function normalizeSessionFeedback(value: unknown): WorkoutSessionFeedback | undefined {
    if (!value || typeof value !== 'object') return undefined
    const candidate = value as Partial<WorkoutSessionFeedback>
    const rating = typeof candidate.rating === 'number' && Number.isFinite(candidate.rating)
        ? Math.min(5, Math.max(1, Math.round(candidate.rating)))
        : undefined
    const notes = typeof candidate.notes === 'string'
        ? candidate.notes.trim().slice(0, 1200)
        : ''
    if (rating === undefined && !notes) return undefined
    return {
        ...(rating !== undefined ? { rating } : {}),
        ...(notes ? { notes } : {}),
    }
}

function finishRest(
    state: WorkoutSessionState,
    status: RestEvent['status'],
    endedAtMs = Date.now(),
): WorkoutSessionState {
    if (!state.rest) return state
    return {
        ...state,
        rest: undefined,
        restEvents: [
            ...(state.restEvents ?? []),
            restToEvent(state.rest, status, endedAtMs),
        ],
    }
}

export interface WorkoutSessionApi {
    /** Current snapshot of the session. Re-renders on every change. */
    session: WorkoutSessionState
    /** True after browser storage has been checked for this session. */
    isRestored: boolean
    /** Original artifact plan plus session-local exercise additions. */
    workout: WorkoutArtifact
    /** Whether the user has tapped Start. */
    isActive: boolean
    /** True after Finish; renderer should show the summary. */
    isFinished: boolean
    /** Tap Start — sets startedAt and unlocks set check-ins. */
    start: () => void
    /** Tap Finish — sets completedAt and optional session feedback. */
    finish: (feedback?: WorkoutSessionFeedback) => void
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
    /** First not-done/not-skipped planned set in workout order. */
    nextSet?: WorkoutSetRef
    /** All not-done/not-skipped planned sets in workout order. */
    remainingSets: WorkoutSetRef[]
    /** True when the given set is the next set in the workout order. */
    isNextSet: (exerciseId: string, setIndex: number) => boolean
    /** Mark one or more sets skipped, with an optional shared reason. */
    skipSet: (exerciseId: string, setIndex: number, reason?: string) => void
    skipSets: (sets: readonly WorkoutSetRef[], reason?: string) => void
    /** Mark an exercise skipped (or unskip). */
    setSkipped: (exerciseId: string, skipped: boolean) => void
    /** Add/update a note without changing set completion state. */
    setNote: (exerciseId: string, setIndex: number, note?: string) => void
    /** Append a freestyle set after the planned ones. */
    addSet: (exercise: Exercise, plannedSet: PlannedSet) => void
    /** Append a session-local straight exercise after the planned workout. */
    addExercise: (exercise: Exercise) => void
    /** Rest timer controls. */
    startRest: (durationSec: number, label: { exerciseId: string; exerciseName: string; setIndex: number }) => void
    adjustRest: (deltaSec: number) => void
    skipRest: () => void
    /** Get the logged set for an exercise+index, or undefined. */
    getLogged: (exerciseId: string, setIndex: number) => LoggedSet | undefined
}

function buildSetOrder(workout: WorkoutArtifact): WorkoutSetRef[] {
    const order: WorkoutSetRef[] = []
    for (const group of workout.groups) {
        for (const exercise of group.exercises) {
            for (let setIndex = 0; setIndex < exercise.planned.length; setIndex++) {
                order.push({ exerciseId: exercise.id, exerciseName: exercise.name, setIndex })
            }
        }
    }
    return order
}

function isSetAdvanced(logged: LoggedSet | undefined): boolean {
    return !!logged && (logged.completed || !!logged.skipped)
}

function findNextSet(order: readonly WorkoutSetRef[], state: WorkoutSessionState): WorkoutSetRef | undefined {
    return order.find((set) => !isSetAdvanced(state.logsByExerciseId[set.exerciseId]?.sets[set.setIndex]))
}

function findRemainingSets(order: readonly WorkoutSetRef[], state: WorkoutSessionState): WorkoutSetRef[] {
    return order.filter((set) => !isSetAdvanced(state.logsByExerciseId[set.exerciseId]?.sets[set.setIndex]))
}

/** Stamp the current time so localStorage and the server copy can be compared
 *  on hydration (newer wins). */
function stampSession(session: WorkoutSessionState): WorkoutSessionState & { updatedAt: string } {
    return { ...session, updatedAt: new Date().toISOString() }
}

function persistSessionState(sessionId: string, session: WorkoutSessionState): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(storageKey(sessionId), JSON.stringify(stampSession(session)))
    } catch {
        /* quota / privacy mode — fail silently */
    }
}

/** Signature of all durable session content. Rest/set timers change only on
 * user actions (not on display ticks), so including them keeps resume state
 * synchronized without producing timer-churn requests. */
export function sessionContentSignature(session: WorkoutSessionState): string {
    return JSON.stringify({
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        logsByExerciseId: session.logsByExerciseId,
        addedGroups: session.addedGroups,
        restEvents: session.restEvents,
        rest: session.rest,
        activeSet: session.activeSet,
        feedback: session.feedback,
    })
}

function collectExerciseIds(workout: WorkoutArtifact, addedGroups: readonly ExerciseGroup[] | undefined): Set<string> {
    const ids = new Set<string>()
    for (const group of workout.groups) {
        for (const exercise of group.exercises) ids.add(exercise.id)
    }
    for (const group of addedGroups ?? []) {
        for (const exercise of group.exercises) ids.add(exercise.id)
    }
    return ids
}

function uniqueExerciseId(id: string, used: Set<string>): string {
    const base = id.slice(0, 72) || 'custom-exercise'
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
        const suffix = `-${i}`
        const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`
        if (!used.has(candidate)) return candidate
    }
    return `${base.slice(0, 62)}-${Date.now().toString(36)}`
}

export function useWorkoutSession(
    sessionId: string,
    workout: WorkoutArtifact,
    opts?: { artifactId?: string },
): WorkoutSessionApi {
    const artifactId = opts?.artifactId
    const [session, setSessionState] = React.useState<WorkoutSessionState>(() => EMPTY_STATE(sessionId))
    const [restoredSessionId, setRestoredSessionId] = React.useState<string | null>(null)
    const isRestored = restoredSessionId === sessionId
    const latestSessionRef = React.useRef(session)
    // Mirror state into the persistence ref inside the same update. This closes
    // the small mobile race where pagehide can fire before a normal effect has
    // copied a just-started rest timer into the ref used by the unload flush.
    const setSession = React.useCallback<React.Dispatch<React.SetStateAction<WorkoutSessionState>>>((next) => {
        setSessionState((current) => {
            const resolved = typeof next === 'function'
                ? (next as (value: WorkoutSessionState) => WorkoutSessionState)(current)
                : next
            latestSessionRef.current = resolved
            return resolved
        })
    }, [])
    // Signature of the last content we pushed to the server, for autosave dedup.
    const lastServerSaveRef = React.useRef<string | null>(null)
    // Gate server writes until we've reconciled with the server copy on mount,
    // so a stale local state can't clobber a newer server state in the window
    // before hydration resolves. `false` until the GET settles (or there's no
    // artifactId to reconcile against).
    const [serverChecked, setServerChecked] = React.useState(false)
    const serverCheckedRef = React.useRef(false)
    React.useEffect(() => {
        serverCheckedRef.current = serverChecked
    }, [serverChecked])
    const effectiveWorkout = React.useMemo(
        () => buildEffectiveWorkout(workout, { addedGroups: session.addedGroups }),
        [workout, session.addedGroups],
    )
    const setOrder = React.useMemo(() => buildSetOrder(effectiveWorkout), [effectiveWorkout])

    React.useEffect(() => {
        lastServerSaveRef.current = null
        setServerChecked(!artifactId)
    }, [artifactId])

    React.useEffect(() => {
        setRestoredSessionId(null)
        setServerChecked(false)
        const restored = readPersistedState(sessionId)
        latestSessionRef.current = restored
        setSession(restored)
        setRestoredSessionId(sessionId)
    }, [sessionId, setSession])

    // Persist on change with debouncing. We coalesce rapid mutations so a
    // burst of "check, check, check" only writes once.
    const saveTimer = React.useRef<number | null>(null)
    React.useEffect(() => {
        if (typeof window === 'undefined') return
        if (!isRestored) return
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
            persistSessionState(sessionId, latestSessionRef.current)
        }, 250)
        return () => {
            if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        }
    }, [session, sessionId, isRestored])

    React.useEffect(() => {
        if (typeof window === 'undefined') return
        if (!isRestored) return
        const flush = () => {
            const current = latestSessionRef.current
            persistSessionState(sessionId, current)
            // Best-effort server flush on unload so a half-done session isn't
            // lost to the 1.5s autosave debounce. keepalive lets it outlive the
            // page; failures are silently ignored (localStorage already has it).
            // Gated on serverChecked so we never clobber a newer server copy
            // before hydration has reconciled.
            if (artifactId && serverCheckedRef.current && current.startedAt) {
                const sig = sessionContentSignature(current)
                if (sig !== lastServerSaveRef.current) {
                    lastServerSaveRef.current = sig
                    try {
                        void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/workout-session`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ session: stampSession(current) }),
                            keepalive: true,
                        }).catch(() => undefined)
                    } catch { /* ignore */ }
                }
            }
        }
        window.addEventListener('pagehide', flush)
        window.addEventListener('beforeunload', flush)
        return () => {
            if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
            flush()
            window.removeEventListener('pagehide', flush)
            window.removeEventListener('beforeunload', flush)
        }
    }, [sessionId, isRestored, artifactId])

    // Hydrate from the server copy (keyed by artifactId) once the local restore
    // is done. The server copy survives reloads, inbox re-opens, and lets a
    // session resume on another device. Newer-wins: adopt the server state only
    // when there is no local progress or the server stamp is more recent.
    React.useEffect(() => {
        if (!artifactId) return
        if (!isRestored) return
        let cancelled = false
        const local = latestSessionRef.current
        void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/workout-session`, {
            headers: { Accept: 'application/json' },
        })
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { session?: unknown } | null) => {
                if (cancelled || !data?.session) return
                const server = coercePersistedSession(data.session, sessionId)
                if (!server.startedAt && !server.completedAt) return
                const localHasProgress = !!local.startedAt || !!local.completedAt
                const serverIsNewer = !!server.updatedAt
                    && (!local.updatedAt || server.updatedAt > local.updatedAt)
                if (localHasProgress && !serverIsNewer) return
                latestSessionRef.current = server
                setSession(server)
                lastServerSaveRef.current = sessionContentSignature(server)
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setServerChecked(true)
            })
        return () => {
            cancelled = true
        }
    }, [artifactId, isRestored, sessionId, setSession])

    // Autosave the in-progress session to the server, debounced. Only meaningful
    // (started) sessions are pushed, and the content signature dedups so rest-
    // timer churn / remounts don't spam the endpoint.
    React.useEffect(() => {
        if (typeof window === 'undefined') return
        if (!artifactId) return
        if (!isRestored) return
        if (!serverChecked) return
        if (!session.startedAt) return
        const sig = sessionContentSignature(session)
        if (sig === lastServerSaveRef.current) return
        const timer = window.setTimeout(() => {
            lastServerSaveRef.current = sig
            void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/workout-session`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: stampSession(latestSessionRef.current) }),
                keepalive: true,
            }).catch(() => {
                // Allow a retry on the next change.
                lastServerSaveRef.current = null
            })
        }, 1500)
        return () => window.clearTimeout(timer)
    }, [session, artifactId, isRestored, serverChecked])

    const isActive = !!session.startedAt && !session.completedAt
    const isFinished = !!session.completedAt
    const remainingSets = React.useMemo(() => findRemainingSets(setOrder, session), [setOrder, session])
    const nextSet = React.useMemo(() => remainingSets[0] ?? findNextSet(setOrder, session), [remainingSets, setOrder, session])

    React.useEffect(() => {
        if (!artifactId || !isRestored) return
        if (session.startedAt && !session.completedAt) {
            writeActiveWorkoutSummary({
                artifactId,
                sessionId,
                title: workout.title,
                startedAt: session.startedAt,
                rest: session.rest
                    ? {
                        endsAt: session.rest.endsAt,
                        exerciseName: session.rest.exerciseName,
                        setIndex: session.rest.setIndex,
                    }
                    : undefined,
                activeSet: session.activeSet
                    ? {
                        startedAt: session.activeSet.startedAt,
                        finishedAt: session.activeSet.finishedAt,
                        exerciseName: session.activeSet.exerciseName,
                        setIndex: session.activeSet.setIndex,
                    }
                    : undefined,
            })
            return
        }
        clearActiveWorkoutSummary({ artifactId, sessionId })
    }, [
        artifactId,
        isRestored,
        session.activeSet,
        session.completedAt,
        session.rest,
        session.startedAt,
        sessionId,
        workout.title,
    ])

    const start = React.useCallback(() => {
        setSession((s) => (s.startedAt ? s : { ...s, startedAt: new Date().toISOString() }))
    }, [setSession])

    const finish = React.useCallback((feedback?: WorkoutSessionFeedback) => {
        const nowMs = Date.now()
        const cleanFeedback = normalizeSessionFeedback(feedback)
        setSession((s) => {
            const status = s.rest && nowMs >= s.rest.endsAt ? 'completed' : 'stopped'
            const withRestClosed = finishRest(s, status, nowMs)
            return {
                ...withRestClosed,
                completedAt: new Date(nowMs).toISOString(),
                activeSet: undefined,
                feedback: cleanFeedback,
            }
        })
    }, [setSession])

    const reset = React.useCallback(() => {
        setSession(EMPTY_STATE(sessionId))
        lastServerSaveRef.current = null
        if (artifactId) {
            void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/workout-session`, {
                method: 'DELETE',
                keepalive: true,
            }).catch(() => undefined)
        }
    }, [sessionId, artifactId, setSession])

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
                const nowMs = Date.now()
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
                    skipped: undefined,
                    skipReason: undefined,
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

                const rest = wantsRest
                    ? createRestState(
                        restSec,
                        {
                            exerciseId: exercise.id,
                            exerciseName: exercise.name,
                            setIndex,
                        },
                        (s.rest?.key ?? 0) + 1,
                        nowMs,
                    )
                    : s.rest
                const restEvents = wantsRest && s.rest
                    ? [...(s.restEvents ?? []), restToEvent(s.rest, nowMs >= s.rest.endsAt ? 'completed' : 'replaced', nowMs)]
                    : s.restEvents

                const activeSet = s.activeSet?.exerciseId === exercise.id && s.activeSet.setIndex === setIndex
                    ? undefined
                    : s.activeSet

                return { ...s, startedAt, logsByExerciseId, rest, restEvents, activeSet }
            })
        },
        [setSession],
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
    }, [setSession])

    const startSet = React.useCallback<WorkoutSessionApi['startSet']>((exercise, setIndex) => {
        const nowMs = Date.now()
        const nowIso = new Date(nowMs).toISOString()
        setSession((s) => {
            const withRestClosed = s.rest
                ? finishRest(s, nowMs >= s.rest.endsAt ? 'completed' : 'replaced', nowMs)
                : s
            return {
                ...withRestClosed,
                startedAt: s.startedAt ?? nowIso,
                completedAt: undefined,
                activeSet: {
                    startedAt: nowMs,
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    setIndex,
                    key: (s.activeSet?.key ?? 0) + 1,
                },
            }
        })
    }, [setSession])

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
    }, [setSession])

    const cancelActiveSet = React.useCallback(() => {
        setSession((s) => ({ ...s, activeSet: undefined }))
    }, [setSession])

    const isNextSet = React.useCallback<WorkoutSessionApi['isNextSet']>(
        (exerciseId, setIndex) => nextSet?.exerciseId === exerciseId && nextSet.setIndex === setIndex,
        [nextSet],
    )

    const skipSets = React.useCallback<WorkoutSessionApi['skipSets']>((setsToSkip, reason) => {
        if (setsToSkip.length === 0) return
        const now = new Date().toISOString()
        const cleanReason = reason?.trim() || undefined
        setSession((s) => {
            const logsByExerciseId = { ...s.logsByExerciseId }
            for (const setRef of setsToSkip) {
                const prevLog = logsByExerciseId[setRef.exerciseId] ?? { sets: [] }
                const previous = prevLog.sets[setRef.setIndex]
                const sets = prevLog.sets.slice()
                sets[setRef.setIndex] = {
                    completed: false,
                    skipped: true,
                    skipReason: cleanReason,
                    notes: previous?.notes,
                    startedAt: previous?.startedAt,
                    completedAt: now,
                }
                logsByExerciseId[setRef.exerciseId] = { ...prevLog, sets }
            }
            return {
                ...s,
                startedAt: s.startedAt ?? now,
                logsByExerciseId,
            }
        })
    }, [setSession])

    const skipSet = React.useCallback<WorkoutSessionApi['skipSet']>(
        (exerciseId, setIndex, reason) => {
            const setRef = setOrder.find((set) => set.exerciseId === exerciseId && set.setIndex === setIndex)
            if (!setRef) return
            skipSets([setRef], reason)
        },
        [setOrder, skipSets],
    )

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
    }, [setSession])

    const setNote = React.useCallback<WorkoutSessionApi['setNote']>((exerciseId, setIndex, note) => {
        const cleanNote = note?.trim() || undefined
        setSession((s) => {
            const prevLog = ensureLog(s, exerciseId)
            const sets = prevLog.sets.slice()
            const existing = sets[setIndex]
            sets[setIndex] = {
                ...(existing ?? { completed: false }),
                notes: cleanNote,
            }
            return {
                ...s,
                logsByExerciseId: {
                    ...s.logsByExerciseId,
                    [exerciseId]: { ...prevLog, sets },
                },
            }
        })
    }, [setSession])

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
        [setSession],
    )

    const addExercise = React.useCallback<WorkoutSessionApi['addExercise']>(
        (exercise) => {
            const now = new Date().toISOString()
            setSession((s) => {
                const used = collectExerciseIds(workout, s.addedGroups)
                const nextExercise: Exercise = {
                    ...exercise,
                    id: uniqueExerciseId(exercise.id, used),
                }
                return {
                    ...s,
                    startedAt: s.startedAt ?? now,
                    addedGroups: [
                        ...(s.addedGroups ?? []),
                        { kind: 'straight' as const, exercises: [nextExercise] },
                    ],
                }
            })
        },
        [workout, setSession],
    )

    const startRest = React.useCallback<WorkoutSessionApi['startRest']>((durationSec, label) => {
        const nowMs = Date.now()
        setSession((s) => {
            const withRestClosed = s.rest
                ? finishRest(s, nowMs >= s.rest.endsAt ? 'completed' : 'replaced', nowMs)
                : s
            return {
                ...withRestClosed,
                rest: createRestState(durationSec, label, (s.rest?.key ?? 0) + 1, nowMs),
            }
        })
    }, [setSession])

    const adjustRest = React.useCallback((deltaSec: number) => {
        setSession((s) => {
            if (!s.rest) return s
            const newEnds = s.rest.endsAt + deltaSec * 1000
            // Don't let adjustments push into the past or comically far future.
            if (newEnds <= Date.now()) {
                return finishRest(s, 'skipped')
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
    }, [setSession])

    const skipRest = React.useCallback(() => {
        const nowMs = Date.now()
        setSession((s) => {
            if (!s.rest) return s
            return finishRest(s, nowMs >= s.rest.endsAt ? 'completed' : 'skipped', nowMs)
        })
    }, [setSession])

    const getLogged = React.useCallback(
        (exerciseId: string, setIndex: number): LoggedSet | undefined => {
            return session.logsByExerciseId[exerciseId]?.sets[setIndex]
        },
        [session.logsByExerciseId],
    )

    return {
        session,
        isRestored,
        workout: effectiveWorkout,
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
        nextSet,
        remainingSets,
        isNextSet,
        skipSet,
        skipSets,
        setSkipped,
        setNote,
        addSet,
        addExercise,
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
        case 'resistance': {
            if (logged.actualLoad === undefined || logged.actualReps === undefined) return false
            if (pb.load === undefined || pb.reps === undefined) return false
            return logged.actualLoad > pb.load
                || (logged.actualLoad === pb.load && logged.actualReps > pb.reps)
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
