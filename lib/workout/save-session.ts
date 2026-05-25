import type { Exercise, WorkoutArtifact, PersonalBest, PreviousSessionSnapshot, LoggedSet } from './schema'
import type { WorkoutSessionState } from './use-workout-session'
import { estimated1RM } from './one-rep-max'
import { formatDuration, formatSetSequence } from './format'

// ---------------------------------------------------------------------------
// Save-session helpers.
//
// Pure functions only — no I/O. The API route (server) calls these to build
// the JSON / markdown payloads, then writes them to workspace files. Keeping
// the logic pure means we can unit-test the merge / PR-detection / formatting
// without spinning up a filesystem.
//
// File layout (under WORKSPACE_DIR/workouts/):
//
//   workouts/
//   ├── HISTORY.md                       — append-only human log
//   ├── sessions/
//   │   ├── 2026-05-25-push-day.json     — full session payload
//   │   └── 2026-05-25-push-day.md       — markdown summary
//   └── exercises/
//       ├── bench-press.json             — per-exercise rollup (PB, sessions)
//       └── ...
//
// Per-exercise files are denormalised to make the AI tool query fast: each
// exercise lookup reads ONE small JSON instead of scanning the whole session
// log.
// ---------------------------------------------------------------------------

// === session log payload ===================================================

/**
 * Full session log written to `workouts/sessions/<slug>.json`. Self-describing:
 * future tools can read this file alone and reconstruct everything the user
 * actually did.
 */
export interface SessionLog {
    /** Schema version for forward compatibility. */
    v: 1
    /** Unique sessionId from the workout artifact. */
    sessionId: string
    /** Pretty title carried through for display. */
    title: string
    /** Subtitle (e.g. "Top set la bench, accesorii"). */
    subtitle?: string
    /** Optional program info. */
    program?: WorkoutArtifact['program']
    /** Difficulty from the artifact. */
    difficulty?: WorkoutArtifact['difficulty']
    /** Units used throughout the artifact. */
    units: WorkoutArtifact['units']
    /** ISO start/end timestamps. */
    startedAt: string
    completedAt: string
    /** Total elapsed seconds. Convenience — derived from start/end. */
    totalDurationSec: number
    /** Per-exercise logs in the order they appear in the workout. */
    exercises: Array<{
        id: string
        name: string
        kind: Exercise['kind']
        muscleGroups: string[]
        plannedSetCount: number
        loggedSets: LoggedSet[]
        bestSet: LoggedSet | null
        totalVolumeKg: number
        skipped: boolean
    }>
    /** Aggregate stats. */
    totalSetsPlanned: number
    totalSetsCompleted: number
    totalSetsFailed: number
    totalVolumeKg: number
    /** PRs detected during this session. */
    prs: PrEvent[]
}

export interface PrEvent {
    exerciseId: string
    exerciseName: string
    kind: 'weight' | 'reps' | 'estimated_1rm' | 'duration' | 'distance'
    /** Human-readable "60 kg × 8" or "1:23" etc. */
    label: string
    /** Optional prior best for diff display. */
    previousLabel?: string
}

// === per-exercise history rollup ===========================================

/**
 * What we keep per exercise across all time. The AI tool reads this directly
 * to populate `previous` and `personalBest` on the next workout.
 *
 * `sessions` is capped at 12 entries to keep the file small; the
 * sessions/<slug>.json files are the long-term archive.
 */
export interface ExerciseHistory {
    v: 1
    id: string
    name: string
    kind: Exercise['kind']
    muscleGroups: string[]
    personalBest: PersonalBest | null
    /** Newest first. */
    sessions: Array<{
        date: string                       // YYYY-MM-DD
        sessionId: string                  // for cross-reference
        title: string
        bestSet: LoggedSet
        allSets: LoggedSet[]
        totalVolumeKg: number
        rpeAvg?: number
    }>
    /** ISO timestamp this file was last touched. */
    updatedAt: string
}

// === slug helpers ==========================================================

/** Kebab-case slug for the session file name. Uses startedAt date. */
export function buildSessionSlug(workout: WorkoutArtifact, state: WorkoutSessionState): string {
    const date = (state.startedAt ?? new Date().toISOString()).slice(0, 10) // YYYY-MM-DD
    const titleSlug = workout.title
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
    return `${date}-${titleSlug || 'workout'}`
}

// === session log build =====================================================

