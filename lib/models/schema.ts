import { z } from 'zod'

// ---------------------------------------------------------------------------
// Common atomic schemas
// ---------------------------------------------------------------------------

const StableIdSchema = z.string().min(1).max(96).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)

/**
 * Provider/model metadata changes over time. These identifiers are deliberately
 * open strings so the research flow can persist new official values without a
 * source change. Known values are still ordered/labeled by the UI and mapped by
 * provider adapters when they understand them.
 */
export const ThinkingLevelSchema = StableIdSchema
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>

export const CapabilitySchema = StableIdSchema
export type Capability = z.infer<typeof CapabilitySchema>

export const IntelligenceTierSchema = StableIdSchema
export type IntelligenceTier = z.infer<typeof IntelligenceTierSchema>

/**
 * What kind(s) of generation a model performs. Differs from `capabilities`,
 * which describes input/feature support. A model with `capabilities: ['text']`
 * has `kinds: ['text']`, while an image-gen model has `kinds: ['image']`.
 *
 * Defaults to `['text']` when absent so existing seed data keeps working.
 * The settings UI uses this to filter the model picker by agent kind.
 */
export const ModelKindSchema = StableIdSchema
export type ModelKind = z.infer<typeof ModelKindSchema>

/**
 * Pricing is a discriminated union:
 * - `tokens`: standard per-token billing (with optional large-context tier)
 * - `subscription`: included in a flat-rate plan (e.g. Claude Code via Max)
 *
 * `null` (vs absence of the field) means "we explicitly know we don't know" —
 * surfaces an "incomplete data" indicator and unlocks the Research action.
 */
export const ModelPricingSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('tokens'),
        inputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative(),
        largeContextThreshold: z.number().int().positive().optional(),
        inputPerMillionLarge: z.number().nonnegative().optional(),
        outputPerMillionLarge: z.number().nonnegative().optional(),
        cachedInputPerMillion: z.number().nonnegative().optional(),
        tiers: z.array(z.object({
            name: z.string().min(1),
            threshold: z.number().nonnegative().optional(),
            inputPerMillion: z.number().nonnegative().optional(),
            outputPerMillion: z.number().nonnegative().optional(),
            cachedInputPerMillion: z.number().nonnegative().optional(),
            notes: z.string().optional(),
        })).optional(),
    }),
    z.object({
        kind: z.literal('unit'),
        unit: z.string().min(1),
        pricePerUnit: z.number().nonnegative().optional(),
        currency: z.string().min(1).optional(),
        tiers: z.array(z.object({
            name: z.string().min(1),
            unit: z.string().min(1).optional(),
            pricePerUnit: z.number().nonnegative().optional(),
            inputPerMillion: z.number().nonnegative().optional(),
            outputPerMillion: z.number().nonnegative().optional(),
            threshold: z.number().nonnegative().optional(),
            notes: z.string().optional(),
        })).optional(),
        notes: z.string().optional(),
    }),
    z.object({
        kind: z.literal('subscription'),
    }),
])
export type ModelPricing = z.infer<typeof ModelPricingSchema>

// Pricing field: union | null. `null` = explicitly unknown; absent = no override.
const PricingFieldSchema = ModelPricingSchema.nullable()

export const ModelFeatureValueSchema = z.union([z.boolean(), z.string(), z.number()])
export type ModelFeatureValue = z.infer<typeof ModelFeatureValueSchema>

const ModelFeatureBaseSchema = z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    label: z.string().min(1),
    description: z.string().optional(),
    category: z.string().optional(),
    providerParam: z.string().optional(),
})

