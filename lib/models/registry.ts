import fs from 'fs'

import {
    type EffectiveRegistry,
    type EffectiveProviderEntry,
    type EffectiveModelEntry,
    type SeedRegistry,
    type SeedModelEntry,
    type LiveRegistry,
    type LiveModelEntry,
    type CuratedRegistry,
    type CuratedModelEntry,
    type ModelSource,
    type ModelPricing,
    type ModelKind,
    type Capability,
    type ModelFeature,
    type ThinkingLevel,
    type IntelligenceTier,
    type ResearchSource,
    type ModelCustomMetadata,
    type ModelDataField,
    curatedKey,
} from './schema'
import {
    getSeedRegistry,
    readLiveRegistry,
    readCuratedRegistry,
    writeCuratedRegistry,
    getStorePaths,
} from './store'

// ---------------------------------------------------------------------------
// Build the merged effective registry from all three layers.
//
// Merge rule per field:
//   curated wins > live wins > seed wins (where defined)
//
// Special cases:
//   - `pricing` field uses null for "explicitly unknown". `undefined` (absent)
//     means "no override at this layer" — keep walking down.
//   - A model present in `live` but not in `seed` is included (the registry
//     grows). A model present in `seed` but not in `live` stays (built-in seed
//     is never invalidated by a live fetch — refresh just adds new ones).
//   - A model present only in `curated` (no seed, no live) is dropped. Curated
//     overrides standalone don't define a model — they only patch existing ones.
// ---------------------------------------------------------------------------

export function buildEffectiveRegistry(
    seed: SeedRegistry,
    live: LiveRegistry,
    curated: CuratedRegistry
): EffectiveRegistry {
    const out: EffectiveRegistry = {}

    // Start from the union of all (providerId, modelId) pairs found in seed + live.
    // Curated alone doesn't introduce models.
    const providerIds = new Set<string>([
        ...Object.keys(seed.providers),
        ...Object.keys(live.providers),
    ])

    for (const providerId of providerIds) {
        const seedProvider = seed.providers[providerId]
        const liveProvider = live.providers[providerId]

        // Provider-level metadata comes from seed (apiKeyEnv, name). If a provider
        // exists only in live, we synthesize sensible defaults — but in practice
        // the seed should declare every provider we know how to call.
        const name = seedProvider?.name ?? humanize(providerId)
        const apiKeyEnv = seedProvider?.apiKeyEnv ?? `${providerId.toUpperCase()}_API_KEY`

        const modelIds = new Set<string>([
            ...(seedProvider ? Object.keys(seedProvider.models) : []),
            ...(liveProvider ? Object.keys(liveProvider.models) : []),
        ])

        const models: Record<string, EffectiveModelEntry> = {}
        for (const modelId of modelIds) {
            const seedModel = seedProvider?.models[modelId]
            const liveModel = liveProvider?.models[modelId]
            const curatedModel = curated.models[curatedKey(providerId, modelId)]

            const merged = mergeModel({ seedModel, liveModel, curatedModel, liveFetchedAt: liveProvider?.fetchedAt })
            if (merged) models[modelId] = merged
        }

        out[providerId] = { name, apiKeyEnv, models }
    }

    return out
}

// ---------------------------------------------------------------------------
// Per-model merge — single source of truth for precedence semantics.
// ---------------------------------------------------------------------------

