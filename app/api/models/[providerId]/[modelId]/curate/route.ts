import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
    CapabilitySchema,
    ModelFeatureSchema,
    ModelKindSchema,
    ModelPricingSchema,
    ResearchSourceSchema,
    ThinkingLevelSchema,
    IntelligenceTierSchema,
    ModelCustomMetadataSchema,
} from '@/lib/models/schema'
import {
    patchCuratedModel,
    clearCuratedModel,
    effectiveModelExists,
    getEffectiveRegistry,
} from '@/lib/models/registry'

/**
 * PUT /api/models/:providerId/:modelId/curate
 *
 * Patches the curated layer for a single model. Body shape mirrors
 * `CuratedModelEntry` — every field optional, only provided fields are
 * overwritten. Use a separate DELETE to clear all curated overrides for
 * a model (falls back to seed/live).
 *
 * `pricing` may be:
 *   - { kind: 'tokens', inputPerMillion, outputPerMillion, inputPerMillionLarge?, outputPerMillionLarge? }
 *   - { kind: 'subscription' }
 *   - null                  // "explicitly unknown" — triggers research prompt
 *   - omitted               // leave previous curated pricing in place
 */
const CurateBodySchema = z.object({
    pricing: ModelPricingSchema.nullable().optional(),
    kinds: z.array(ModelKindSchema).optional(),
    thinkingLevels: z.array(ThinkingLevelSchema).optional(),
    defaultThinkingLevel: ThinkingLevelSchema.optional(),
    intelligenceTier: IntelligenceTierSchema.optional(),
    archived: z.boolean().optional(),
    displayNameOverride: z.string().min(1).optional(),
    notes: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    knowledgeCutoff: z.string().min(1).optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    features: z.array(ModelFeatureSchema).optional(),
    pricingNotes: z.string().optional(),
    researchSources: z.array(ResearchSourceSchema).optional(),
    customMetadata: z.array(ModelCustomMetadataSchema).optional(),
    /** Set automatically when the future research agent runs. */
    lastResearchedAt: z.number().int().nonnegative().optional(),
})

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ providerId: string; modelId: string }> }
) {
    const { providerId, modelId } = await params

    if (!effectiveModelExists(providerId, modelId)) {
        return NextResponse.json({ error: `Unknown model: ${providerId}:${modelId}` }, { status: 404 })
    }

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = CurateBodySchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Invalid curate body', issues: parsed.error.issues },
            { status: 400 }
        )
    }

    patchCuratedModel(providerId, modelId, parsed.data)

    return NextResponse.json({
        success: true,
        registry: getEffectiveRegistry(),
    })
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ providerId: string; modelId: string }> }
) {
    const { providerId, modelId } = await params

    if (!effectiveModelExists(providerId, modelId)) {
        return NextResponse.json({ error: `Unknown model: ${providerId}:${modelId}` }, { status: 404 })
    }

    clearCuratedModel(providerId, modelId)

    return NextResponse.json({
        success: true,
        registry: getEffectiveRegistry(),
    })
}
