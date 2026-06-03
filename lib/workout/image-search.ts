import {
    searchRecipeImages,
    type RecipeImageResult,
} from '@/lib/recipe/image-search'

export type WorkoutImageResult = RecipeImageResult

/**
 * Keyless exercise image lookup backed by Wikimedia Commons. We reuse the
 * generic Commons parser/cache from recipe images and bias the query toward
 * exercise/machine setup so the first result is more likely to be useful in
 * a gym context.
 */
export async function searchWorkoutImages(
    rawQuery: string,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WorkoutImageResult[]> {
    const query = rawQuery.trim()
    if (!query) return []
    const enriched = /\b(exercise|workout|gym|machine|fitness|strength)\b/i.test(query)
        ? query
        : `${query} exercise gym machine`
    const primary = await searchRecipeImages(enriched, options)
    if (primary.length > 0) return primary

    const simplified = query
        .replace(/\b(exercise|workout|gym|machine|fitness|strength|setup|demo|form)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (simplified && simplified.toLowerCase() !== query.toLowerCase()) {
        return searchRecipeImages(simplified, options)
    }

    if (enriched.toLowerCase() !== query.toLowerCase()) {
        return searchRecipeImages(query, options)
    }

    return []
}
