import type { ActiveSetState, RestState } from "./use-workout-session"

const STORAGE_VERSION = 1
const ACTIVE_WORKOUT_STORAGE_KEY = "workout:active:v1"

export const ACTIVE_WORKOUT_EVENT = "orch:active-workout"

export interface ActiveWorkoutSummary {
    _v: typeof STORAGE_VERSION
    artifactId: string
    sessionId: string
    title: string
    startedAt: string
    updatedAt: string
    rest?: Pick<RestState, "endsAt" | "exerciseName" | "setIndex">
    activeSet?: Pick<ActiveSetState, "startedAt" | "finishedAt" | "exerciseName" | "setIndex">
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

function cleanString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}

function coerceActiveWorkoutSummary(value: unknown): ActiveWorkoutSummary | null {
    if (!value || typeof value !== "object") return null
    const candidate = value as Partial<ActiveWorkoutSummary>
    const artifactId = cleanString(candidate.artifactId)
    const sessionId = cleanString(candidate.sessionId)
    const startedAt = cleanString(candidate.startedAt)
    const updatedAt = cleanString(candidate.updatedAt)
    if (candidate._v !== STORAGE_VERSION || !artifactId || !sessionId || !startedAt || !updatedAt) {
        return null
    }

    const title = cleanString(candidate.title) ?? "Workout"
    const summary: ActiveWorkoutSummary = {
        _v: STORAGE_VERSION,
        artifactId,
        sessionId,
        title,
        startedAt,
        updatedAt,
    }

    const rest = candidate.rest
    if (
        rest
        && isFiniteNumber(rest.endsAt)
        && typeof rest.exerciseName === "string"
        && isFiniteNumber(rest.setIndex)
    ) {
        summary.rest = {
            endsAt: rest.endsAt,
            exerciseName: rest.exerciseName,
            setIndex: rest.setIndex,
        }
    }

    const activeSet = candidate.activeSet
    if (
        activeSet
        && isFiniteNumber(activeSet.startedAt)
        && typeof activeSet.exerciseName === "string"
        && isFiniteNumber(activeSet.setIndex)
    ) {
        summary.activeSet = {
            startedAt: activeSet.startedAt,
            finishedAt: isFiniteNumber(activeSet.finishedAt) ? activeSet.finishedAt : undefined,
            exerciseName: activeSet.exerciseName,
            setIndex: activeSet.setIndex,
        }
    }

    return summary
}

function emitActiveWorkoutChange(summary: ActiveWorkoutSummary | null) {
    if (typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent(ACTIVE_WORKOUT_EVENT, { detail: summary }))
}

export function readActiveWorkoutSummary(): ActiveWorkoutSummary | null {
    if (typeof window === "undefined") return null
    try {
        const raw = window.localStorage.getItem(ACTIVE_WORKOUT_STORAGE_KEY)
        if (!raw) return null
        const summary = coerceActiveWorkoutSummary(JSON.parse(raw))
        if (!summary) window.localStorage.removeItem(ACTIVE_WORKOUT_STORAGE_KEY)
        return summary
    } catch {
        return null
    }
}

export function writeActiveWorkoutSummary(input: Omit<ActiveWorkoutSummary, "_v" | "updatedAt">) {
    if (typeof window === "undefined") return
    const summary: ActiveWorkoutSummary = {
        ...input,
        _v: STORAGE_VERSION,
        updatedAt: new Date().toISOString(),
    }
    try {
        window.localStorage.setItem(ACTIVE_WORKOUT_STORAGE_KEY, JSON.stringify(summary))
    } catch {
        // Storage can be blocked in private mode; the mounted workout still works.
    }
    emitActiveWorkoutChange(summary)
}

export function clearActiveWorkoutSummary(match?: { artifactId?: string; sessionId?: string }) {
    if (typeof window === "undefined") return
    const current = readActiveWorkoutSummary()
    if (match?.artifactId && current?.artifactId && current.artifactId !== match.artifactId) return
    if (match?.sessionId && current?.sessionId && current.sessionId !== match.sessionId) return
    try {
        window.localStorage.removeItem(ACTIVE_WORKOUT_STORAGE_KEY)
    } catch {
        // Ignore storage failures; listeners still learn that this tab cleared it.
    }
    emitActiveWorkoutChange(null)
}
