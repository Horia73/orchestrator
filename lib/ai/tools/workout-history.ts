import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    listExerciseHistoryIds,
    listRecentSessionSlugs,
    readExerciseHistory,
    readSessionLog,
} from '@/lib/workout/storage'
import { estimated1RM } from '@/lib/workout/one-rep-max'
import { loggedSetDurationSec } from '@/lib/workout/save-session'
import { appendBodyMetric, computeBmi, readBodyMetrics } from '@/lib/workout/body-metrics'

// ---------------------------------------------------------------------------
// Workout history tools.
//
// `getExerciseHistory` is the one the orchestrator calls BEFORE generating a
// new workout artifact. It returns the user's PB + last N sessions for a
// given exercise so the model can bake `previous` and `personalBest` into
// the artifact, then apply the progression rule.
//
// `listExerciseHistory` lets the model discover what exercises the user has
// any history on — useful when the user says "do my usual push day" and the
// model needs to pick exercises with established baselines.
//
// `getRecentSessions` returns workout-level summaries so the model can
// answer "show me my last 3 workouts" without parsing the markdown log.
// ---------------------------------------------------------------------------

export const GET_EXERCISE_HISTORY_TOOL_ID = 'GetExerciseHistory'
export const LIST_EXERCISE_HISTORY_TOOL_ID = 'ListExerciseHistory'
export const GET_RECENT_WORKOUTS_TOOL_ID = 'GetRecentWorkouts'

export const getExerciseHistoryTool: ToolDef = {
    id: GET_EXERCISE_HISTORY_TOOL_ID,
    name: GET_EXERCISE_HISTORY_TOOL_ID,
    description: [
        'Look up the user\'s history for a specific exercise (e.g. "bench-press", "front-squat") to populate `previous` and `personalBest` on the next workout artifact.',
        'Call this for EVERY exercise you intend to include in a workout BEFORE emitting the artifact, so the user sees "Last 60×8 @ RPE 8" context and the renderer can highlight new PRs.',
        'Returns the personal best, the last few sessions with all sets, set durations, rest periods after sets, average RPE, notes/comments, failures, partial reps, and an estimated 1RM. Read timing, notes, and failed sets before progressing weight; rushed/overlong rests, pain/form-breakdown notes, and repeated high-RPE failures should affect advice.',
        'Returns `found: false` if the exercise has no recorded history — that\'s a "first time doing this" signal; pick a conservative starting weight (RPE 7).',
        'Exercise IDs are kebab-case slugs ("bench-press", "rdl", "ohp"). Use the same slug here that you put in the artifact\'s `exercises[].id` field.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            exerciseId: {
                type: 'string',
                description: 'Kebab-case exercise slug. Must match the artifact `exercises[].id`.',
            },
            limit: {
                type: 'number',
                description: 'Max number of past sessions to return. Defaults to 5. Cap 12.',
            },
        },
        required: ['exerciseId'],
    },
    tags: ['workout', 'workout-history'],
}

export const listExerciseHistoryTool: ToolDef = {
    id: LIST_EXERCISE_HISTORY_TOOL_ID,
    name: LIST_EXERCISE_HISTORY_TOOL_ID,
    description: [
        'List all exercise IDs the user has any logged history for, plus the date of their most recent session at each.',
        'Useful when the user asks for "my usual workout" or you want to bias exercise selection toward moves the user already has progression data on.',
        'Returns up to 200 entries — exercises are pruned only on explicit user request.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['workout', 'workout-history'],
}

export const getRecentWorkoutsTool: ToolDef = {
    id: GET_RECENT_WORKOUTS_TOOL_ID,
    name: GET_RECENT_WORKOUTS_TOOL_ID,
    description: [
        'Return summaries of the user\'s most recent N completed workout sessions (title, date, duration, sets, tonnage, PR count, set/rest timing).',
        'Useful for "what did I do this week", deload-detection ("3 sessions in a row with RPE > 8.5"), or to avoid scheduling the same muscle group two days in a row.',
        'Includes aggregate muscle groups and compact per-exercise summaries so you can rotate push/pull/legs/upper/lower from what the user actually trained recently.',
        'Does NOT return the full session log — call this for a quick overview, then optionally call GetExerciseHistory for deep dives per movement.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: 'Max sessions to return. Defaults to 10. Cap 30.',
            },
        },
    },
    tags: ['workout', 'workout-history'],
}

