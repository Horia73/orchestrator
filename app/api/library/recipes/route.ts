import { NextResponse } from 'next/server'

import { listLatestArtifactsByType } from '@/lib/artifacts/store'
import { parseRecipeArtifact } from '@/lib/recipe/parser'

/**
 * GET /api/library/recipes?limit=100
 *
 * Lists the latest recipe artifacts across all user conversations. Each row
 * carries the parsed metadata the grid needs to render a card (title,
 * subtitle, time, difficulty, servings, image URL/query) without the
 * client having to re-parse the JSON body.
 *
 * Recipes with parse errors are skipped silently — they would still show
 * in their original conversation via the error card; surfacing them here
 * would be noise.
 */
export interface LibraryRecipeRow {
    id: string
    identifier: string
    version: number
    title: string
    subtitle?: string
    totalMinutes?: number
    difficulty?: 'usor' | 'mediu' | 'greu'
    servingsDefault?: number
    servingsLabel?: string
    imageUrl?: string
    imageQuery?: string
    conversationId: string
    conversationTitle: string | null
    createdAt: number
}

export async function GET(request: Request) {
    const url = new URL(request.url)
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100))

    const rows = listLatestArtifactsByType('application/vnd.ant.recipe', limit)
    const recipes: LibraryRecipeRow[] = []
    for (const r of rows) {
        const parsed = parseRecipeArtifact(r.content)
        if (!parsed.ok) continue
        const recipe = parsed.value
        const totalMinutes = recipe.totalMinutes
            ?? ((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0) || undefined)
        recipes.push({
            id: r.id,
            identifier: r.identifier,
            version: r.version,
            title: recipe.title,
            subtitle: recipe.subtitle,
            totalMinutes,
            difficulty: recipe.difficulty,
            servingsDefault: recipe.servings.default,
            servingsLabel: recipe.servings.unitLabel,
            imageUrl: recipe.images?.[0]?.url,
            imageQuery: recipe.imageQuery ?? recipe.title,
            conversationId: r.conversationId,
            conversationTitle: r.conversationTitle,
            createdAt: r.createdAt,
        })
    }

    return NextResponse.json({ recipes, total: recipes.length })
}
