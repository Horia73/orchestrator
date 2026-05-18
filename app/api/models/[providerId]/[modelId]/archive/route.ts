import { NextResponse } from 'next/server'
import { patchCuratedModel, effectiveModelExists, getEffectiveRegistry } from '@/lib/models/registry'
import { setFavorites, getConfig } from '@/lib/config'

/**
 * Toggle a model's archived flag in the curated layer.
 *
 *   PUT  /api/models/:providerId/:modelId/archive  { archived: true }
 *   DELETE /api/models/:providerId/:modelId/archive  // unarchive (== archived:false)
 *
 * Side effects:
 *   - Archived models are removed from the favorites list (UI hides them
 *     anyway; keeping a stale favorite confuses the per-agent picker).
 *   - If an agent was using the archived model, getEffectiveAgentSettings
 *     auto-falls back to the first non-archived model in the same provider.
 */
async function setArchived(providerId: string, modelId: string, archived: boolean) {
    if (!effectiveModelExists(providerId, modelId)) {
        return NextResponse.json({ error: `Unknown model: ${providerId}:${modelId}` }, { status: 404 })
    }

    patchCuratedModel(providerId, modelId, { archived })

    // Drop archived model from favorites so the picker doesn't surface it
    // under the Favorites group with a strikethrough — cleaner to remove.
    if (archived) {
        const config = getConfig()
        const key = `${providerId}:${modelId}`
        if (config.favorites.includes(key)) {
            setFavorites(config.favorites.filter(f => f !== key))
        }
    }

    return NextResponse.json({
        success: true,
        archived,
        registry: getEffectiveRegistry(),
    })
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ providerId: string; modelId: string }> }
) {
    const { providerId, modelId } = await params

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const archived = (body as Record<string, unknown>)?.archived
    if (typeof archived !== 'boolean') {
        return NextResponse.json({ error: 'Body must be { archived: boolean }' }, { status: 400 })
    }

    return setArchived(providerId, modelId, archived)
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ providerId: string; modelId: string }> }
) {
    const { providerId, modelId } = await params
    return setArchived(providerId, modelId, false)
}