// === execution =============================================================

export async function executeGetExerciseHistory(args: Record<string, unknown>): Promise<ToolResult> {
    const exerciseId = typeof args.exerciseId === 'string' ? args.exerciseId.trim() : ''
    if (!exerciseId || !/^[a-z0-9][a-z0-9_-]*$/.test(exerciseId)) {
        return { success: false, error: 'exerciseId must be a kebab-case slug like "bench-press"' }
    }
    const limitRaw = typeof args.limit === 'number' ? args.limit : 5
    const limit = Math.max(1, Math.min(12, Math.floor(limitRaw)))

    const history = readExerciseHistory(exerciseId)
    if (!history) {
        return {
            success: true,
            data: {
                exerciseId,
                found: false,
                message: 'No prior history — first time recording this exercise. Pick a conservative starting weight (RPE 7).',
            },
        }
    }

    const sessions = history.sessions.slice(0, limit).map((s) => {
        const est1RM = s.bestSet.actualWeightKg !== undefined && s.bestSet.actualReps !== undefined
            ? estimated1RM(s.bestSet.actualWeightKg, s.bestSet.actualReps)
            : null
        return {
            date: s.date,
            sessionId: s.sessionId,
            title: s.title,
            bestSet: {
                weightKg: s.bestSet.actualWeightKg,
                reps: s.bestSet.actualReps,
                durationSec: s.bestSet.actualDurationSec,
                distanceM: s.bestSet.actualDistanceM,
                rpe: s.bestSet.actualRpe,
                estimated1RM: est1RM,
            },
            allSets: s.allSets.map((set) => ({
                weightKg: set.actualWeightKg,
                reps: set.actualReps,
                durationSec: set.actualDurationSec,
                distanceM: set.actualDistanceM,
                rpe: set.actualRpe,
                rir: set.actualRir,
                startedAt: set.startedAt,
                completedAt: set.completedAt,
                setDurationSec: loggedSetDurationSec(set),
                failed: set.failed,
                partialReps: set.partialReps,
                notes: set.notes,
            })),
            totalVolumeKg: s.totalVolumeKg,
            rpeAvg: s.rpeAvg,
            avgSetDurationSec: s.avgSetDurationSec,
            avgRestSec: s.avgRestSec,
            restEvents: s.restEvents?.map((event) => ({
                setIndex: event.setIndex,
                plannedSec: event.plannedSec,
                elapsedSec: event.elapsedSec,
                status: event.status,
                startedAt: event.startedAt,
                endedAt: event.endedAt,
            })) ?? [],
        }
    })

    return {
        success: true,
        data: {
            exerciseId,
            found: true,
            name: history.name,
            kind: history.kind,
            muscleGroups: history.muscleGroups,
            personalBest: history.personalBest,
            sessions,
            updatedAt: history.updatedAt,
            hint: 'When generating the next workout, copy personalBest into `exercises[].personalBest` and the latest session into `exercises[].previous`. Apply the progression rule to suggest the next target.',
        },
    }
}

export async function executeListExerciseHistory(): Promise<ToolResult> {
    const ids = listExerciseHistoryIds()
    const entries = ids.map((id) => {
        const h = readExerciseHistory(id)
        if (!h) return null
        const latest = h.sessions[0]
        return {
            id,
            name: h.name,
            kind: h.kind,
            muscleGroups: h.muscleGroups,
            lastSessionDate: latest?.date ?? null,
            personalBest: h.personalBest,
        }
    }).filter((e): e is NonNullable<typeof e> => !!e)
    // Sort by most recent session first.
    entries.sort((a, b) => (b.lastSessionDate ?? '').localeCompare(a.lastSessionDate ?? ''))
    return {
        success: true,
        data: {
            exercises: entries.slice(0, 200),
            total: entries.length,
        },
    }
}

