import { parseCadArtifact } from '@/lib/cad/schema'
import { parseMapArtifact } from '@/lib/maps/schema'
import { parseQuestionArtifact } from '@/lib/questions/schema'
import { parseRecipeArtifact } from '@/lib/recipe/parser'
import { parseWeatherArtifact } from '@/lib/weather/schema'
import { parseWorkoutArtifact } from '@/lib/workout/parser'

export type ArtifactContentValidationResult =
    | { ok: true }
    // `issues` (when present) lists every validation issue so the repair pass
    // can fix them all at once; `error` remains the single first issue.
    | { ok: false; error: string; issues?: string[] }

/**
 * Renderer-backed artifact types whose body must satisfy a strict schema.
 * Kept in sync with the `validateArtifactContent` switch below. The chat
 * route's in-turn repair pass only attempts to fix failures for these types
 * (everything else is permissive and never throws on persist).
 */
export const STRICT_ARTIFACT_TYPES = new Set<string>([
    'application/vnd.ant.map',
    'application/vnd.ant.weather',
    'application/vnd.ant.recipe',
    'application/vnd.ant.workout',
    'application/vnd.ant.cad',
    'application/vnd.ant.question',
])

export function isStrictArtifactType(type: string): boolean {
    return STRICT_ARTIFACT_TYPES.has(type)
}

/**
 * Strict renderer-backed artifact types must validate before persistence.
 * Plain/code/html artifacts intentionally stay permissive because their
 * renderers already have safe fallback behavior for partial or user-authored
 * content.
 */
export function validateArtifactContent(type: string, content: string): ArtifactContentValidationResult {
    switch (type) {
        case 'application/vnd.ant.map':
            return parseResult(type, parseMapArtifact(content))
        case 'application/vnd.ant.weather':
            return parseResult(type, parseWeatherArtifact(content))
        case 'application/vnd.ant.recipe':
            return parseResult(type, parseRecipeArtifact(content))
        case 'application/vnd.ant.workout':
            return parseResult(type, parseWorkoutArtifact(content))
        case 'application/vnd.ant.cad':
            return parseResult(type, parseCadArtifact(content))
        case 'application/vnd.ant.question':
            return parseResult(type, parseQuestionArtifact(content))
        default:
            return { ok: true }
    }
}

function parseResult(
    type: string,
    result: { ok: true } | { ok: false; error: string; issues?: string[] },
): ArtifactContentValidationResult {
    if (result.ok) return { ok: true }
    return {
        ok: false,
        error: `${type}: ${result.error}`,
        issues: result.issues?.map((issue) => `${type}: ${issue}`),
    }
}
