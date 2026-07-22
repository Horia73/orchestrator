"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { Exercise, ExerciseGroup, WorkoutArtifact } from "@/lib/workout/schema"
import { parseWorkoutArtifact } from "@/lib/workout/parser"
import { workoutImageRequestPath } from "@/lib/workout/exercise-image-request"
import { useWorkoutSession, type WorkoutSessionApi } from "@/lib/workout/use-workout-session"

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
 * Warm every exercise's demo image into the browser cache on idle, using the
 * exact same lookup URL the (i) panel will request — so opening the panel is
 * instant instead of waiting on a CDN download. The route only resolves a
 * verified saved image for that stable id; it performs no search or fuzzy
 * fallback. Runs once per workout when `enabled` (the full-screen surface
 * passes true).
 */
function useExerciseImagePrefetch(workout: WorkoutArtifact, enabled: boolean) {
    React.useEffect(() => {
        if (!enabled) return
        if (typeof window === "undefined") return
        const exercises = workout.groups.flatMap((group) => group.exercises)
        if (exercises.length === 0) return

        let cancelled = false
        const warmed = new Set<string>()
        const warm = (url: string) => {
            if (warmed.has(url)) return
            warmed.add(url)
            const img = new Image()
            img.decoding = "async"
            img.referrerPolicy = "no-referrer"
            img.src = url
        }
        const run = () => {
            for (const ex of exercises) {
                if (cancelled) return
                if (ex.imageUrl) {
                    warm(ex.imageUrl)
                    continue
                }
                void fetch(workoutImageRequestPath(ex))
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data: { images?: Array<{ url?: string }> } | null) => {
                        if (cancelled) return
                        const url = data?.images?.[0]?.url
                        if (url) warm(url)
                    })
                    .catch(() => undefined)
            }
        }

        const ric = window.requestIdleCallback
        const handle = typeof ric === "function"
            ? ric(run, { timeout: 2000 })
            : window.setTimeout(run, 400)
        return () => {
            cancelled = true
            const cancelRic = window.cancelIdleCallback
            if (typeof ric === "function" && typeof cancelRic === "function") {
                cancelRic(handle as number)
            } else {
                window.clearTimeout(handle as number)
            }
        }
    }, [workout, enabled])
}

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
    const sessionApi = useWorkoutSession(workout.sessionId, workout, { artifactId })
    return (
        <WorkoutCanvas
            sessionApi={sessionApi}
            title={title}
            artifactId={artifactId}
            className={className}
        />
    )
}

/**
 * Presentational workout canvas. Takes an already-created session API instead
 * of creating its own, so the in-surface chat (the `/artifact/[id]` workout
 * surface) can lift `useWorkoutSession` to the surface level and share the live
 * session state with the chat's prompt context. In the inline chat path,
 * `WorkoutView` creates the session and passes it straight through.
 */
export function WorkoutCanvas({
    sessionApi,
    title,
    artifactId,
    className,
    prefetchImages = false,
}: {
    sessionApi: WorkoutSessionApi
    title: string
    artifactId?: string
    className?: string
    /** Warm every exercise's demo image into the browser cache on idle so the
     *  (i) panel opens instantly. Enabled on the full-screen surface; off for
     *  inline chat cards (avoids fetching images the user just scrolls past). */
    prefetchImages?: boolean
}) {
    const renderedWorkout = sessionApi.workout
    useExerciseImagePrefetch(renderedWorkout, prefetchImages)
    const interactive = sessionApi.isActive || sessionApi.isFinished
    const hasFloatingTimer = !!sessionApi.session.activeSet || !!sessionApi.session.rest
    const addedExerciseCount = React.useMemo(
        () => (sessionApi.session.addedGroups ?? []).reduce((sum, group) => sum + group.exercises.length, 0),
        [sessionApi.session.addedGroups],
    )
    const previousAddedExerciseCount = React.useRef<number | null>(null)
    const [recentlyAddedExerciseId, setRecentlyAddedExerciseId] = React.useState<string | null>(null)
    const continuationSet = React.useMemo(() => {
        const restExerciseId = sessionApi.session.rest?.exerciseId
        if (restExerciseId) {
            const nextForRestExercise = sessionApi.remainingSets.find((set) => set.exerciseId === restExerciseId)
            if (nextForRestExercise) return nextForRestExercise
        }
        return sessionApi.nextSet
    }, [sessionApi.nextSet, sessionApi.remainingSets, sessionApi.session.rest?.exerciseId])
    const continuationExercise = React.useMemo(
        () => continuationSet ? findExercise(renderedWorkout, continuationSet.exerciseId) : null,
        [renderedWorkout, continuationSet],
    )
    const startNextSet = React.useCallback(() => {
        if (!continuationSet || !continuationExercise || sessionApi.session.activeSet) return
        sessionApi.startSet(continuationExercise, continuationSet.setIndex)
    }, [sessionApi, continuationExercise, continuationSet])
    const nextSetLabel = continuationSet
        ? `${continuationSet.exerciseName} · set ${continuationSet.setIndex + 1}`
        : undefined

    React.useEffect(() => {
        if (!sessionApi.isRestored) return
        if (previousAddedExerciseCount.current === null) {
            previousAddedExerciseCount.current = addedExerciseCount
            return
        }
        const previousCount = previousAddedExerciseCount.current
        previousAddedExerciseCount.current = addedExerciseCount
        if (addedExerciseCount <= previousCount) return

        const addedId = lastAddedExerciseId(sessionApi.session.addedGroups)
        if (!addedId) return

        setRecentlyAddedExerciseId(addedId)
        const frame = window.requestAnimationFrame(() => {
            const element = document.querySelector<HTMLElement>(`[data-exercise-id="${addedId}"]`)
            element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        const timeout = window.setTimeout(() => setRecentlyAddedExerciseId(null), 2600)
        return () => {
            window.cancelAnimationFrame(frame)
            window.clearTimeout(timeout)
        }
    }, [addedExerciseCount, sessionApi.isRestored, sessionApi.session.addedGroups])

    return (
        <>
            <article
                data-workout
                data-session-id={renderedWorkout.sessionId}
                className={cn(
                    "flex w-full min-w-0 max-w-full flex-col gap-4 overflow-x-hidden text-foreground",
                    hasFloatingTimer ? "pb-28" : "pb-6",
                    className,
                )}
                aria-label={title || renderedWorkout.title}
            >
                <WorkoutHeader workout={renderedWorkout} />
                <WorkoutActionBar sessionApi={sessionApi} placement="top" />
                <WorkoutProgressStats workout={renderedWorkout} sessionApi={sessionApi} />

                {renderedWorkout.warmup ? (
                    <WorkoutChecklist
                        title="Warm-up"
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
                            highlightExerciseId={recentlyAddedExerciseId}
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

                {sessionApi.isFinished ? (
                    <SessionSummary
                        workout={renderedWorkout}
                        sessionApi={sessionApi}
                        artifactId={artifactId}
                    />
                ) : null}

                {renderedWorkout.attribution ? (
                    <footer className="text-xs text-muted-foreground">
                        Source: {renderedWorkout.attribution}
                    </footer>
                ) : null}

                <WorkoutActionBar sessionApi={sessionApi} placement="bottom" />
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
                    onStartNext={continuationExercise && continuationSet && !sessionApi.session.activeSet ? startNextSet : undefined}
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

function lastAddedExerciseId(groups: readonly ExerciseGroup[] | undefined): string | null {
    if (!groups?.length) return null
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
        const exercises = groups[groupIndex].exercises
        const exercise = exercises[exercises.length - 1]
        if (exercise?.id) return exercise.id
    }
    return null
}