export async function executeGetRecentWorkouts(args: Record<string, unknown>): Promise<ToolResult> {
    const limitRaw = typeof args.limit === 'number' ? args.limit : 10
    const limit = Math.max(1, Math.min(30, Math.floor(limitRaw)))
    const slugs = listRecentSessionSlugs(limit)
    const sessions = slugs.map((slug) => {
        const log = readSessionLog(slug)
        if (!log) return null
        const muscleGroups = [...new Set(log.exercises.flatMap((e) => e.muscleGroups))]
        const restEvents = log.restEvents ?? []
        const restSummary = log.restSummary ?? {
            avgRestSec: undefined,
            plannedAvgRestSec: undefined,
            skippedCount: 0,
        }
        return {
            slug,
            sessionId: log.sessionId,
            title: log.title,
            date: log.startedAt.slice(0, 10),
            startedAt: log.startedAt,
            completedAt: log.completedAt,
            durationSec: log.totalDurationSec,
            setsCompleted: log.totalSetsCompleted,
            setsPlanned: log.totalSetsPlanned,
            setsFailed: log.totalSetsFailed,
            volumeKg: log.totalVolumeKg,
            avgRestSec: restSummary.avgRestSec,
            plannedAvgRestSec: restSummary.plannedAvgRestSec,
            shortenedRestCount: restSummary.skippedCount,
            prCount: log.prs.length,
            program: log.program,
            difficulty: log.difficulty,
            exerciseCount: log.exercises.length,
            muscleGroups,
            exercises: log.exercises.map((exercise) => ({
                id: exercise.id,
                name: exercise.name,
                muscleGroups: exercise.muscleGroups,
                setsCompleted: exercise.loggedSets.filter((set) => set.completed && !set.failed).length,
                setsFailed: exercise.loggedSets.filter((set) => set.failed).length,
                bestSet: exercise.bestSet ? {
                    weightKg: exercise.bestSet.actualWeightKg,
                    reps: exercise.bestSet.actualReps,
                    durationSec: exercise.bestSet.actualDurationSec,
                    distanceM: exercise.bestSet.actualDistanceM,
                    rpe: exercise.bestSet.actualRpe,
                    setDurationSec: loggedSetDurationSec(exercise.bestSet),
                } : null,
                avgSetDurationSec: averageDuration(exercise.loggedSets.map(loggedSetDurationSec)),
                avgRestSec: averageDuration(restEvents
                    .filter((event) => event.exerciseId === exercise.id)
                    .map((event) => event.elapsedSec)),
                notes: exercise.loggedSets
                    .map((set) => set.notes)
                    .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
                    .slice(0, 5),
            })),
        }
    }).filter((s): s is NonNullable<typeof s> => !!s)
    return {
        success: true,
        data: {
            sessions,
            count: sessions.length,
        },
    }
}

function averageDuration(values: Array<number | undefined>): number | undefined {
    const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (nums.length === 0) return undefined
    return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 10) / 10
}

// ---------------------------------------------------------------------------
// Body metrics tools.
//
// `GetBodyMetrics` lets the orchestrator read the user's latest height /
// weight / body-fat % / muscle % (plus computed BMI) BEFORE composing a
// workout, so it can scale loads to bodyweight and bias volume/intensity to
// the user's profile and goal. `SaveBodyMetrics` persists what the user
// shares in chat so the Library card and future sessions stay in sync —
// only call it with values the user actually gave.
// ---------------------------------------------------------------------------

export const GET_BODY_METRICS_TOOL_ID = 'GetBodyMetrics'
export const SAVE_BODY_METRICS_TOOL_ID = 'SaveBodyMetrics'

export const getBodyMetricsTool: ToolDef = {
    id: GET_BODY_METRICS_TOOL_ID,
    name: GET_BODY_METRICS_TOOL_ID,
    description: [
        "Read the user's recorded body metrics — latest height (cm), weight (kg), body-fat %, muscle %, plus the computed BMI and a short trend of recent entries.",
        'Call this BEFORE composing a workout so you can scale loads to bodyweight (assisted/weighted-bodyweight moves especially), pick appropriate exercises, and bias volume vs intensity and hypertrophy vs conditioning to the user profile and stated goal.',
        "Returns `found: false` when nothing is recorded yet — that's your cue to ASK the user for the relevant metrics, then persist them with SaveBodyMetrics so you don't have to ask again.",
        'Metrics older than ~30 days are stale for a cut/bulk — re-ask if the goal depends on current composition.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: 'Max recent entries to return for the trend. Defaults to 8. Cap 50.',
            },
        },
    },
    tags: ['workout', 'workout-history'],
}

