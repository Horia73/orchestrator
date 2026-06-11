import { WorkoutArtifactSchema, type WorkoutArtifact } from './schema'

// ---------------------------------------------------------------------------
// Workout plan patch ops.
//
// Phase 2 of the in-surface coach: instead of re-emitting the whole workout
// JSON to make a small change, the agent calls the `PatchWorkout` tool with a
// list of ops. These pure functions apply them to the parsed artifact, and the
// tool re-validates the result against the schema before inserting a new
// version. This is faster and safer on long workouts (the agent can't drop a
// field), and — like a full re-emit — preserves the user's logged progress
// because the root (sessionId in particular) is carried through untouched and
// exercise ids stay stable unless explicitly replaced.
//
// Pure / no I/O. The tool layer owns persistence and the schema gate.
// ---------------------------------------------------------------------------

export type WorkoutPatchOp =
    /** Append a new exercise as its own straight group (default at the end). */
    | { op: 'add_exercise'; exercise: Record<string, unknown>; position?: number }
    /** Remove an exercise by id (its group is dropped if it becomes empty). */
    | { op: 'remove_exercise'; exerciseId: string }
    /** Swap an exercise in place — the new object keeps the slot/order. */
    | { op: 'replace_exercise'; exerciseId: string; exercise: Record<string, unknown> }
    /** Replace just the planned sets of an exercise. */
    | { op: 'set_planned'; exerciseId: string; planned: unknown[] }
    /** Shallow-merge fields onto an exercise (name, defaultRestSec, equipment,
     *  muscleGroups, description, alternatives, progression, …). `id` and
     *  `kind` are ignored here — use replace_exercise to change those. */
    | { op: 'edit_exercise'; exerciseId: string; changes: Record<string, unknown> }
    /** Reorder exercises by id. Listed ids come first (each as its own straight
     *  group); any omitted exercises keep their relative order after them. */
    | { op: 'reorder'; order: string[] }

export type WorkoutPatchResult =
    | { ok: true; workout: WorkoutArtifact; changes: string[] }
    | { ok: false; error: string }

interface MutableExercise {
    id?: unknown
    name?: unknown
    planned?: unknown
    [key: string]: unknown
}
interface MutableGroup {
    kind?: unknown
    exercises?: MutableExercise[]
    [key: string]: unknown
}
interface MutableWorkout {
    groups: MutableGroup[]
    [key: string]: unknown
}

function findExercise(
    workout: MutableWorkout,
    exerciseId: string,
): { group: MutableGroup; groupIndex: number; exIndex: number; exercise: MutableExercise } | null {
    for (let gi = 0; gi < workout.groups.length; gi++) {
        const group = workout.groups[gi]
        const exercises = group.exercises ?? []
        for (let ei = 0; ei < exercises.length; ei++) {
            if (exercises[ei]?.id === exerciseId) {
                return { group, groupIndex: gi, exIndex: ei, exercise: exercises[ei] }
            }
        }
    }
    return null
}

function exerciseName(ex: MutableExercise): string {
    return typeof ex.name === 'string' ? ex.name : typeof ex.id === 'string' ? ex.id : 'exercise'
}

/**
 * Apply a sequence of ops to a workout. Operates on a deep clone, re-validates
 * the result against the schema, and returns the validated workout plus a
 * human-readable list of what changed (for the agent's reply). Stops at the
 * first failing op.
 */
