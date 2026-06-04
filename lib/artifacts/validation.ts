import { parseMapArtifact } from '@/lib/maps/schema'
import { parseRecipeArtifact } from '@/lib/recipe/parser'
import { parseWeatherArtifact } from '@/lib/weather/schema'
import { parseWorkoutArtifact } from '@/lib/workout/parser'

export type ArtifactContentValidationResult =
    | { ok: true }
    | { ok: false; error: string }

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
        default:
            return { ok: true }
    }
}

function parseResult(type: string, result: { ok: true } | { ok: false; error: string }): ArtifactContentValidationResult {
    if (result.ok) return { ok: true }
    return { ok: false, error: `${type}: ${result.error}` }
}
