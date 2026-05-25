"use client"

import * as React from "react"
import { Timer } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Exercise, WorkoutUnits } from "@/lib/workout/schema"
import { formatDuration } from "@/lib/workout/format"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

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
            </ul>
            {exercise.defaultRestSec ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Timer className="size-3" strokeWidth={1.75} aria-hidden />
                    Rest <span className="tabular-nums text-foreground/65">{formatDuration(exercise.defaultRestSec)}</span> între seturi
                </div>
            ) : null}
        </article>
    )
}