/**
 * Walk the artifact + session state and build the canonical session log.
 *
 * Side-effect-free; deterministic. Used both by the save API and by the
 * SessionSummary component to render the post-finish stats.
 */
export function buildSessionLog(
    workout: WorkoutArtifact,
    state: WorkoutSessionState,
): SessionLog {
    const startedAt = state.startedAt ?? new Date().toISOString()
    const completedAt = state.completedAt ?? new Date().toISOString()
    const totalDurationSec = Math.max(
        0,
        Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000),
    )

    const exercises: SessionLog['exercises'] = []
    let totalSetsPlanned = 0
    let totalSetsCompleted = 0
    let totalSetsFailed = 0
    let totalVolumeKg = 0
    const prs: PrEvent[] = []

    for (const group of workout.groups) {
        for (const ex of group.exercises) {
            const log = state.logsByExerciseId[ex.id]
            const loggedSets = log?.sets ?? []
            const skipped = !!log?.skipped

            const exerciseVolume = loggedSets.reduce((sum, s) => {
                if (s.completed && !s.failed && s.actualWeightKg !== undefined && s.actualReps !== undefined) {
                    return sum + s.actualWeightKg * s.actualReps
                }
                return sum
            }, 0)

            const bestSet = pickBestSet(loggedSets, ex.kind)
            totalSetsPlanned += ex.planned.length
            totalSetsCompleted += loggedSets.filter((s) => s.completed && !s.failed).length
            totalSetsFailed += loggedSets.filter((s) => s.failed).length
            totalVolumeKg += exerciseVolume

            // PR detection vs the workout's `personalBest` snapshot (which the
            // generator populated from previous history).
            const exercisePrs = detectExercisePrs(ex, loggedSets)
            prs.push(...exercisePrs)

            exercises.push({
                id: ex.id,
                name: ex.name,
                kind: ex.kind,
                muscleGroups: ex.muscleGroups as unknown as string[],
                plannedSetCount: ex.planned.length,
                loggedSets,
                bestSet,
                totalVolumeKg: Math.round(exerciseVolume * 100) / 100,
                skipped,
            })
        }
    }

    return {
        v: 1,
        sessionId: workout.sessionId,
        title: workout.title,
        subtitle: workout.subtitle,
        program: workout.program,
        difficulty: workout.difficulty,
        units: workout.units,
        startedAt,
        completedAt,
        totalDurationSec,
        exercises,
        totalSetsPlanned,
        totalSetsCompleted,
        totalSetsFailed,
        totalVolumeKg: Math.round(totalVolumeKg * 100) / 100,
        prs,
    }
}

/**
 * Pick the "best" set for an exercise.
 *   - weighted / weighted_bw: highest weight × reps product
 *   - bodyweight: most reps
 *   - hold: longest duration
 *   - cardio_dist: longest distance
 *   - cardio_dur / interval: longest duration (fallback)
 *
 * Returns null if no logged set qualifies.
 */
function pickBestSet(sets: LoggedSet[], kind: Exercise['kind']): LoggedSet | null {
    const completed = sets.filter((s) => s.completed && !s.failed)
    if (completed.length === 0) return null

    switch (kind) {
        case 'weighted':
        case 'weighted_bw': {
            return completed.reduce((best, s) => {
                const score = (s.actualWeightKg ?? 0) * (s.actualReps ?? 0)
                const bestScore = (best.actualWeightKg ?? 0) * (best.actualReps ?? 0)
                return score > bestScore ? s : best
            })
        }
        case 'bodyweight':
            return completed.reduce((best, s) => ((s.actualReps ?? 0) > (best.actualReps ?? 0) ? s : best))
        case 'hold':
        case 'cardio_dur':
        case 'interval':
            return completed.reduce((best, s) => ((s.actualDurationSec ?? 0) > (best.actualDurationSec ?? 0) ? s : best))
        case 'cardio_dist':
            return completed.reduce((best, s) => ((s.actualDistanceM ?? 0) > (best.actualDistanceM ?? 0) ? s : best))
    }
}

// === PR detection ==========================================================

/**
 * Detect PRs by comparing logged sets to the exercise's `personalBest` snapshot
 * baked into the artifact. Emits at most 2 PRs per exercise (weight + reps,
 * say) so a single workout doesn't flood the summary.
 */
