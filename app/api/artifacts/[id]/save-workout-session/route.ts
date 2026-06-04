import { NextResponse } from 'next/server'

import { getArtifactById } from '@/lib/artifacts/store'
import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { buildEffectiveWorkout } from '@/lib/workout/session-plan'
import type { WorkoutSessionState } from '@/lib/workout/use-workout-session'
import {
    buildSessionLog,
    buildSessionSlug,
    formatHistoryEntryLine,
    formatSessionMarkdown,
    mergeExerciseHistory,
} from '@/lib/workout/save-session'
import {
    appendHistoryEntry,
    readExerciseHistory,
    writeExerciseHistory,
    writeSessionLog,
} from '@/lib/workout/storage'

/**
 * POST /api/artifacts/:id/save-workout-session
 *
 * Persists a completed workout session to the workspace files:
 *   - workouts/sessions/<slug>.json  (full session payload)
 *   - workouts/sessions/<slug>.md    (human-readable summary)
 *   - workouts/exercises/<id>.json   (per-exercise rollup, one per exercise)
 *   - workouts/HISTORY.md            (append-only one-liner index)
 *
 * Body shape (JSON):
 *   { session: WorkoutSessionState }
 *
 * Returns:
 *   { ok: true, slug, sessionPath, prs }
 *
 * The client calls this once on Finish; the SessionSummary card shows the
 * detected PRs even before the save round-trips, but uses the response to
 * confirm "Saved ✓".
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params

    const existing = getArtifactById(id)
    if (!existing) {
        return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }
    if (existing.type !== 'application/vnd.ant.workout') {
        return NextResponse.json(
            { error: `Save only supported for workout artifacts (got "${existing.type}")` },
            { status: 400 },
        )
    }

    const parsed = parseWorkoutArtifact(existing.content)
    if (!parsed.ok) {
        return NextResponse.json(
            { error: `Stored artifact body did not parse: ${parsed.error}` },
            { status: 500 },
        )
    }
    const storedWorkout = parsed.value

    let body: { session?: unknown }
    try {
        body = (await request.json()) as { session?: unknown }
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const state = body?.session as WorkoutSessionState | undefined
    if (!state || typeof state !== 'object' || state.sessionId !== storedWorkout.sessionId) {
        return NextResponse.json(
            { error: 'POST body must include session matching the artifact sessionId' },
            { status: 400 },
        )
    }
    if (!state.startedAt) {
        return NextResponse.json(
            { error: 'session.startedAt is required (session never started)' },
            { status: 400 },
        )
    }
    if (!state.completedAt) {
        return NextResponse.json(
            { error: 'session.completedAt is required (session not finished)' },
            { status: 400 },
        )
    }

    const workout = buildEffectiveWorkout(storedWorkout, state)
    const sessionLog = buildSessionLog(workout, state)
    const slug = buildSessionSlug(workout, state)
    const markdown = formatSessionMarkdown(sessionLog)

    const { jsonPath, mdPath } = writeSessionLog(slug, sessionLog, markdown)

    // Per-exercise history merge: read existing, merge, write back. Each
    // exercise rollup file is independent so concurrent saves of different
    // workouts don't conflict.
    const writtenExercises: string[] = []
    for (let i = 0; i < workout.groups.length; i++) {
        const group = workout.groups[i]
        for (let j = 0; j < group.exercises.length; j++) {
            const exercise = group.exercises[j]
            const exerciseLog = sessionLog.exercises.find((e) => e.id === exercise.id)
            if (!exerciseLog) continue
            // Skip exercises with zero completed sets — nothing to roll up.
            const anyCompleted = exerciseLog.loggedSets.some((s) => s.completed && !s.failed)
            if (!anyCompleted) continue

            const existingHistory = readExerciseHistory(exercise.id)
            const merged = mergeExerciseHistory(existingHistory, workout, sessionLog, exerciseLog)
            writeExerciseHistory(merged)
            writtenExercises.push(exercise.id)
        }
    }

    appendHistoryEntry(formatHistoryEntryLine(sessionLog), workout.sessionId)

    return NextResponse.json({
        ok: true,
        slug,
        sessionPath: jsonPath,
        markdownPath: mdPath,
        exercisesUpdated: writtenExercises,
        prs: sessionLog.prs,
        totals: {
            durationSec: sessionLog.totalDurationSec,
            setsCompleted: sessionLog.totalSetsCompleted,
            setsPlanned: sessionLog.totalSetsPlanned,
            volumeKg: sessionLog.totalVolumeKg,
        },
    })
}
