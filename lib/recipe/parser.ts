import { RecipeArtifactSchema, type RecipeArtifact } from './schema'

/**
 * Discriminated result so the renderer can show a styled error card in place
 * of a half-formed recipe when the model emits malformed JSON or violates the
 * schema (e.g. uses a non-metric unit). Never throws.
 */
export type RecipeArtifactParseResult =
    | { ok: true; value: RecipeArtifact }
    | { ok: false; error: string }

/**
 * Parse the body of an `application/vnd.ant.recipe` artifact. Returns a
 * discriminated union with a single human-readable error on failure. We
 * surface only the first Zod issue because the model can usually fix one
 * thing at a time, and a wall of issues is harder to act on.
 */
export function parseRecipeArtifact(rawJson: string): RecipeArtifactParseResult {
    let value: unknown
    try {
        value = JSON.parse(rawJson)
    } catch (e) {
        return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
    const parsed = RecipeArtifactSchema.safeParse(value)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `${path}: ${first.message}` }
    }
    return { ok: true, value: parsed.data }
}