export function detectExercisePrs(exercise: Exercise, loggedSets: LoggedSet[]): PrEvent[] {
    const completed = loggedSets.filter((s) => s.completed && !s.failed)
    if (completed.length === 0) return []
    const pb = exercise.personalBest
    if (!pb) {
        // No prior PB to beat — first completed set IS a PB. Emit one.
        const best = pickBestSet(completed, exercise.kind)
        if (!best) return []
        return firstTimePb(exercise, best)
    }

    const events: PrEvent[] = []

    switch (exercise.kind) {
        case 'weighted':
        case 'weighted_bw': {
            const heaviest = completed.reduce((best, s) =>
                (s.actualWeightKg ?? 0) > (best.actualWeightKg ?? 0) ? s : best,
            )
            if (
                heaviest.actualWeightKg !== undefined
                && heaviest.actualReps !== undefined
                && pb.weightKg !== undefined
                && heaviest.actualWeightKg > pb.weightKg
            ) {
                events.push({
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    kind: 'weight',
                    label: `${heaviest.actualWeightKg} kg × ${heaviest.actualReps}`,
                    previousLabel: pb.reps !== undefined ? `${pb.weightKg} kg × ${pb.reps}` : undefined,
                })
            }
            // Rep PR — same weight, more reps.
            if (
                heaviest.actualWeightKg !== undefined
                && heaviest.actualReps !== undefined
                && pb.weightKg !== undefined
                && pb.reps !== undefined
                && heaviest.actualWeightKg === pb.weightKg
                && heaviest.actualReps > pb.reps
            ) {
                events.push({
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    kind: 'reps',
                    label: `${heaviest.actualReps} reps @ ${heaviest.actualWeightKg} kg`,
                    previousLabel: `${pb.reps} @ ${pb.weightKg} kg`,
                })
            }
            // 1RM PR — beats estimated max even with lighter weight × more reps.
            // Skip when the set is an EXACT match for the recorded PB
            // (weight + reps both equal). Two formulas estimating a single-rep
            // ceiling can disagree by a few kg even on identical inputs, so
            // matching the PB shouldn't fire a "1RM PR" just because we recompute.
            if (pb.estimated1RM !== undefined) {
                for (const s of completed) {
                    if (s.actualWeightKg === undefined || s.actualReps === undefined) continue
                    if (s.actualWeightKg === pb.weightKg && s.actualReps === pb.reps) continue
                    const est = estimated1RM(s.actualWeightKg, s.actualReps)
                    if (est !== null && est > pb.estimated1RM) {
                        events.push({
                            exerciseId: exercise.id,
                            exerciseName: exercise.name,
                            kind: 'estimated_1rm',
                            label: `est. 1RM ${est} kg (${s.actualWeightKg}×${s.actualReps})`,
                            previousLabel: `${pb.estimated1RM} kg`,
                        })
                        break
                    }
                }
            }
            break
        }
        case 'bodyweight': {
            const mostReps = completed.reduce((best, s) =>
                (s.actualReps ?? 0) > (best.actualReps ?? 0) ? s : best,
            )
            if (
                mostReps.actualReps !== undefined
                && pb.reps !== undefined
                && mostReps.actualReps > pb.reps
            ) {
                events.push({
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    kind: 'reps',
                    label: `${mostReps.actualReps} reps`,
                    previousLabel: `${pb.reps} reps`,
                })
            }
            break
        }
        case 'hold': {
            const longest = completed.reduce((best, s) =>
                (s.actualDurationSec ?? 0) > (best.actualDurationSec ?? 0) ? s : best,
            )
            if (
                longest.actualDurationSec !== undefined
                && pb.durationSec !== undefined
                && longest.actualDurationSec > pb.durationSec
            ) {
                events.push({
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    kind: 'duration',
                    label: formatDuration(longest.actualDurationSec),
                    previousLabel: formatDuration(pb.durationSec),
                })
            }
            break
        }
        case 'cardio_dist': {
            const longest = completed.reduce((best, s) =>
                (s.actualDistanceM ?? 0) > (best.actualDistanceM ?? 0) ? s : best,
            )
            if (
                longest.actualDistanceM !== undefined
                && pb.distanceM !== undefined
                && longest.actualDistanceM > pb.distanceM
            ) {
                events.push({
                    exerciseId: exercise.id,
                    exerciseName: exercise.name,
                    kind: 'distance',
                    label: `${longest.actualDistanceM} m`,
                    previousLabel: `${pb.distanceM} m`,
                })
            }
            break
        }
        default:
            break
    }

    return events.slice(0, 2)
}