function mergeModel(input: {
    seedModel?: SeedModelEntry
    liveModel?: LiveModelEntry
    curatedModel?: CuratedModelEntry
    liveFetchedAt?: number
}): EffectiveModelEntry | null {
    const { seedModel, liveModel, curatedModel, liveFetchedAt } = input

    if (!seedModel && !liveModel) return null

    const sources: ModelSource[] = []
    if (seedModel) sources.push('built-in')
    if (liveModel) sources.push('live')
    if (curatedModel) sources.push('curated')

    // ----- name (display) -----
    const name =
        curatedModel?.displayNameOverride ??
        seedModel?.name ??
        liveModel?.name ??
        '(unnamed model)'

    // ----- kinds -----
    // Curated > seed > live > default. Live `kinds` come from the fetcher's
    // classification (supportedGenerationMethods + name pattern); seed wins
    // when set so handcrafted overrides aren't undone by a refresh.
    const kinds: ModelKind[] =
        curatedModel?.kinds ??
        seedModel?.kinds ??
        liveModel?.kinds ??
        ['text']

    // ----- contextWindow / maxOutputTokens -----
    const contextWindow =
        curatedModel?.contextWindow ??
        seedModel?.contextWindow ??
        liveModel?.contextWindow ??
        0

    const maxOutputTokens =
        curatedModel?.maxOutputTokens ??
        seedModel?.maxOutputTokens ??
        liveModel?.maxOutputTokens ??
        0

    const knowledgeCutoff =
        curatedModel?.knowledgeCutoff ??
        seedModel?.knowledgeCutoff ??
        liveModel?.knowledgeCutoff

    // ----- pricing -----
    // Distinguish "unset" (undefined) from "explicitly unknown" (null).
    // Walk: curated -> seed (live doesn't carry pricing yet).
    let pricing: ModelPricing | null
    if (curatedModel && 'pricing' in curatedModel && curatedModel.pricing !== undefined) {
        pricing = curatedModel.pricing
    } else if (seedModel && seedModel.pricing !== undefined) {
        pricing = seedModel.pricing
    } else {
        pricing = null
    }

    // ----- capabilities -----
    const capabilities: Capability[] =
        curatedModel?.capabilities ??
        seedModel?.capabilities ??
        liveModel?.capabilities ??
        []

    // ----- adaptive features -----
    const features: ModelFeature[] =
        curatedModel?.features ??
        seedModel?.features ??
        liveModel?.features ??
        []

    // ----- thinking -----
    const thinkingLevels: ThinkingLevel[] | undefined =
        curatedModel?.thinkingLevels ??
        seedModel?.thinkingLevels ??
        // live carries only a boolean — without explicit levels we defer to user research
        undefined

    const defaultThinkingLevel: ThinkingLevel | undefined =
        curatedModel?.defaultThinkingLevel ??
        seedModel?.defaultThinkingLevel ??
        (thinkingLevels && thinkingLevels.length ? thinkingLevels[thinkingLevels.length - 1] : undefined)

    // ----- intelligenceTier -----
    const intelligenceTier: IntelligenceTier | undefined =
        curatedModel?.intelligenceTier ?? seedModel?.intelligenceTier

    // ----- archived -----
    const archived = curatedModel?.archived ?? false

    // ----- notes -----
    const notes = curatedModel?.notes ?? seedModel?.notes ?? liveModel?.rawDescription
    const pricingNotes = curatedModel?.pricingNotes ?? seedModel?.pricingNotes
    const researchSources: ResearchSource[] | undefined = curatedModel?.researchSources ?? seedModel?.researchSources
    const customMetadata: ModelCustomMetadata[] =
        curatedModel?.customMetadata ??
        seedModel?.customMetadata ??
        liveModel?.customMetadata ??
        []

    // Only text models have a tracked context window. A pure media model
    // (image/video/speech/music) has no text-context concept — even one with
    // `google_search` grounding (e.g. Nano Banana) or an incidental `text`
    // capability. Forcing the field on them left image models like gpt-image-2
    // permanently flagged "missing context size" with nothing to research.
    const isPureMedia = kinds.length > 0 && kinds.every(k => k !== 'text')
    const needsContextWindow = !isPureMedia
        && (kinds.includes('text') || capabilities.includes('text'))
    const needsThinkingMetadata = !isPureMedia
        && (kinds.includes('text') || capabilities.includes('text') || liveModel?.thinkingSupported === true || seedModel?.thinkingLevels !== undefined || thinkingLevels !== undefined)

    const missingFields: ModelDataField[] = []
    if (pricing === null) missingFields.push('pricing')
    if (needsContextWindow && !contextWindow) missingFields.push('contextWindow')
    if (needsThinkingMetadata && thinkingLevels === undefined) missingFields.push('thinkingLevels')

    const dataCompleteness: EffectiveModelEntry['dataCompleteness'] = archived
        ? 'archived'
        : missingFields.length > 0
            ? 'incomplete'
            : 'complete'

    return {
        name,
        kinds,
        contextWindow,
        maxOutputTokens,
        knowledgeCutoff,
        pricing,
        pricingNotes,
        capabilities,
        features,
        thinkingLevels,
        defaultThinkingLevel,
        intelligenceTier,
        archived,
        notes,
        researchSources,
        customMetadata,
        dataCompleteness,
        missingFields,
        sources,
        liveFetchedAt,
        curatedResearchedAt: curatedModel?.lastResearchedAt,
    }
}

