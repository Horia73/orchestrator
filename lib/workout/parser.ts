import {
    WorkoutArtifactSchema,
    type WorkoutArtifact,
    type WorkoutArtifactParseResult,
} from './schema'

/**
 * Parse the body of an `application/vnd.ant.workout` artifact. Returns a
 * discriminated union with a single human-readable error on failure. We
 * surface only the first Zod issue because the model can usually fix one
 * thing at a time, and a wall of issues is harder to act on.
 *
 * Mirrors the recipe / weather parser shape so all artifact-domain parsers
 * present the same `{ ok, value } | { ok, error }` API to the renderer.
 */
export function parseWorkoutArtifact(rawJson: string): WorkoutArtifactParseResult {
    let value: unknown
    try {
        value = JSON.parse(rawJson)
    } catch (e) {
        return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
    const parsed = WorkoutArtifactSchema.safeParse(value)
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => {
            const path = issue.path.length ? issue.path.join('.') : '(root)'
            return `${path}: ${issue.message}`
        })
        // `error` stays the single first issue (the renderer error card and
        // callers that read `.error` are unchanged); `issues` is the full list
        // for the repair pass.
        return { ok: false, error: issues[0], issues }
    }
    return { ok: true, value: parsed.data as WorkoutArtifact }
}