export const saveBodyMetricsTool: ToolDef = {
    id: SAVE_BODY_METRICS_TOOL_ID,
    name: SAVE_BODY_METRICS_TOOL_ID,
    description: [
        'Persist body metrics the user just shared in conversation so they appear on the Library body-metrics card and seed future workouts.',
        'Pass ONLY the fields the user actually gave you — every field is optional, but include at least one. Records a new dated entry (history is preserved; it never overwrites).',
        'Units: heightCm in centimetres, weightKg in kilograms, bodyFatPct and musclePct as percentages of bodyweight (NOT kilograms).',
        'Do not invent or estimate values — if the user did not state a metric, leave it out.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            heightCm: { type: 'number', description: 'Height in centimetres (80–260).' },
            weightKg: { type: 'number', description: 'Bodyweight in kilograms (20–400).' },
            bodyFatPct: { type: 'number', description: 'Body-fat percentage of bodyweight (1–80).' },
            musclePct: { type: 'number', description: 'Skeletal-muscle percentage of bodyweight (5–80).' },
            notes: { type: 'string', description: 'Optional short note (e.g. "morning, fasted").' },
        },
    },
    tags: ['workout', 'workout-history'],
}

export async function executeGetBodyMetrics(args: Record<string, unknown>): Promise<ToolResult> {
    const limitRaw = typeof args.limit === 'number' ? args.limit : 8
    const limit = Math.max(1, Math.min(50, Math.floor(limitRaw)))
    const entries = readBodyMetrics(limit)
    const latest = entries[0] ?? null
    if (!latest) {
        return {
            success: true,
            data: {
                found: false,
                message: 'No body metrics recorded yet. If composition matters for this request, ask the user for height, weight, body-fat %, and muscle %, then persist with SaveBodyMetrics.',
            },
        }
    }
    return {
        success: true,
        data: {
            found: true,
            latest: {
                recordedAt: latest.recordedAt,
                heightCm: latest.heightCm,
                weightKg: latest.weightKg,
                bodyFatPct: latest.bodyFatPct,
                musclePct: latest.musclePct,
                bmi: computeBmi(latest.weightKg, latest.heightCm),
                notes: latest.notes,
            },
            history: entries.map((entry) => ({
                recordedAt: entry.recordedAt,
                weightKg: entry.weightKg,
                bodyFatPct: entry.bodyFatPct,
                musclePct: entry.musclePct,
            })),
            count: entries.length,
            hint: 'Use weight/height/BMI to scale loads and volume; use body-fat % and muscle % with the stated goal (cut/recomp/bulk) to bias intensity and conditioning. If the latest entry is stale, confirm current values before a composition-dependent plan.',
        },
    }
}

export async function executeSaveBodyMetrics(args: Record<string, unknown>): Promise<ToolResult> {
    const heightCm = clampMetric(args.heightCm, 80, 260)
    const weightKg = clampMetric(args.weightKg, 20, 400)
    const bodyFatPct = clampMetric(args.bodyFatPct, 1, 80)
    const musclePct = clampMetric(args.musclePct, 5, 80)
    const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 300) || undefined : undefined

    if (heightCm === undefined && weightKg === undefined && bodyFatPct === undefined && musclePct === undefined && !notes) {
        return {
            success: false,
            error: 'Provide at least one metric the user actually gave you: heightCm, weightKg, bodyFatPct, musclePct, or notes.',
        }
    }

    const entry = appendBodyMetric({
        recordedAt: new Date().toISOString(),
        heightCm,
        weightKg,
        bodyFatPct,
        musclePct,
        notes,
    })

    return {
        success: true,
        data: {
            saved: true,
            entry,
            bmi: computeBmi(entry.weightKg, entry.heightCm),
            message: 'Saved. It now shows on the Library body-metrics card and will inform future workouts.',
        },
    }
}

function clampMetric(value: unknown, min: number, max: number): number | undefined {
    if (value === null || value === undefined || value === '') return undefined
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (!Number.isFinite(n)) return undefined
    return Math.min(max, Math.max(min, Math.round(n * 10) / 10))
}
