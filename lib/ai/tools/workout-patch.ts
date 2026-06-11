import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { getArtifactById, insertArtifact } from '@/lib/artifacts/store'
import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { applyWorkoutPatch, type WorkoutPatchOp } from '@/lib/workout/patch'

// ---------------------------------------------------------------------------
// PatchWorkout tool — incremental edits to an existing workout artifact.
//
// The in-surface coach uses this to add / remove / replace / re-weight an
// exercise without re-emitting the entire workout JSON. It applies the ops to
// the stored artifact, re-validates against the schema, and inserts a new
// version (same identifier + sessionId), which surfaces live to the workout
// view via the `artifacts.changed` app event. Logged progress is preserved
// because the session is keyed by sessionId, which the patch leaves untouched.
// ---------------------------------------------------------------------------

export const PATCH_WORKOUT_TOOL_ID = 'PatchWorkout'

const WORKOUT_TYPE = 'application/vnd.ant.workout'

export const patchWorkoutTool: ToolDef = {
    id: PATCH_WORKOUT_TOOL_ID,
    name: PATCH_WORKOUT_TOOL_ID,
    description: [
        'Make an incremental edit to an EXISTING workout artifact in place, without re-emitting the whole JSON. Prefer this on the workout surface for small changes (swap/add/remove one exercise, change sets or weights, reorder); only re-emit a full artifact for big restructures or a brand-new workout.',
        'Pass `artifactId` (provided in the workout surface prompt context) and a list of `ops`. The edit preserves the user\'s logged progress — the sessionId is kept and exercise ids stay stable unless you explicitly replace an exercise.',
        'Op shapes (each item in `ops` is one object):',
        '• { "op": "add_exercise", "exercise": <full Exercise object>, "position"?: <group index> } — append a new exercise (default at the end).',
        '• { "op": "remove_exercise", "exerciseId": "lateral-raise" } — remove an exercise (confirm with the user first if it already has logged sets).',
        '• { "op": "replace_exercise", "exerciseId": "incline-db-press", "exercise": <full Exercise object> } — swap one movement for another in the same slot.',
        '• { "op": "set_planned", "exerciseId": "bench-press", "planned": [<PlannedSet>, …] } — replace just the sets of an exercise.',
        '• { "op": "edit_exercise", "exerciseId": "bench-press", "changes": { "defaultRestSec": 180 } } — shallow-merge fields (not id/kind).',
        '• { "op": "reorder", "order": ["squat","bench-press","row"] } — reorder exercises by id.',
        'Exercise/PlannedSet objects follow the same workout schema you use when emitting the artifact. Returns the new version number and a summary of what changed, or an error if the result would be invalid.',
    ].join('\n'),
    input_schema: {
        type: 'object',
        properties: {
            artifactId: {
                type: 'string',
                description: 'The id of the workout artifact to edit (from the surface prompt context). The new version is inserted under the same identifier.',
            },
            ops: {
                type: 'array',
                description: 'Ordered, non-empty list of edit ops to apply. See the op shapes in the tool description.',
                items: { type: 'object' },
            },
        },
        required: ['artifactId', 'ops'],
    },
    tags: ['workout', 'write'],
}

export async function executePatchWorkout(args: Record<string, unknown>): Promise<ToolResult> {
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
    if (!artifactId) {
        return { success: false, error: 'artifactId is required (the workout artifact to edit).' }
    }
    const ops = args.ops
    if (!Array.isArray(ops) || ops.length === 0) {
        return { success: false, error: 'ops must be a non-empty array.' }
    }

    const existing = getArtifactById(artifactId)
    if (!existing) {
        return { success: false, error: `No artifact with id "${artifactId}".` }
    }
    if (existing.type !== WORKOUT_TYPE) {
        return { success: false, error: `Artifact "${artifactId}" is not a workout (got "${existing.type}").` }
    }

    const parsed = parseWorkoutArtifact(existing.content)
    if (!parsed.ok) {
        return { success: false, error: `Stored workout did not parse: ${parsed.error}` }
    }

    const result = applyWorkoutPatch(parsed.value, ops as WorkoutPatchOp[])
    if (!result.ok) {
        return { success: false, error: result.error }
    }

    try {
        const row = insertArtifact({
            conversationId: existing.conversationId,
            messageId: existing.messageId,
            identifier: existing.identifier,
            type: WORKOUT_TYPE,
            title: existing.title,
            language: null,
            display: existing.display ?? 'fullscreen',
            content: JSON.stringify(result.workout),
        })
        return {
            success: true,
            data: {
                ok: true,
                artifactId: row.id,
                identifier: row.identifier,
                version: row.version,
                changes: result.changes,
                message: `Applied ${result.changes.length} change(s); the workout updated live.`,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to save patched workout.' }
    }
}