export const ModelFeatureSchema = z.discriminatedUnion('type', [
    ModelFeatureBaseSchema.extend({
        type: z.literal('boolean'),
        defaultValue: z.boolean().optional(),
    }),
    ModelFeatureBaseSchema.extend({
        type: z.literal('enum'),
        defaultValue: z.string().optional(),
        options: z.array(z.object({
            value: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
        })).min(1),
    }),
    ModelFeatureBaseSchema.extend({
        type: z.literal('number'),
        defaultValue: z.number().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().positive().optional(),
        unit: z.string().optional(),
    }),
    ModelFeatureBaseSchema.extend({
        type: z.literal('string'),
        defaultValue: z.string().optional(),
        placeholder: z.string().optional(),
    }),
])
export type ModelFeature = z.infer<typeof ModelFeatureSchema>

export const ResearchSourceSchema = z.object({
    title: z.string().optional(),
    url: z.string().url(),
    publisher: z.string().optional(),
    accessedAt: z.number().int().nonnegative().optional(),
})
export type ResearchSource = z.infer<typeof ResearchSourceSchema>

export const ModelCustomMetadataSchema = z.object({
    id: StableIdSchema,
    label: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    unit: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    description: z.string().optional(),
    sourceUrl: z.string().url().optional(),
})
export type ModelCustomMetadata = z.infer<typeof ModelCustomMetadataSchema>

export const ModelDataFieldSchema = StableIdSchema
export type ModelDataField = z.infer<typeof ModelDataFieldSchema>

// ---------------------------------------------------------------------------
// Layer 1 — built-in seed (lib/models/seed.json)
// ---------------------------------------------------------------------------

export const SeedModelEntrySchema = z.object({
    name: z.string().min(1),
    /**
     * Generation kinds. Optional: defaults to `['text']` when absent.
     * Image/video/speech models declare their kind explicitly so the settings
     * picker can filter them per agent.
     */
    kinds: z.array(ModelKindSchema).optional(),
    /** Context window in tokens. Optional for non-text models. */
    contextWindow: z.number().int().positive().optional(),
    /** Max output tokens. Optional for non-text models. */
    maxOutputTokens: z.number().int().positive().optional(),
    /** Official model knowledge/training cutoff, when published. Free-form date label. */
    knowledgeCutoff: z.string().min(1).optional(),
    pricing: PricingFieldSchema,
    capabilities: z.array(CapabilitySchema).optional(),
    features: z.array(ModelFeatureSchema).optional(),
    thinkingLevels: z.array(ThinkingLevelSchema).optional(),
    defaultThinkingLevel: ThinkingLevelSchema.optional(),
    intelligenceTier: IntelligenceTierSchema.optional(),
    notes: z.string().optional(),
    pricingNotes: z.string().optional(),
    researchSources: z.array(ResearchSourceSchema).optional(),
    customMetadata: z.array(ModelCustomMetadataSchema).optional(),
})
export type SeedModelEntry = z.infer<typeof SeedModelEntrySchema>

export const SeedProviderEntrySchema = z.object({
    name: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    /** Endpoint to hit when refreshing the live registry — informational here. */
    listEndpoint: z.string().url().optional(),
    models: z.record(z.string(), SeedModelEntrySchema),
})
export type SeedProviderEntry = z.infer<typeof SeedProviderEntrySchema>

export const SeedRegistrySchema = z.object({
    /** Schema version — bump when a breaking change requires migration */
    version: z.literal(1),
    providers: z.record(z.string(), SeedProviderEntrySchema),
})
export type SeedRegistry = z.infer<typeof SeedRegistrySchema>

// ---------------------------------------------------------------------------
// Layer 2 — live registry (.orchestrator/workspace/api-models.json)
// What an API list endpoint can give us. Smaller surface than seed.
// ---------------------------------------------------------------------------