function firstTimePb(exercise: Exercise, best: LoggedSet): PrEvent[] {
    let label = ''
    let kind: PrEvent['kind'] = 'weight'
    switch (exercise.kind) {
        case 'weighted':
        case 'weighted_bw':
            if (best.actualWeightKg !== undefined && best.actualReps !== undefined) {
                label = `${best.actualWeightKg} kg × ${best.actualReps}`
                kind = 'weight'
            }
            break
        case 'bodyweight':
            if (best.actualReps !== undefined) {
                label = `${best.actualReps} reps`
                kind = 'reps'
            }
            break
        case 'hold':
            if (best.actualDurationSec !== undefined) {
                label = formatDuration(best.actualDurationSec)
                kind = 'duration'
            }
            break
        case 'cardio_dist':
            if (best.actualDistanceM !== undefined) {
                label = `${best.actualDistanceM} m`
                kind = 'distance'
            }
            break
        default:
            return []
    }
    if (!label) return []
    return [{
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        kind,
        label: `${label} (prima sesiune)`,
    }]
}

// === per-exercise history merge ============================================

/**
 * Merge a new session into an existing exercise history file. Pure: returns
 * the updated `ExerciseHistory` without mutating inputs.
 */
export function mergeExerciseHistory(
    existing: ExerciseHistory | null,
    workout: WorkoutArtifact,
    sessionLog: SessionLog,
    exerciseLog: SessionLog['exercises'][number],
): ExerciseHistory {
    const startDate = sessionLog.startedAt.slice(0, 10)
    const newEntry: ExerciseHistory['sessions'][number] = {
        date: startDate,
        sessionId: sessionLog.sessionId,
        title: sessionLog.title,
        bestSet: exerciseLog.bestSet ?? { completed: false },
        allSets: exerciseLog.loggedSets,
        totalVolumeKg: exerciseLog.totalVolumeKg,
        rpeAvg: averageRpe(exerciseLog.loggedSets),
    }

    const sessions = [newEntry, ...(existing?.sessions ?? []).filter((s) => s.sessionId !== sessionLog.sessionId)]
        .slice(0, 12)

    const newPB = computePersonalBest(
        exerciseLog.kind,
        existing?.personalBest ?? null,
        exerciseLog,
        startDate,
    )

    return {
        v: 1,
        id: exerciseLog.id,
        name: exerciseLog.name,
        kind: exerciseLog.kind,
        muscleGroups: exerciseLog.muscleGroups,
        personalBest: newPB,
        sessions,
        updatedAt: new Date().toISOString(),
    }
    void workout // reserved for future use (program tagging, etc.)
}

function averageRpe(sets: LoggedSet[]): number | undefined {
    const rpes = sets.map((s) => s.actualRpe).filter((r): r is number => typeof r === 'number')
    if (rpes.length === 0) return undefined
    return Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10
}

function computePersonalBest(
    kind: Exercise['kind'],
    existing: PersonalBest | null,
    exerciseLog: SessionLog['exercises'][number],
    date: string,
): PersonalBest | null {
    const best = exerciseLog.bestSet
    if (!best) return existing

    switch (kind) {
        case 'weighted':
        case 'weighted_bw': {
            if (best.actualWeightKg === undefined || best.actualReps === undefined) return existing
            const newEst = estimated1RM(best.actualWeightKg, best.actualReps) ?? undefined
            const currentScore = (existing?.weightKg ?? 0) * (existing?.reps ?? 0)
            const newScore = best.actualWeightKg * best.actualReps
            if (newScore > currentScore || (existing?.estimated1RM ?? 0) < (newEst ?? 0)) {
                return {
                    weightKg: best.actualWeightKg,
                    reps: best.actualReps,
                    estimated1RM: newEst,
                    achievedAt: date,
                }
            }
            return existing
        }
        case 'bodyweight':
            if (best.actualReps === undefined) return existing
            if (!existing || (existing.reps ?? 0) < best.actualReps) {
                return { reps: best.actualReps, achievedAt: date }
            }
            return existing
        case 'hold':
            if (best.actualDurationSec === undefined) return existing
            if (!existing || (existing.durationSec ?? 0) < best.actualDurationSec) {
                return { durationSec: best.actualDurationSec, achievedAt: date }
            }
            return existing
        case 'cardio_dist':
            if (best.actualDistanceM === undefined) return existing
            if (!existing || (existing.distanceM ?? 0) < best.actualDistanceM) {
                return { distanceM: best.actualDistanceM, achievedAt: date }
            }
            return existing
        default:
            return existing
    }
}

