"use client"

import * as React from "react"
import { Timer } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Exercise, WorkoutUnits } from "@/lib/workout/schema"
import { formatDuration } from "@/lib/workout/format"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

import { AddSetButton } from "./add-set-button"
import { ExerciseHeader } from "./exercise-header"
import { SetRow } from "./set-row"

/**
 * One exercise inside a group card. Renders the header (name, muscles,
 * last session, PB) and the list of planned sets.
 *
 * Threads the session API down to each SetRow when interactive. When
 * `sessionApi` is omitted, the card stays read-only (used by the dev
 * preview and any standalone-render context).
 */
export function ExerciseCard({
    exercise,
    units,
    sessionApi,
    interactive = false,
    barKg,
    plates,
    className,
}: {
    exercise: Exercise
    units: WorkoutUnits
    sessionApi?: WorkoutSessionApi
    interactive?: boolean
    barKg?: number
    plates?: readonly number[]
    className?: string
}) {
    // Determine which set is "current" — the next pending one, so the user's
    // eye snaps to it after a set is logged.
    const currentIndex = React.useMemo(() => {
        if (!sessionApi) return -1
        for (let i = 0; i < exercise.planned.length; i++) {
            const logged = sessionApi.getLogged(exercise.id, i)
            if (!logged?.completed) return i
        }
        return -1
    }, [sessionApi, exercise.id, exercise.planned.length])

    // Surface any freestyle sets (logged beyond planned[]) so they render
    // after the planned rows. Phase 4 only — read directly from session state.
    const freestyleCount = React.useMemo(() => {
        if (!sessionApi) return 0
        const log = sessionApi.session.logsByExerciseId[exercise.id]
        if (!log) return 0
        return Math.max(0, log.sets.length - exercise.planned.length)
    }, [sessionApi, exercise.id, exercise.planned.length])

    return (
        <article
            className={cn(
                "flex flex-col gap-3 rounded-xl border border-border/55 bg-card px-4 py-3.5 shadow-sm",
                className,
            )}
            data-exercise-id={exercise.id}
        >
            <ExerciseHeader exercise={exercise} units={units} />
            <ul role="list" className="flex flex-col gap-1">
                {exercise.planned.map((plannedSet, i) => (
                    <SetRow
                        key={i}
                        index={i + 1}
                        plannedSet={plannedSet}
                        exercise={exercise}
                        units={units}
                        sessionApi={sessionApi}
                        interactive={interactive}
                        isCurrent={i === currentIndex}
                        barKg={barKg}
                        plates={plates}
                    />
                ))}
                {/* Freestyle sets (added mid-session) — render after planned.
                    The plannedSet here is reconstructed from the logged data
                    so set-row renders the same metric layout. */}
                {Array.from({ length: freestyleCount }).map((_, fi) => {
                    const idx = exercise.planned.length + fi
                    const logged = sessionApi?.getLogged(exercise.id, idx)
                    const reconstructed = reconstructPlannedFromLogged(exercise.kind, logged)
                    return (
                        <SetRow
                            key={`free-${idx}`}
                            index={idx + 1}
                            plannedSet={reconstructed}
                            exercise={exercise}
                            units={units}
                            sessionApi={sessionApi}
                            interactive={interactive}
                            barKg={barKg}
                            plates={plates}
                        />
                    )
                })}
            </ul>
            {interactive && sessionApi ? (
                <AddSetButton
                    exercise={exercise}
                    units={units}
                    sessionApi={sessionApi}
                    barKg={barKg}
                    plates={plates}
                />
            ) : null}
            {exercise.defaultRestSec ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Timer className="size-3" strokeWidth={1.75} aria-hidden />
                    Rest <span className="tabular-nums text-foreground/65">{formatDuration(exercise.defaultRestSec)}</span> între seturi
                </div>
            ) : null}
        </article>
    )
}

/** Build a planned-shaped object from a logged set so the set-row knows
 *  which fields to show. Freestyle sets aren't backed by an artifact
 *  planned entry, so we synthesise one. */
function reconstructPlannedFromLogged(
    kind: Exercise['kind'],
    logged: import("@/lib/workout/schema").LoggedSet | undefined,
): import("@/lib/workout/schema").PlannedSet {
    const base = { kind: 'working' as const }
    if (!logged) {
        switch (kind) {
            case 'weighted':
            case 'weighted_bw':
                return { ...base, weightKg: 0, reps: 0 }
            case 'bodyweight':
                return { ...base, reps: 0 }
            case 'hold':
                return { ...base, durationSec: 0 }
            case 'cardio_dur':
                return { ...base, durationSec: 0 }
            case 'cardio_dist':
                return { ...base, distanceM: 0 }
            case 'interval':
                return { ...base, rounds: 1, workSec: 30, intraRestSec: 0 }
        }
    }
    switch (kind) {
        case 'weighted':
        case 'weighted_bw':
            return { ...base, weightKg: logged.actualWeightKg ?? 0, reps: logged.actualReps ?? 0 }
        case 'bodyweight':
            return { ...base, reps: logged.actualReps ?? 0 }
        case 'hold':
            return { ...base, durationSec: logged.actualDurationSec ?? 0 }
        case 'cardio_dur':
            return { ...base, durationSec: logged.actualDurationSec ?? 0 }
        case 'cardio_dist':
            return { ...base, distanceM: logged.actualDistanceM ?? 0 }
        case 'interval':
            return { ...base, rounds: 1, workSec: 30, intraRestSec: 0 }
    }
}