export const LiveModelEntrySchema = z.object({
    name: z.string().min(1),
    /** Inferred from API response (e.g. supportedGenerationMethods + name pattern). */
    kinds: z.array(ModelKindSchema).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    knowledgeCutoff: z.string().min(1).optional(),
    /** True if the model exposes any thinking / extended-reasoning mode */
    thinkingSupported: z.boolean().optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    features: z.array(ModelFeatureSchema).optional(),
    /** Raw description from the API — useful as context for the research agent */
    rawDescription: z.string().optional(),
    customMetadata: z.array(ModelCustomMetadataSchema).optional(),
    /** Free-form bag for provider-specific data we don't model yet */
    raw: z.record(z.string(), z.unknown()).optional(),
})
export type LiveModelEntry = z.infer<typeof LiveModelEntrySchema>

export const LiveProviderEntrySchema = z.object({
    fetchedAt: z.number().int().nonnegative(),
    models: z.record(z.string(), LiveModelEntrySchema),
})
export type LiveProviderEntry = z.infer<typeof LiveProviderEntrySchema>

export const LiveRegistrySchema = z.object({
    version: z.literal(1),
    providers: z.record(z.string(), LiveProviderEntrySchema),
})
export type LiveRegistry = z.infer<typeof LiveRegistrySchema>

export const EMPTY_LIVE_REGISTRY: LiveRegistry = { version: 1, providers: {} }

// ---------------------------------------------------------------------------
// Layer 3 — model overrides (.orchestrator/workspace/model-overrides.json)
// User-set or AI-research-set values that win over live and seed.
// ---------------------------------------------------------------------------

export const CuratedModelEntrySchema = z.object({
    pricing: PricingFieldSchema.optional(),
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
    /** Set by the AI research flow — surfaces "Re-research" UX after staleness */
    lastResearchedAt: z.number().int().nonnegative().optional(),
})
export type CuratedModelEntry = z.infer<typeof CuratedModelEntrySchema>

export const CuratedRegistrySchema = z.object({
    version: z.literal(1),
    /** Keyed by "providerId:modelId" — flat for easier patching from the UI */
    models: z.record(z.string(), CuratedModelEntrySchema),
})
export type CuratedRegistry = z.infer<typeof CuratedRegistrySchema>

export const EMPTY_CURATED_REGISTRY: CuratedRegistry = { version: 1, models: {} }

// Compose key from (providerId, modelId) — single canonical format.
export function curatedKey(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`
}

export function parseCuratedKey(key: string): { providerId: string; modelId: string } | null {
    const idx = key.indexOf(':')
    if (idx <= 0 || idx === key.length - 1) return null
    return { providerId: key.slice(0, idx), modelId: key.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// Effective registry — the merged result returned to consumers (UI, chat).
// Computed in lib/models/registry.ts; not persisted.
// ---------------------------------------------------------------------------

export type DataCompleteness = 'complete' | 'incomplete' | 'archived'
export type ModelSource = 'built-in' | 'live' | 'curated'

export interface EffectiveModelEntry {
    /** Display name — curated displayNameOverride > seed.name > live.name */
    name: string
    /** Generation kinds. Defaults to `['text']` when seed/live/curated all omit it. */
    kinds: ModelKind[]
    contextWindow: number
    maxOutputTokens: number
    knowledgeCutoff?: string
    pricing: ModelPricing | null
    pricingNotes?: string
    capabilities: Capability[]
    features: ModelFeature[]
    thinkingLevels?: ThinkingLevel[]
    defaultThinkingLevel?: ThinkingLevel
    intelligenceTier?: IntelligenceTier
    archived: boolean
    notes?: string
    researchSources?: ResearchSource[]
    customMetadata: ModelCustomMetadata[]
    /** Computed — `incomplete` flags the model for research; `archived` hides by default. */
    dataCompleteness: DataCompleteness
    missingFields: ModelDataField[]
    /** Which layers contributed — informational, useful for debugging */
    sources: ModelSource[]
    liveFetchedAt?: number
    curatedResearchedAt?: number
}

export interface EffectiveProviderEntry {
    name: string
    apiKeyEnv: string
    models: Record<string, EffectiveModelEntry>
}

export type EffectiveRegistry = Record<string, EffectiveProviderEntry>