function humanize(id: string): string {
    return id.charAt(0).toUpperCase() + id.slice(1)
}

// ---------------------------------------------------------------------------
// Cached top-level accessor.
// Cache lives in module memory; invalidated on any curated/live mutation.
// ---------------------------------------------------------------------------

let _registryCache: EffectiveRegistry | null = null
let _registryCacheSignature: string | null = null

export function getEffectiveRegistry(): EffectiveRegistry {
    const signature = registryInputSignature()
    if (_registryCache && _registryCacheSignature === signature) return _registryCache
    _registryCache = buildEffectiveRegistry(
        getSeedRegistry(),
        readLiveRegistry(),
        readCuratedRegistry()
    )
    _registryCacheSignature = registryInputSignature()
    return _registryCache
}

export function invalidateRegistryCache() {
    _registryCache = null
    _registryCacheSignature = null
}

function registryInputSignature(): string {
    const paths = getStorePaths()
    return [
        fileSignature(paths.liveRegistry),
        fileSignature(paths.curatedRegistry),
    ].join('|')
}

function fileSignature(filePath: string): string {
    try {
        const stat = fs.statSync(filePath)
        return `${stat.mtimeMs}:${stat.size}`
    } catch {
        return 'missing'
    }
}

// ---------------------------------------------------------------------------
// Curated patch helper — single entry point for "I want to change X about
// model Y". Validates, persists, and invalidates the cache.
// ---------------------------------------------------------------------------

export function patchCuratedModel(
    providerId: string,
    modelId: string,
    patch: CuratedModelEntry
): EffectiveRegistry {
    const current = readCuratedRegistry()
    const key = curatedKey(providerId, modelId)
    const existing = current.models[key] ?? {}

    // Shallow merge — caller passes only the fields they want to change.
    // To delete a field, pass it explicitly as undefined; we strip undefineds.
    const next: CuratedModelEntry = {}
    for (const k of Object.keys({ ...existing, ...patch }) as (keyof CuratedModelEntry)[]) {
        const value = k in patch ? patch[k] : existing[k]
        if (value !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(next as any)[k] = value
        }
    }

    const updatedRegistry: CuratedRegistry = {
        ...current,
        models: { ...current.models, [key]: next },
    }
    writeCuratedRegistry(updatedRegistry)
    invalidateRegistryCache()
    return getEffectiveRegistry()
}

/** Remove all curated overrides for a model — falls back to seed/live. */
export function clearCuratedModel(providerId: string, modelId: string): EffectiveRegistry {
    const current = readCuratedRegistry()
    const key = curatedKey(providerId, modelId)
    if (!(key in current.models)) return getEffectiveRegistry()

    const nextModels = { ...current.models }
    delete nextModels[key]
    writeCuratedRegistry({ ...current, models: nextModels })
    invalidateRegistryCache()
    return getEffectiveRegistry()
}

// ---------------------------------------------------------------------------
// Completeness helper — surfaces models that need research.
// Excludes archived models (those are intentionally hidden).
// ---------------------------------------------------------------------------

export interface IncompleteModel {
    providerId: string
    modelId: string
    name: string
    missing: ModelDataField[]
}

export function getIncompleteModels(registry: EffectiveRegistry = getEffectiveRegistry()): IncompleteModel[] {
    const out: IncompleteModel[] = []
    for (const [providerId, providerEntry] of Object.entries(registry)) {
        for (const [modelId, model] of Object.entries(providerEntry.models)) {
            if (model.archived) continue
            if (model.dataCompleteness !== 'incomplete') continue

            out.push({ providerId, modelId, name: model.name, missing: model.missingFields })
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Convenience lookups
// ---------------------------------------------------------------------------

export function getEffectiveProvider(providerId: string): EffectiveProviderEntry | null {
    return getEffectiveRegistry()[providerId] ?? null
}

export function getEffectiveModel(providerId: string, modelId: string): EffectiveModelEntry | null {
    return getEffectiveRegistry()[providerId]?.models[modelId] ?? null
}

export function effectiveModelExists(providerId: string, modelId: string): boolean {
    return Boolean(getEffectiveRegistry()[providerId]?.models[modelId])
}
