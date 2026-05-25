/**
 * Dev-only seed script — writes 3 fake historical sessions to the workout
 * storage so the /workouts page has data to display during local
 * development. Safe to re-run (dedupes via sessionId).
 *
 * Run: npx tsx scripts/seed-workouts-dev.ts
 * Delete: rm -rf .orchestrator/workspace/workouts
 */
import { parseWorkoutArtifact } from '@/lib/workout/parser'
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

const workoutJson = JSON.stringify({
    sessionId: 'seed-template',
    title: 'Push Day',
    subtitle: 'Bench focus + accesorii',
    program: { name: 'PPL', week: 3, day: 1 },
    units: 'kg',
    groups: [{
        kind: 'straight',
        exercises: [
            { id: 'bench-press', name: 'Bench Press', kind: 'weighted', muscleGroups: ['chest', 'triceps'], planned: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }] },
            { id: 'ohp', name: 'Overhead Press', kind: 'weighted', muscleGroups: ['front_delt'], planned: [{ weightKg: 40, reps: 5 }, { weightKg: 40, reps: 5 }, { weightKg: 40, reps: 5 }] },
            { id: 'dips', name: 'Dips', kind: 'bodyweight', muscleGroups: ['chest', 'triceps'], planned: [{ reps: 10 }, { reps: 10 }, { reps: 8 }] },
        ],
    }],
})

async function seed(daysAgo: number, sessionId: string, benchWeight: number, benchReps: number) {
    const r = parseWorkoutArtifact(workoutJson)
    if (!r.ok) throw new Error(r.error)
    const w = { ...r.value, sessionId }
    const start = new Date(Date.now() - daysAgo * 86400_000).toISOString()
    const end = new Date(Date.now() - daysAgo * 86400_000 + 2700_000).toISOString()
    const state = {
        sessionId,
        startedAt: start,
        completedAt: end,
        logsByExerciseId: {
            'bench-press': {
                sets: [
                    { completed: true, actualWeightKg: benchWeight, actualReps: benchReps, actualRpe: 7.5 },
                    { completed: true, actualWeightKg: benchWeight, actualReps: benchReps, actualRpe: 8 },
                    { completed: true, actualWeightKg: benchWeight, actualReps: Math.max(1, benchReps - 1), actualRpe: 9 },
                ],
            },
            'ohp': {
                sets: [
                    { completed: true, actualWeightKg: 40, actualReps: 5, actualRpe: 7 },
                    { completed: true, actualWeightKg: 40, actualReps: 5, actualRpe: 8 },
                    { completed: true, actualWeightKg: 40, actualReps: 5, actualRpe: 8.5 },
                ],
            },
            'dips': {
                sets: [
                    { completed: true, actualReps: 10 },
                    { completed: true, actualReps: 10 },
                    { completed: true, actualReps: 9 },
                ],
            },
        },
        _v: 1 as const,
    }
    const log = buildSessionLog(w, state)
    const slug = buildSessionSlug(w, state)
    writeSessionLog(slug, log, formatSessionMarkdown(log))
    for (const ex of log.exercises) {
        const existing = readExerciseHistory(ex.id)
        const merged = mergeExerciseHistory(existing, w, log, ex)
        writeExerciseHistory(merged)
    }
    appendHistoryEntry(formatHistoryEntryLine(log), sessionId)
    console.log(`Seeded ${slug}`)
}

async function main() {
    await seed(7, 'seed-2026-05-18-push', 60, 8)
    await seed(4, 'seed-2026-05-21-push', 60, 8)
    await seed(1, 'seed-2026-05-24-push', 62.5, 8)
    console.log('done')
}

void main()
