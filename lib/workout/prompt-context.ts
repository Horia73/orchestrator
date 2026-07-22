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

function plannedSetLabel(
    set: PlannedSet,
    kind: Exercise['kind'],
    units: WorkoutUnits,
    loadUnit?: string,
): string {
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
        case 'resistance': {
            const load = typeof s.load === 'number' ? s.load : '?'
            core = `${load} ${loadUnit || 'level'}×${formatRepRange(s.reps as never)}`
            break
        }
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
        case 'resistance':
            if (set.actualLoad !== undefined && set.actualReps !== undefined) {
                core = `${set.actualLoad}×${set.actualReps}`
            } else if (set.actualReps !== undefined) core = `${set.actualReps} reps`
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
    const durationSec = loggedSetDurationSec(set)
    if (durationSec !== undefined && durationSec > 0) tags.push(`time ${formatDuration(durationSec)}`)
    if (set.actualRpe !== undefined) tags.push(`RPE${set.actualRpe}`)
    if (set.actualRir !== undefined) tags.push(`RIR${set.actualRir}`)
    if (set.notes) tags.push(`note: ${set.notes}`)
    return tags.length ? `${core} ${tags.join(' ')}` : core
}

function loggedSetDurationSec(set: LoggedSet): number | undefined {
    const startedAt = dateMs(set.startedAt)
    const completedAt = dateMs(set.completedAt)
    if (startedAt !== undefined && completedAt !== undefined && completedAt > startedAt) {
        return Math.round((completedAt - startedAt) / 1000)
    }
    return set.actualDurationSec
}

function dateMs(value: string | undefined): number | undefined {
    if (!value) return undefined
    const ms = new Date(value).getTime()
    return Number.isFinite(ms) ? ms : undefined
}

function collectLoggedSetDurations(session: WorkoutSessionState): number[] {
    return Object.values(session.logsByExerciseId)
        .flatMap((log) => log.sets)
        .filter((set) => (set.completed || set.failed) && !set.skipped)
        .map(loggedSetDurationSec)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function averageDuration(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

function exerciseLine(exercise: Exercise, session: WorkoutSessionState, units: WorkoutUnits): string[] {
    const equip = exercise.equipment?.length ? exercise.equipment.join('/') : '—'
    const muscles = exercise.muscleGroups.join(',')
    const rest = exercise.defaultRestSec !== undefined ? `; rest ${exercise.defaultRestSec}s` : ''
    const planned = exercise.planned.map((s) => {
        return plannedSetLabel(
            s,
            exercise.kind,
            units,
            exercise.kind === 'resistance' ? exercise.loadUnit : undefined,
        )
    }).join(', ')
    const header = `- ${exercise.name} (id: ${exercise.id}, ${exercise.kind}, ${equip}; ${muscles}): ${exercise.planned.length} sets — ${planned}${rest}`

    const log = session.logsByExerciseId[exercise.id]
    const lines = [header]
    if (log?.skipped) {
        lines.push(`  · exercise skipped by user`)
    } else if (log?.sets?.some((s) => s.completed || s.failed || s.skipped)) {
        const logged = exercise.planned
            .map((_, i) => {
                const label = loggedSetLabel(log.sets[i], exercise.kind, units)
                return exercise.kind === 'resistance' && label.includes('×')
                    ? label.replace('×', ` ${exercise.loadUnit}×`)
                    : label
            })
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
    meta: { identifier: string; title: string; artifactId: string },
): string {
    const units = workout.units
    const started = !!session.startedAt
    const finished = !!session.completedAt
    const status = finished ? 'finished' : started ? 'in progress' : 'not started'

    const lines: string[] = [
        'Surface: Workout session — the user is viewing this workout full-screen with an in-surface chat.',
        'Treat the workout doctrine and tools as active for this turn.',
        `To CHANGE this workout, PREFER the \`PatchWorkout\` tool with artifactId "${meta.artifactId}" and a list of ops (add_exercise / remove_exercise / replace_exercise / set_planned / edit_exercise / reorder) — it edits in place without you reproducing the whole JSON, and the surface updates live. Only re-emit the FULL artifact (same identifier "${meta.identifier}", same sessionId "${workout.sessionId}") for a big restructure or a brand-new workout. Either way the user's logged progress is preserved; keep stable exercise ids for exercises that stay, and do NOT remove an exercise that already has logged sets without confirming first.`,
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
        const setDurations = collectLoggedSetDurations(session)
        const avgSetSec = averageDuration(setDurations)
        if (avgSetSec !== undefined) {
            parts.push(`avg set time ${formatDuration(Math.round(avgSetSec))} over ${setDurations.length} timed set${setDurations.length === 1 ? '' : 's'}`)
        }
        if (started && !finished) {
            const elapsedMs = Date.now() - new Date(session.startedAt!).getTime()
            if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
                parts.push(`elapsed ${formatDuration(Math.round(elapsedMs / 1000))}`)
            }
        }
        lines.push(`Live totals: ${parts.join(', ')}.`)
    }

    if (session.activeSet) {
        const endMs = session.activeSet.finishedAt ?? Date.now()
        const elapsedSec = Math.max(0, Math.round((endMs - session.activeSet.startedAt) / 1000))
        lines.push(
            `Current set timer: ${session.activeSet.exerciseName} set ${session.activeSet.setIndex + 1} — ${session.activeSet.finishedAt ? 'finished, waiting for actuals/save' : 'running'} for ${formatDuration(elapsedSec)}.`,
        )
    }

    if (session.rest) {
        const remainingSec = Math.max(0, Math.round((session.rest.endsAt - Date.now()) / 1000))
        const elapsedSec = Math.max(0, Math.round((Date.now() - session.rest.startedAt) / 1000))
        lines.push(
            `Current rest timer: ${session.rest.exerciseName} after set ${session.rest.setIndex + 1} — elapsed ${formatDuration(elapsedSec)}, remaining ${formatDuration(remainingSec)} of planned ${formatDuration(session.rest.durationSec)}.`,
        )
    }

    return lines.join('\n')
}
