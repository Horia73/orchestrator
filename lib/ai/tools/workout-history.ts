import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    listExerciseHistoryIds,
    listRecentSessionSlugs,
    readExerciseHistory,
    readSessionLog,
} from '@/lib/workout/storage'
import { estimated1RM } from '@/lib/workout/one-rep-max'

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
        'Returns the personal best, the last few sessions with all sets, average RPE, and an estimated 1RM. Returns `found: false` if the exercise has no recorded history — that\'s a "first time doing this" signal; pick a conservative starting weight (RPE 7).',
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
        'Return summaries of the user\'s most recent N completed workout sessions (title, date, duration, sets, tonnage, PR count).',
        'Useful for "what did I do this week", deload-detection ("3 sessions in a row with RPE > 8.5"), or to avoid scheduling the same muscle group two days in a row.',
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
                failed: set.failed,
            })),
            totalVolumeKg: s.totalVolumeKg,
            rpeAvg: s.rpeAvg,
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
            prCount: log.prs.length,
            program: log.program,
            difficulty: log.difficulty,
            exerciseCount: log.exercises.length,
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
