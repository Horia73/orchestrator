import type { Exercise, LoggedSet, PlannedSet, WorkoutArtifact, WorkoutUnits } from './schema'
import type { WorkoutSessionState } from './use-workout-session'
import { formatDuration, formatRepRange, formatWeight } from './format'

// ---------------------------------------------------------------------------
// Workout chat prompt-context builder.
//
// The in-surface workout chat (the `/artifact/[id]` workout surface) sends this
// summary to the agent on every turn so it can coach and edit FROM THE LIVE
// STATE — not just the static plan. Mirrors `summarizeMapForPrompt` for maps,
// but richer: a map only has its artifact, while a workout also has live
// session progress (logged sets, RPE, failures, what's next) that the agent
// needs in order to give useful answers ("you failed the last set, drop the
// weight") and safe edits ("keep the sessionId so progress survives").
//
// Pure / string-only — no React, no I/O. Safe to unit-test.
// ---------------------------------------------------------------------------

function plannedSetLabel(set: PlannedSet, kind: Exercise['kind'], units: WorkoutUnits): string {
    const s = set as unknown as Record<string, unknown>
    const tag = typeof s.kind === 'string' && s.kind !== 'working' ? ` (${s.kind})` : ''
    let core: string
    switch (kind) {
        case 'weighted':
        case 'weighted_bw': {
            const reps = formatRepRange(s.reps as never)
            const weight = typeof s.weightKg === 'number'
                ? formatWeight(s.weightKg, units)
                : typeof s.weightPct === 'number'
                    ? `${s.weightPct}%`
                    : 'BW'
            core = `${weight}×${reps}`
            break
        }
        case 'bodyweight':
            core = `${formatRepRange(s.reps as never)} reps`
            break
        case 'hold':
            core = formatDuration(s.durationSec as number)
            break
        case 'cardio_dur':
            core = formatDuration(s.durationSec as number)
            break
        case 'cardio_dist':
            core = `${s.distanceM as number} m`
            break
        case 'interval':
            core = `${s.rounds as number}×${s.workSec as number}s`
            break
        default:
            core = '?'
    }
    const rpe = typeof s.rpe === 'number' ? ` @RPE${s.rpe}` : typeof s.rir === 'number' ? ` @RIR${s.rir}` : ''
    return `${core}${rpe}${tag}`
}

function loggedSetLabel(set: LoggedSet | undefined, kind: Exercise['kind'], units: WorkoutUnits): string {
    if (!set) return '—'
    if (set.skipped) return `skip${set.skipReason ? ` (${set.skipReason})` : ''}`
    if (!set.completed && !set.failed) return '—'
    let core = '—'
    switch (kind) {
        case 'weighted':
        case 'weighted_bw':
            if (set.actualWeightKg !== undefined && set.actualReps !== undefined) {
                core = `${formatWeight(set.actualWeightKg, units)}×${set.actualReps}`
            } else if (set.actualReps !== undefined) core = `${set.actualReps} reps`
            break
        case 'bodyweight':
            if (set.actualReps !== undefined) core = `${set.actualReps} reps`
            break
        case 'hold':
        case 'cardio_dur':
        case 'interval':
            if (set.actualDurationSec !== undefined) core = formatDuration(set.actualDurationSec)
            break
        case 'cardio_dist':
            if (set.actualDistanceM !== undefined) core = `${set.actualDistanceM} m`
            break
    }
    const tags: string[] = []
    if (set.failed) tags.push(set.partialReps !== undefined ? `failed@${set.partialReps}` : 'failed')
    if (set.actualRpe !== undefined) tags.push(`RPE${set.actualRpe}`)
    if (set.actualRir !== undefined) tags.push(`RIR${set.actualRir}`)
    if (set.notes) tags.push(`note: ${set.notes}`)
    return tags.length ? `${core} ${tags.join(' ')}` : core
}