// === markdown formatting ===================================================

/**
 * One-line entry for `workouts/HISTORY.md`. Newest-first append order.
 *
 *   2026-05-25 · Push Day · Săpt 4 — 1h12m · 21/22 sets · 1,985 kg · 🏆 2 PRs
 */
export function formatHistoryEntryLine(log: SessionLog): string {
    const date = log.startedAt.slice(0, 10)
    const dur = formatDuration(log.totalDurationSec)
    const setStats = `${log.totalSetsCompleted}/${log.totalSetsPlanned} sets`
    const volume = log.totalVolumeKg > 0 ? `${Math.round(log.totalVolumeKg).toLocaleString()} ${log.units}` : ''
    const prs = log.prs.length > 0 ? `🏆 ${log.prs.length} PR${log.prs.length > 1 ? 's' : ''}` : ''
    const parts = [date, log.title, dur, setStats]
    if (volume) parts.push(volume)
    if (prs) parts.push(prs)
    return `- ${parts.join(' · ')}`
}

/**
 * Full markdown summary written to `workouts/sessions/<slug>.md`. Human
 * readable, mirrors what the SessionSummary card shows.
 */
export function formatSessionMarkdown(log: SessionLog): string {
    const lines: string[] = []
    lines.push(`# ${log.title}`)
    if (log.subtitle) lines.push(`> ${log.subtitle}`)
    lines.push('')

    const date = log.startedAt.slice(0, 10)
    lines.push(`- **Data**: ${date}`)
    lines.push(`- **Durată**: ${formatDuration(log.totalDurationSec)}`)
    lines.push(`- **Sets**: ${log.totalSetsCompleted}/${log.totalSetsPlanned} completed${log.totalSetsFailed ? `, ${log.totalSetsFailed} failed` : ''}`)
    if (log.totalVolumeKg > 0) {
        lines.push(`- **Tonnage**: ${Math.round(log.totalVolumeKg).toLocaleString()} ${log.units}`)
    }
    if (log.program) {
        lines.push(`- **Program**: ${log.program.name}${log.program.week ? ` · Week ${log.program.week}` : ''}${log.program.day ? ` · Day ${log.program.day}` : ''}`)
    }
    lines.push('')

    if (log.prs.length > 0) {
        lines.push(`## 🏆 PRs`)
        for (const pr of log.prs) {
            const diff = pr.previousLabel ? ` (was ${pr.previousLabel})` : ''
            lines.push(`- **${pr.exerciseName}** — ${pr.label}${diff}`)
        }
        lines.push('')
    }

    lines.push(`## Exerciții`)
    for (const ex of log.exercises) {
        const setStats = formatSetSequence(ex.loggedSets.map((s) => ({
            weightKg: s.actualWeightKg,
            reps: s.actualReps,
            durationSec: s.actualDurationSec,
        })))
        const skipped = ex.skipped ? ' _(skipped)_' : ''
        lines.push(`### ${ex.name}${skipped}`)
        if (setStats) lines.push(`- ${setStats}`)
        if (ex.totalVolumeKg > 0) lines.push(`- ${Math.round(ex.totalVolumeKg).toLocaleString()} ${log.units} volume`)
        const notes = ex.loggedSets.map((s) => s.notes).filter(Boolean)
        if (notes.length > 0) lines.push(`- Notes: ${notes.join(' · ')}`)
        lines.push('')
    }

    return lines.join('\n')
}

// === previous-snapshot builder for AI tool ================================

/**
 * Build a PreviousSessionSnapshot from the most recent ExerciseHistory entry.
 * Used by the getExerciseHistory tool to feed the LLM the prefilled context.
 */
export function buildPreviousFromHistory(history: ExerciseHistory): PreviousSessionSnapshot | undefined {
    const latest = history.sessions[0]
    if (!latest) return undefined
    return {
        date: latest.date,
        bestSet: {
            weightKg: latest.bestSet.actualWeightKg,
            reps: latest.bestSet.actualReps,
            durationSec: latest.bestSet.actualDurationSec,
            distanceM: latest.bestSet.actualDistanceM,
            rpe: latest.bestSet.actualRpe,
        },
        allSets: latest.allSets.map((s) => ({
            weightKg: s.actualWeightKg,
            reps: s.actualReps,
            durationSec: s.actualDurationSec,
            distanceM: s.actualDistanceM,
            rpe: s.actualRpe,
        })),
    }
}
