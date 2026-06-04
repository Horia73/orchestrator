import type { ExerciseGroup, WorkoutArtifact } from './schema'
import { ExerciseGroupSchema } from './schema'

/**
 * Session-local plan additions. The artifact body stays immutable, while
 * mid-workout exercises live in persisted session state and are merged into
 * the effective workout wherever totals, rendering, or history are built.
 */
export interface WorkoutPlanExtension {
    addedGroups?: unknown
}

export function normalizeAddedGroups(value: unknown): ExerciseGroup[] {
    if (!Array.isArray(value)) return []
    const groups: ExerciseGroup[] = []
    for (const candidate of value.slice(0, 20)) {
        const parsed = ExerciseGroupSchema.safeParse(candidate)
        if (parsed.success) groups.push(parsed.data)
    }
    return groups
}

export function buildEffectiveWorkout(
    workout: WorkoutArtifact,
    extension: WorkoutPlanExtension,
): WorkoutArtifact {
    const addedGroups = normalizeAddedGroups(extension.addedGroups)
    if (addedGroups.length === 0) return workout
    return {
        ...workout,
        groups: [...workout.groups, ...addedGroups],
    }
}