function exerciseLine(exercise: Exercise, session: WorkoutSessionState, units: WorkoutUnits): string[] {
    const equip = exercise.equipment?.length ? exercise.equipment.join('/') : '—'
    const muscles = exercise.muscleGroups.join(',')
    const rest = exercise.defaultRestSec !== undefined ? `; rest ${exercise.defaultRestSec}s` : ''
    const planned = exercise.planned.map((s) => plannedSetLabel(s, exercise.kind, units)).join(', ')
    const header = `- ${exercise.name} (id: ${exercise.id}, ${exercise.kind}, ${equip}; ${muscles}): ${exercise.planned.length} sets — ${planned}${rest}`

    const log = session.logsByExerciseId[exercise.id]
    const lines = [header]
    if (log?.skipped) {
        lines.push(`  · exercise skipped by user`)
    } else if (log?.sets?.some((s) => s.completed || s.failed || s.skipped)) {
        const logged = exercise.planned
            .map((_, i) => loggedSetLabel(log.sets[i], exercise.kind, units))
            .join(' | ')
        lines.push(`  · logged: ${logged}`)
    }
    return lines
}

/**
 * Build the chat prompt context for a workout surface. `workout` should be the
 * EFFECTIVE workout (artifact plan + any session-added exercises), `session` is
 * the live session state, and `meta` carries the identifier/sessionId the agent
 * must reuse to edit in place.
 */
export function summarizeWorkoutForPrompt(
    workout: WorkoutArtifact,
    session: WorkoutSessionState,
    meta: { identifier: string; title: string },
): string {
    const units = workout.units
    const started = !!session.startedAt
    const finished = !!session.completedAt
    const status = finished ? 'finished' : started ? 'in progress' : 'not started'

    const lines: string[] = [
        'Surface: Workout session — the user is viewing this workout full-screen with an in-surface chat.',
        'Treat the workout doctrine and tools as active for this turn.',
        `To CHANGE this workout (add / remove / replace / re-weight exercises or sets), re-emit the FULL workout artifact with the SAME identifier "${meta.identifier}" and the SAME sessionId "${workout.sessionId}". This preserves the user's logged progress. Keep stable exercise ids for exercises that stay. Do NOT remove an exercise that already has logged sets without confirming first.`,
        `Workout: "${meta.title}"${workout.difficulty ? ` · ${workout.difficulty}` : ''}${workout.estimatedDurationMin ? ` · ~${workout.estimatedDurationMin} min` : ''}. Units: ${units}. Session status: ${status}.`,
        'Plan and live progress (planned sets, then what the user actually logged per set):',
    ]

    for (let gi = 0; gi < workout.groups.length; gi++) {
        const group = workout.groups[gi]
        const groupTag = group.kind !== 'straight'
            ? ` [${group.label ?? group.kind}${group.rounds ? ` ×${group.rounds}` : ''}]`
            : ''
        if (group.kind !== 'straight' || group.exercises.length > 1) {
            lines.push(`Group ${gi + 1}${groupTag}:`)
        }
        for (const exercise of group.exercises) {
            lines.push(...exerciseLine(exercise, session, units))
        }
    }

    // Live totals + what's next.
    if (started) {
        let planned = 0
        let done = 0
        let failed = 0
        let skipped = 0
        for (const group of workout.groups) {
            for (const ex of group.exercises) {
                planned += ex.planned.length
                const sets = session.logsByExerciseId[ex.id]?.sets ?? []
                for (const s of sets) {
                    if (s.completed && !s.failed) done++
                    if (s.failed) failed++
                    if (s.skipped) skipped++
                }
            }
        }
        const parts = [`${done}/${planned} sets done`]
        if (failed) parts.push(`${failed} failed`)
        if (skipped) parts.push(`${skipped} skipped`)
        if (started && !finished) {
            const elapsedMs = Date.now() - new Date(session.startedAt!).getTime()
            if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
                parts.push(`elapsed ${formatDuration(Math.round(elapsedMs / 1000))}`)
            }
        }
        lines.push(`Live totals: ${parts.join(', ')}.`)
    }

    return lines.join('\n')
}