export function applyWorkoutPatch(
    workout: WorkoutArtifact,
    ops: readonly WorkoutPatchOp[],
): WorkoutPatchResult {
    if (!Array.isArray(ops) || ops.length === 0) {
        return { ok: false, error: 'ops must be a non-empty array' }
    }

    const draft = JSON.parse(JSON.stringify(workout)) as MutableWorkout
    if (!Array.isArray(draft.groups)) {
        return { ok: false, error: 'workout has no groups to patch' }
    }
    const changes: string[] = []

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') {
            return { ok: false, error: `op ${i + 1} is missing a string "op" field` }
        }
        switch (op.op) {
            case 'add_exercise': {
                if (!op.exercise || typeof op.exercise !== 'object') {
                    return { ok: false, error: `add_exercise (op ${i + 1}) needs an "exercise" object` }
                }
                const group: MutableGroup = { kind: 'straight', exercises: [op.exercise as MutableExercise] }
                const pos = typeof op.position === 'number'
                    ? Math.max(0, Math.min(draft.groups.length, Math.floor(op.position)))
                    : draft.groups.length
                draft.groups.splice(pos, 0, group)
                changes.push(`added ${exerciseName(op.exercise as MutableExercise)}`)
                break
            }
            case 'remove_exercise': {
                const found = findExercise(draft, op.exerciseId)
                if (!found) return { ok: false, error: `remove_exercise (op ${i + 1}): no exercise with id "${op.exerciseId}"` }
                const name = exerciseName(found.exercise)
                found.group.exercises!.splice(found.exIndex, 1)
                if ((found.group.exercises?.length ?? 0) === 0) {
                    draft.groups.splice(found.groupIndex, 1)
                }
                changes.push(`removed ${name}`)
                break
            }
            case 'replace_exercise': {
                if (!op.exercise || typeof op.exercise !== 'object') {
                    return { ok: false, error: `replace_exercise (op ${i + 1}) needs an "exercise" object` }
                }
                const found = findExercise(draft, op.exerciseId)
                if (!found) return { ok: false, error: `replace_exercise (op ${i + 1}): no exercise with id "${op.exerciseId}"` }
                const oldName = exerciseName(found.exercise)
                found.group.exercises![found.exIndex] = op.exercise as MutableExercise
                changes.push(`replaced ${oldName} with ${exerciseName(op.exercise as MutableExercise)}`)
                break
            }
            case 'set_planned': {
                if (!Array.isArray(op.planned)) {
                    return { ok: false, error: `set_planned (op ${i + 1}) needs a "planned" array` }
                }
                const found = findExercise(draft, op.exerciseId)
                if (!found) return { ok: false, error: `set_planned (op ${i + 1}): no exercise with id "${op.exerciseId}"` }
                found.exercise.planned = op.planned
                changes.push(`updated sets for ${exerciseName(found.exercise)}`)
                break
            }
            case 'edit_exercise': {
                if (!op.changes || typeof op.changes !== 'object') {
                    return { ok: false, error: `edit_exercise (op ${i + 1}) needs a "changes" object` }
                }
                const found = findExercise(draft, op.exerciseId)
                if (!found) return { ok: false, error: `edit_exercise (op ${i + 1}): no exercise with id "${op.exerciseId}"` }
                const { id: _id, kind: _kind, ...safe } = op.changes
                void _id
                void _kind
                Object.assign(found.exercise, safe)
                changes.push(`edited ${exerciseName(found.exercise)}`)
                break
            }
            case 'reorder': {
                if (!Array.isArray(op.order) || op.order.length === 0) {
                    return { ok: false, error: `reorder (op ${i + 1}) needs a non-empty "order" array of exercise ids` }
                }
                const all: MutableExercise[] = []
                for (const group of draft.groups) {
                    for (const ex of group.exercises ?? []) all.push(ex)
                }
                const byId = new Map(all.map((ex) => [ex.id, ex]))
                const ordered: MutableExercise[] = []
                const used = new Set<unknown>()
                for (const id of op.order) {
                    const ex = byId.get(id)
                    if (!ex) return { ok: false, error: `reorder (op ${i + 1}): no exercise with id "${id}"` }
                    ordered.push(ex)
                    used.add(id)
                }
                for (const ex of all) {
                    if (!used.has(ex.id)) ordered.push(ex)
                }
                draft.groups = ordered.map((ex) => ({ kind: 'straight', exercises: [ex] }))
                changes.push(`reordered exercises`)
                break
            }
            default:
                return { ok: false, error: `op ${i + 1}: unknown op "${(op as { op: string }).op}"` }
        }
    }

    const validated = WorkoutArtifactSchema.safeParse(draft)
    if (!validated.success) {
        const first = validated.error.issues[0]
        const path = first?.path?.join('.') ?? ''
        return { ok: false, error: `patched workout is invalid${path ? ` at ${path}` : ''}: ${first?.message ?? 'schema error'}` }
    }
    // Guard the one invariant that protects progress: sessionId must not change.
    if (validated.data.sessionId !== workout.sessionId) {
        return { ok: false, error: 'patch must not change sessionId' }
    }
    return { ok: true, workout: validated.data, changes }
}
