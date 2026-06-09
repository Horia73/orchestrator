import {
    searchRecipeImages,
    type RecipeImageResult,
} from '@/lib/recipe/image-search'

import { searchExerciseGifs } from './exercise-gif-search'

export interface WorkoutImageResult extends Omit<RecipeImageResult, 'mime'> {
    /** Workout demos can be animated GIFs from ExerciseDB OSS or static images from fallback providers. */
    mime: RecipeImageResult['mime'] | 'image/gif'
}

/**
 * Keyless exercise media lookup. ExerciseDB OSS GIFs are preferred because
 * workout cards need motion; Wikimedia Commons remains the still-image
 * fallback for exercises that have no confident GIF match.
 */
export async function searchWorkoutImages(
    rawQuery: string,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WorkoutImageResult[]> {
    const query = rawQuery.trim()
    if (!query) return []

    const exerciseGifs = await searchExerciseGifs(query, options)
    if (exerciseGifs.length > 0) return exerciseGifs

    const enriched = /\b(exercise|workout|gym|machine|fitness|strength)\b/i.test(query)
        ? query
        : `${query} exercise gym machine`
    const primary = await searchRecipeImages(enriched, options) as WorkoutImageResult[]
    if (primary.length > 0) return primary

    const simplified = query
        .replace(/\b(exercise|workout|gym|machine|fitness|strength|setup|demo|form)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (simplified && simplified.toLowerCase() !== query.toLowerCase()) {
        return searchRecipeImages(simplified, options) as Promise<WorkoutImageResult[]>
    }

    if (enriched.toLowerCase() !== query.toLowerCase()) {
        return searchRecipeImages(query, options) as Promise<WorkoutImageResult[]>
    }

    return []
}
