"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { Exercise, WorkoutArtifact } from "@/lib/workout/schema"
import { parseWorkoutArtifact } from "@/lib/workout/parser"
import { useWorkoutSession } from "@/lib/workout/use-workout-session"

import { WorkoutErrorCard } from "./workout/workout-error-card"
import { WorkoutHeader } from "./workout/workout-header"
import { WorkoutProgressStats } from "./workout/workout-progress-stats"
import { WorkoutChecklist } from "./workout/workout-checklist"
import { WorkoutActionBar } from "./workout/workout-action-bar"
import { GroupCard } from "./workout/group-card"
import { RestTimerBar } from "./workout/rest-timer-bar"
import { SetTimerBar } from "./workout/set-timer-bar"
import { SessionSummary } from "./workout/session-summary"
import { AddExerciseButton } from "./workout/add-exercise-button"

/**
 * Top-level renderer for `application/vnd.ant.workout` artifacts.
 *
 * Phase 2 brings full interactivity:
 *   - Session state hook owns logged sets, start/finish, rest timer.
 *   - Set checkboxes mutate state and auto-fire rest timer.
 *   - Weight / reps pickers open inline popovers, re-log on Apply.
 *   - Floating bottom rest-timer bar reads state, fires chimes.
 *   - Live progress stats tick once per second.
 *   - localStorage autosave per sessionId — survives reloads.
 */
export function WorkoutRenderer({
    source,
    title,
    mode = "inline",
    className,
    artifactId,
}: {
    source: string
    title: string
    mode?: "inline" | "panel"
    className?: string
    artifactId?: string
}) {
    void mode

    const parsed = React.useMemo(() => parseWorkoutArtifact(source), [source])

    if (!parsed.ok) {
        return <WorkoutErrorCard message={parsed.error} className={className} />
    }

    return <WorkoutView workout={parsed.value} title={title} artifactId={artifactId} className={className} />
}

/**
 * Inner view. Owns the session hook so its state is per-artifact. The
 * `key` on this component (set by the parent based on `sessionId`) ensures
 * a fresh session when a new workout artifact replaces an old one.
 */
function WorkoutView({
    workout,
    title,
    artifactId,
    className,
}: {
    workout: WorkoutArtifact
    title: string
    artifactId?: string
    className?: string
}) {
    const sessionApi = useWorkoutSession(workout.sessionId, workout)
    const renderedWorkout = sessionApi.workout
    const interactive = sessionApi.isActive || sessionApi.isFinished
    const nextExercise = React.useMemo(
        () => sessionApi.nextSet ? findExercise(renderedWorkout, sessionApi.nextSet.exerciseId) : null,
        [renderedWorkout, sessionApi.nextSet],
    )
    const startNextSet = React.useCallback(() => {
        if (!sessionApi.nextSet || !nextExercise || sessionApi.session.activeSet) return
        sessionApi.startSet(nextExercise, sessionApi.nextSet.setIndex)
    }, [sessionApi, nextExercise])
    const nextSetLabel = sessionApi.nextSet
        ? `${sessionApi.nextSet.exerciseName} · set ${sessionApi.nextSet.setIndex + 1}`
        : undefined

    return (
        <>
            <article
                data-workout
                data-session-id={workout.sessionId}
                className={cn(
                    "flex w-full min-w-0 max-w-full flex-col gap-4 overflow-hidden text-foreground",
                    className,
                )}
                aria-label={title || workout.title}
            >
                <WorkoutHeader workout={renderedWorkout} />
                <WorkoutProgressStats workout={renderedWorkout} sessionApi={sessionApi} />

                <WorkoutActionBar sessionApi={sessionApi} placement="top" />

                {renderedWorkout.warmup ? (
                    <WorkoutChecklist
                        title="Încălzire"
                        checklist={renderedWorkout.warmup}
                        variant="warmup"
                    />
                ) : null}

                <div className="flex flex-col gap-3">
                    {renderedWorkout.groups.map((group, i) => (
                        <GroupCard
                            key={i}
                            group={group}
                            index={i + 1}
                            units={renderedWorkout.units}
                            sessionApi={sessionApi}
                            interactive={interactive}
                            barKg={renderedWorkout.barWeightKg}
                            plates={renderedWorkout.plateIncrements}
                        />
                    ))}
                    {sessionApi.isActive ? (
                        <AddExerciseButton
                            units={renderedWorkout.units}
                            sessionApi={sessionApi}
                        />
                    ) : null}
                </div>

                {renderedWorkout.cooldown ? (
                    <WorkoutChecklist
                        title="Cooldown"
                        checklist={renderedWorkout.cooldown}
                        variant="cooldown"
                    />
                ) : null}

                {renderedWorkout.notes ? (
                    <div className="rounded-lg border border-border/45 bg-muted/25 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                        {renderedWorkout.notes}
                    </div>
                ) : null}

                <WorkoutActionBar sessionApi={sessionApi} placement="bottom" />

                {sessionApi.isFinished ? (
                    <SessionSummary
                        workout={renderedWorkout}
                        sessionApi={sessionApi}
                        artifactId={artifactId}
                    />
                ) : null}

                {renderedWorkout.attribution ? (
                    <footer className="text-xs text-muted-foreground">
                        Sursă: {renderedWorkout.attribution}
                    </footer>
                ) : null}
            </article>

            {sessionApi.session.activeSet ? (
                <SetTimerBar
                    activeSet={sessionApi.session.activeSet}
                    onFinish={sessionApi.finishActiveSet}
                    onCancel={sessionApi.cancelActiveSet}
                />
            ) : sessionApi.session.rest ? (
                <RestTimerBar
                    rest={sessionApi.session.rest}
                    onAdjust={sessionApi.adjustRest}
                    onSkip={sessionApi.skipRest}
                    onStartNext={nextExercise && sessionApi.nextSet && !sessionApi.session.activeSet ? startNextSet : undefined}
                    nextLabel={nextSetLabel}
                    alertBeforeSec={renderedWorkout.restAlertSec ?? 5}
                />
            ) : null}
        </>
    )
}

function findExercise(workout: WorkoutArtifact, exerciseId: string): Exercise | null {
    for (const group of workout.groups) {
        const exercise = group.exercises.find((candidate) => candidate.id === exerciseId)
        if (exercise) return exercise
    }
    return null
}
