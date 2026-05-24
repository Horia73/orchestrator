import { z } from 'zod'

import {
    CapabilitySchema,
    IntelligenceTierSchema,
    ModelCustomMetadataSchema,
    ModelDataFieldSchema,
    ModelFeatureSchema,
    ModelKindSchema,
    ModelPricingSchema,
    ResearchSourceSchema,
    ThinkingLevelSchema,
    type CuratedModelEntry,
    type EffectiveModelEntry,
    type ModelDataField,
} from '@/lib/models/schema'

export const ResearchFieldsSchema = z.object({
    pricing: ModelPricingSchema.nullable().optional(),
    pricingNotes: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    knowledgeCutoff: z.string().min(1).optional(),
    thinkingLevels: z.array(ThinkingLevelSchema).optional(),
    defaultThinkingLevel: ThinkingLevelSchema.optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    features: z.array(ModelFeatureSchema).optional(),
    customMetadata: z.array(ModelCustomMetadataSchema).optional(),
    intelligenceTier: IntelligenceTierSchema.optional(),
    kinds: z.array(ModelKindSchema).optional(),
    notes: z.string().optional(),
})

export const UnresolvedFieldSchema = z.object({
    field: ModelDataFieldSchema,
    reason: z.string().optional(),
})

export const ResearchResultSchema = z.object({
    status: z.enum(['found', 'insufficient']),
    summary: z.string().optional(),
    fields: ResearchFieldsSchema.optional(),
    sources: z.array(ResearchSourceSchema).optional(),
    unresolved: z.array(UnresolvedFieldSchema).optional(),
})

// Per-model entry inside a batched per-provider response. Mirrors the
// single-model schema but adds the providerId/modelId echo so the dispatcher
// can route patches to the right row.
export const PerModelResearchResultSchema = z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    status: z.enum(['found', 'insufficient']),
    summary: z.string().optional(),
    fields: ResearchFieldsSchema.optional(),
    sources: z.array(ResearchSourceSchema).optional(),
    unresolved: z.array(UnresolvedFieldSchema).optional(),
})

export const ProviderResearchResultSchema = z.object({
    status: z.enum(['found', 'partial', 'insufficient']),
    summary: z.string().optional(),
    perModel: z.array(PerModelResearchResultSchema),
    sources: z.array(ResearchSourceSchema).optional(),
})

export type ResearchFields = z.infer<typeof ResearchFieldsSchema>
export type UnresolvedField = z.infer<typeof UnresolvedFieldSchema>
export type PerModelResearchResult = z.infer<typeof PerModelResearchResultSchema>

export function readResearchOutput(data: unknown): string {
    if (!data || typeof data !== 'object') return ''
    const output = (data as { output?: unknown }).output
    return typeof output === 'string' ? output : ''
}

export function parseJsonFromText(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (!fenced && (start < 0 || end <= start)) {
        throw new Error('Researcher returned no JSON object')
    }
    const candidate = fenced?.[1] ?? text.slice(start, end + 1)
    return JSON.parse(candidate)
}

export function changedFieldNames(
    before: EffectiveModelEntry,
    after: EffectiveModelEntry,
    fields: ResearchFields
): string[] {
    const labels: Record<string, string> = {
        pricing: 'pricing',
        pricingNotes: 'pricing notes',
        contextWindow: 'context window',
        maxOutputTokens: 'max output',
        knowledgeCutoff: 'knowledge cutoff',
        thinkingLevels: 'thinking levels',
        defaultThinkingLevel: 'default thinking',
        capabilities: 'capabilities',
        features: 'features',
        customMetadata: 'custom metadata',
        intelligenceTier: 'intelligence tier',
        kinds: 'model kinds',
        notes: 'notes',
    }
    const out: string[] = []
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        if (fields[key] === undefined) continue
        if (JSON.stringify(before[key as keyof EffectiveModelEntry] ?? null) !== JSON.stringify(after[key as keyof EffectiveModelEntry] ?? null)) {
            out.push(labels[String(key)] ?? String(key))
        }
    }
    return out
}

export function buildResultSummary(args: {
    summary?: string
    changedFields: string[]
    beforeMissing: ModelDataField[]
    remainingMissing: ModelDataField[]
    unresolved?: UnresolvedField[]
}): string {
    const parts: string[] = []
    if (args.summary) parts.push(args.summary)
    if (args.changedFields.length > 0) parts.push(`Updated ${args.changedFields.join(', ')}`)
    if (args.remainingMissing.length > 0) {
        const remaining = args.remainingMissing.map(formatMissingField).join(', ')
        const before = args.beforeMissing.length > 0 ? ` from ${args.beforeMissing.map(formatMissingField).join(', ')}` : ''
        parts.push(`Still missing ${remaining}${before ? ` (started${before})` : ''}`)
    }
    if (args.unresolved?.length) {
        const unresolved = args.unresolved
            .slice(0, 3)
            .map(item => item.reason ? `${formatMissingField(item.field)}: ${item.reason}` : formatMissingField(item.field))
            .join('; ')
        parts.push(`Unresolved: ${unresolved}`)
    }
    return parts.join(' · ') || 'No supported metadata changes found.'
}

const NON_SELECTABLE_THINKING_LEVELS = new Set(['off', 'auto', 'enabled', 'disabled', 'reasoning', 'thinking'])

export function normalizeResearchFields(fields: ResearchFields, providerId: string): ResearchFields {
    const out: ResearchFields = { ...fields }
    const nonSelectable = new Set(NON_SELECTABLE_THINKING_LEVELS)
    if (providerId !== 'openai' && providerId !== 'codex') nonSelectable.add('none')
    if (out.thinkingLevels !== undefined) {
        const wasExplicitlyEmpty = out.thinkingLevels.length === 0
        const seen = new Set<string>()
        const levels = out.thinkingLevels.filter(level => {
            const normalized = stableToken(level)
            if (!normalized || nonSelectable.has(normalized) || seen.has(normalized)) return false
            seen.add(normalized)
            return true
        })
        if (levels.length > 0) out.thinkingLevels = levels
        else if (wasExplicitlyEmpty) out.thinkingLevels = []
        else delete out.thinkingLevels
    }

    if (out.defaultThinkingLevel) {
        const normalized = stableToken(out.defaultThinkingLevel)
        const allowed = out.thinkingLevels?.includes(out.defaultThinkingLevel)
        if (!normalized || nonSelectable.has(normalized)) {
            delete out.defaultThinkingLevel
        } else if (out.thinkingLevels && !allowed) {
            if (out.thinkingLevels.length > 0) out.defaultThinkingLevel = out.thinkingLevels[0]
            else delete out.defaultThinkingLevel
        }
    }

    return out
}

function stableToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatMissingField(field: ModelDataField): string {
    if (field === 'contextWindow') return 'context window'
    if (field === 'maxOutputTokens') return 'max output'
    if (field === 'knowledgeCutoff') return 'knowledge cutoff'
    if (field === 'thinkingLevels') return 'thinking levels'
    if (field === 'defaultThinkingLevel') return 'default thinking'
    return field
}

export function stripUndefined(value: CuratedModelEntry): CuratedModelEntry {
    const out: CuratedModelEntry = {}
    for (const [key, entryValue] of Object.entries(value) as Array<[keyof CuratedModelEntry, CuratedModelEntry[keyof CuratedModelEntry]]>) {
        if (entryValue !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(out as any)[key] = entryValue
        }
    }
    return out
}
