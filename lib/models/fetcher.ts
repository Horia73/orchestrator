import { z } from 'zod'

import {
    type LiveProviderEntry,
    type LiveModelEntry,
    type Capability,
    type ModelFeature,
    type ModelKind,
    type ModelPricing,
} from './schema'
import {
    LM_STUDIO_DEFAULT_CONTEXT_TOKENS,
    lmStudioJsonHeaders,
    lmStudioNativeModelsUrl,
    normalizeLMStudioBaseUrl,
} from '@/lib/lm-studio'

// ---------------------------------------------------------------------------
// Fetchers — call provider listModels endpoints, normalize into the LiveRegistry
// shape, and return them so the caller can merge + persist. Each provider has
// its own response shape so we keep the mappers explicit per provider.
// ---------------------------------------------------------------------------

/**
 * Generic shape used after Zod parses Google's listModels response.
 *
 * `supportedGenerationMethods` is the strongest classification signal — it
 * tells us whether a model accepts `generateContent` (text/multimodal),
 * `predict` (Imagen), `predictLongRunning` (Veo), `embedContent` (embeddings),
 * etc. We combine that with the resource name to disambiguate text-vs-image
 * for `generateContent` models like Nano Banana.
 */
const GoogleApiModelSchema = z.object({
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    inputTokenLimit: z.number().int().nonnegative().optional(),
    outputTokenLimit: z.number().int().nonnegative().optional(),
    supportedGenerationMethods: z.array(z.string()).optional(),
})
type GoogleApiModel = z.infer<typeof GoogleApiModelSchema>

const GoogleApiListSchema = z.object({
    models: z.array(GoogleApiModelSchema),
    nextPageToken: z.string().optional(),
})

const OpenRouterPricingSchema = z.record(z.string(), z.string().optional()).optional()

const OpenRouterModelSchema = z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().int().nonnegative().optional(),
    pricing: OpenRouterPricingSchema,
    architecture: z.object({
        modality: z.string().optional(),
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
        tokenizer: z.string().nullable().optional(),
        instruct_type: z.string().nullable().optional(),
    }).optional(),
    top_provider: z.object({
        max_completion_tokens: z.number().int().nonnegative().nullable().optional(),
        is_moderated: z.boolean().optional(),
    }).optional(),
    supported_parameters: z.array(z.string()).optional(),
})
type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>

const OpenRouterListSchema = z.object({
    data: z.array(OpenRouterModelSchema),
})

const LMStudioReasoningSchema = z.object({
    allowed_options: z.array(z.enum(['off', 'on', 'low', 'medium', 'high'])).optional(),
    default: z.enum(['off', 'on', 'low', 'medium', 'high']).optional(),
}).passthrough()

const LMStudioLoadedInstanceSchema = z.object({
    id: z.string(),
    config: z.object({
        context_length: z.number().int().positive().optional(),
        eval_batch_size: z.number().int().positive().optional(),
        parallel: z.number().int().positive().optional(),
        flash_attention: z.boolean().optional(),
        num_experts: z.number().int().positive().optional(),
        offload_kv_cache_to_gpu: z.boolean().optional(),
    }).passthrough().optional(),
}).passthrough()

const LMStudioQuantizationSchema = z.union([
    z.string(),
    z.object({
        name: z.string().nullable().optional(),
        bits_per_weight: z.number().nullable().optional(),
    }).passthrough(),
]).nullable().optional()

const LMStudioModelSchema = z.object({
    id: z.string().optional(),
    key: z.string().optional(),
    display_name: z.string().optional(),
    type: z.string().optional(),
    publisher: z.string().nullable().optional(),
    architecture: z.string().nullable().optional(),
    compatibility_type: z.string().nullable().optional(),
    quantization: LMStudioQuantizationSchema,
    state: z.string().nullable().optional(),
    max_context_length: z.number().int().nonnegative().nullable().optional(),
    loaded_context_length: z.number().int().nonnegative().nullable().optional(),
    loaded_instances: z.array(LMStudioLoadedInstanceSchema).optional(),
    size_bytes: z.number().int().nonnegative().nullable().optional(),
    params_string: z.string().nullable().optional(),
    format: z.string().nullable().optional(),
    capabilities: z.object({
        vision: z.boolean().optional(),
        trained_for_tool_use: z.boolean().optional(),
        reasoning: LMStudioReasoningSchema.optional(),
    }).passthrough().optional(),
    description: z.string().nullable().optional(),
    variants: z.array(z.string()).optional(),
    selected_variant: z.string().optional(),
}).passthrough()
type LMStudioModel = z.infer<typeof LMStudioModelSchema>

const LMStudioNativeListSchema = z.union([
    z.object({ models: z.array(LMStudioModelSchema) }),
    z.object({ data: z.array(LMStudioModelSchema) }),
])

const LMStudioOpenAIModelSchema = z.object({
    id: z.string(),
})

const LMStudioOpenAIListSchema = z.object({
    data: z.array(LMStudioOpenAIModelSchema),
})

/**
 * Heuristics for classifying a Google model into our `kinds` taxonomy.
 *
 *   - Methods first (most reliable, comes from the API itself)
 *   - Name pattern second (e.g. `tts`, `image`, `imagen`, `veo`)
 *   - Default to text for everything else
 *
 * Never returns null — every model the API returns surfaces in the picker.
 * The user archives what they don't want; this code doesn't second-guess.
 */
function classifyGoogleModel(m: GoogleApiModel): ModelKind[] {
    const id = m.name.replace(/^models\//, '').toLowerCase()
    const methods = new Set(m.supportedGenerationMethods ?? [])

    // Embeddings — the embedContent method (or an *embedding* name) is the
    // signal. Tagged as their own kind so they stay OUT of the chat/agent model
    // pickers (which require kind/capability 'text') and surface only in the
    // dedicated embedding picker (Settings → Memory).
    if (methods.has('embedContent') || id.includes('embedding')) return ['embedding']

    // Video — long-running predict with veo prefix.
    if (methods.has('predictLongRunning') || id.startsWith('veo-')) return ['video']

    // Image — Imagen uses `predict`; Nano Banana / *-image-* uses generateContent.
    if (methods.has('predict') && id.startsWith('imagen-')) return ['image']
    if (id.includes('-image') || id.includes('image-preview') || id.includes('nano-banana')) return ['image']

    // Speech — TTS variants use generateContent but advertise -tts in the name.
    if (id.includes('-tts') || id.includes('tts-preview')) return ['speech']

    // Music — Lyria variants use generateContent and return audio.
    if (id.includes('lyria')) return ['music']

    // Live audio bidi.
    if (methods.has('bidiGenerateContent') && id.includes('audio')) return ['speech']

    // Default: text. Covers gemini-*, gemma-*, deep-research-*, embeddings,
    // aqa, robotics, computer-use. These won't all work as chat models but
    // they're visible so the user can choose what to keep.
    return ['text']
}

/**
 * Fetch the live model list from Google's Generative Language API.
 * Pages through results so we get every model the key has access to.
 */
export async function fetchGoogleModels(apiKey: string): Promise<LiveProviderEntry> {
    const base = 'https://generativelanguage.googleapis.com/v1beta/models'
    const models: Record<string, LiveModelEntry> = {}

    let pageToken: string | undefined
    let safety = 0
    while (safety++ < 10) {
        const url = new URL(base)
        url.searchParams.set('key', apiKey)
        url.searchParams.set('pageSize', '100')
        if (pageToken) url.searchParams.set('pageToken', pageToken)

        const res = await fetch(url.toString())
        if (!res.ok) {
            throw new Error(`Google listModels failed (${res.status}): ${await res.text().catch(() => '')}`)
        }
        const json = await res.json()
        const parsed = GoogleApiListSchema.safeParse(json)
        if (!parsed.success) {
            throw new Error(`Google listModels response failed validation: ${parsed.error.message}`)
        }

        for (const m of parsed.data.models) {
            const id = m.name.replace(/^models\//, '')
            const kinds = classifyGoogleModel(m)

            models[id] = {
                name: m.displayName ?? id,
                kinds,
                contextWindow: m.inputTokenLimit && m.inputTokenLimit > 0 ? m.inputTokenLimit : undefined,
                maxOutputTokens: m.outputTokenLimit && m.outputTokenLimit > 0 ? m.outputTokenLimit : undefined,
                rawDescription: m.description,
                raw: { supportedGenerationMethods: m.supportedGenerationMethods ?? [] },
            }
        }

        if (!parsed.data.nextPageToken) break
        pageToken = parsed.data.nextPageToken
    }

    return {
        fetchedAt: Date.now(),
        models,
    }
}

export async function fetchOpenRouterModels(apiKey: string): Promise<LiveProviderEntry> {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    })
    if (!res.ok) {
        throw new Error(`OpenRouter listModels failed (${res.status}): ${await res.text().catch(() => '')}`)
    }
    const json = await res.json()
    const parsed = OpenRouterListSchema.safeParse(json)
    if (!parsed.success) {
        throw new Error(`OpenRouter listModels response failed validation: ${parsed.error.message}`)
    }

    const models: Record<string, LiveModelEntry> = {}
    for (const m of parsed.data.data) {
        if (!openRouterOutputsText(m)) continue
        const pricing = openRouterTokenPricing(m.pricing)
        const supported = new Set(m.supported_parameters ?? [])
        const capabilities = ['text']
        if (supported.has('tools') || supported.has('tool_choice')) capabilities.push('function_calling')
        if (supported.has('structured_outputs') || supported.has('response_format')) capabilities.push('structured_outputs')
        if (supported.has('reasoning') || supported.has('include_reasoning')) capabilities.push('thinking')
        const thinkingSupported = supported.has('reasoning') || supported.has('include_reasoning')

        models[m.id] = {
            name: m.name ?? m.id,
            kinds: ['text'],
            contextWindow: positiveInt(m.context_length),
            maxOutputTokens: positiveInt(m.top_provider?.max_completion_tokens ?? undefined),
            pricing,
            pricingNotes: pricing
                ? 'From OpenRouter /api/v1/models; per-token USD converted to per-million token USD.'
                : undefined,
            capabilities,
            thinkingSupported,
            thinkingLevels: thinkingSupported ? ['low', 'medium', 'high'] : ['none'],
            defaultThinkingLevel: thinkingSupported ? 'medium' : 'none',
            rawDescription: m.description,
            raw: {
                architecture: m.architecture ?? null,
                supported_parameters: m.supported_parameters ?? [],
                top_provider: m.top_provider ?? null,
            },
        }
    }

    return {
        fetchedAt: Date.now(),
        models,
    }
}

export async function fetchLMStudioModels(baseUrl: string, apiKey?: string | null): Promise<LiveProviderEntry> {
    const parsed = await fetchLMStudioNativeList(baseUrl, apiKey)
        .catch(async (nativeErr) => {
            try {
                return await fetchLMStudioOpenAIList(baseUrl, apiKey)
            } catch (openAiErr) {
                const nativeMessage = nativeErr instanceof Error ? nativeErr.message : String(nativeErr)
                const openAiMessage = openAiErr instanceof Error ? openAiErr.message : String(openAiErr)
                throw new Error(`LM Studio listModels failed. Native API: ${nativeMessage}; OpenAI API: ${openAiMessage}`)
            }
        })

    const models: Record<string, LiveModelEntry> = {}
    for (const m of parsed) {
        if (!lmStudioCanChat(m)) continue
        const id = lmStudioModelId(m)
        if (!id) continue
        const loadedContext = lmStudioLoadedContextLength(m)
        const contextWindow = positiveInt(m.max_context_length ?? loadedContext ?? m.loaded_context_length ?? undefined)
        const reasoningLevels = lmStudioReasoningLevels(m)
        const capabilities = lmStudioCapabilities(m)
        const customMetadata = [
            metadata('state', 'State', m.state),
            metadata('publisher', 'Publisher', m.publisher),
            metadata('architecture', 'Architecture', m.architecture),
            metadata('quantization', 'Quantization', lmStudioQuantizationLabel(m.quantization)),
            metadata('params', 'Parameters', m.params_string),
            metadata('format', 'Format', m.format),
            metadata('size_bytes', 'Size', formatBytes(m.size_bytes)),
            metadata('loaded_instances', 'Loaded instances', m.loaded_instances?.length),
            metadata('loaded_context', 'Loaded context', loadedContext, 'tokens'),
            metadata('tool_trained', 'Tool-trained', booleanLabel(m.capabilities?.trained_for_tool_use)),
            metadata('vision', 'Vision', booleanLabel(m.capabilities?.vision)),
            metadata('reasoning_default', 'Reasoning default', m.capabilities?.reasoning?.default),
            metadata('selected_variant', 'Selected variant', m.selected_variant),
        ].filter((item): item is NonNullable<typeof item> => item !== null)

        models[id] = {
            name: m.display_name ?? lmStudioDisplayName(id),
            kinds: ['text'],
            contextWindow,
            pricing: {
                kind: 'tokens',
                inputPerMillion: 0,
                outputPerMillion: 0,
            },
            pricingNotes: 'Local LM Studio runtime; provider billing is $0. Hardware/electricity costs are not tracked.',
            capabilities,
            thinkingSupported: reasoningLevels.some(level => level !== 'none'),
            thinkingLevels: reasoningLevels,
            defaultThinkingLevel: lmStudioDefaultReasoningLevel(m, reasoningLevels),
            features: lmStudioFeatures(contextWindow, loadedContext),
            rawDescription: lmStudioDescription(m),
            customMetadata,
            raw: {
                key: m.key ?? null,
                display_name: m.display_name ?? null,
                type: m.type ?? null,
                publisher: m.publisher ?? null,
                architecture: m.architecture ?? null,
                compatibility_type: m.compatibility_type ?? null,
                quantization: m.quantization ?? null,
                state: m.state ?? null,
                max_context_length: m.max_context_length ?? null,
                loaded_context_length: m.loaded_context_length ?? null,
                loaded_instances: m.loaded_instances ?? [],
                capabilities: m.capabilities ?? null,
                size_bytes: m.size_bytes ?? null,
                params_string: m.params_string ?? null,
                format: m.format ?? null,
                selected_variant: m.selected_variant ?? null,
                variants: m.variants ?? [],
            },
        }
    }

    return {
        fetchedAt: Date.now(),
        models,
    }
}

async function fetchLMStudioNativeList(baseUrl: string, apiKey?: string | null): Promise<LMStudioModel[]> {
    const res = await fetch(lmStudioNativeModelsUrl(baseUrl), {
        headers: lmStudioJsonHeaders(apiKey),
    })
    if (!res.ok) {
        throw new Error(`native /api/v1/models failed (${res.status}): ${await res.text().catch(() => '')}`)
    }
    const json = await res.json()
    const parsed = LMStudioNativeListSchema.safeParse(json)
    if (!parsed.success) {
        throw new Error(`native /api/v1/models response failed validation: ${parsed.error.message}`)
    }
    return 'models' in parsed.data ? parsed.data.models : parsed.data.data
}

async function fetchLMStudioOpenAIList(baseUrl: string, apiKey?: string | null): Promise<LMStudioModel[]> {
    const res = await fetch(`${normalizeLMStudioBaseUrl(baseUrl)}/models`, {
        headers: lmStudioJsonHeaders(apiKey),
    })
    if (!res.ok) {
        throw new Error(`OpenAI /v1/models failed (${res.status}): ${await res.text().catch(() => '')}`)
    }
    const json = await res.json()
    const parsed = LMStudioOpenAIListSchema.safeParse(json)
    if (!parsed.success) {
        throw new Error(`OpenAI /v1/models response failed validation: ${parsed.error.message}`)
    }
    return parsed.data.data.map(m => ({ id: m.id }))
}

function lmStudioCanChat(m: LMStudioModel): boolean {
    const type = m.type?.toLowerCase()
    if (!type) return true
    return type === 'llm' || type === 'model' || type === 'chat'
}

function lmStudioModelId(m: LMStudioModel): string | null {
    return nonEmptyString(m.key) ?? nonEmptyString(m.id) ?? nonEmptyString(m.selected_variant)
}

function lmStudioLoadedContextLength(m: LMStudioModel): number | undefined {
    const fromInstances = m.loaded_instances
        ?.map(instance => positiveInt(instance.config?.context_length))
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => b - a)[0]
    return fromInstances ?? positiveInt(m.loaded_context_length ?? undefined)
}

function lmStudioReasoningLevels(m: LMStudioModel): string[] {
    const allowed = m.capabilities?.reasoning?.allowed_options
    if (allowed && allowed.length > 0) return Array.from(new Set(allowed.map(level => level === 'off' ? 'none' : level)))
    const def = m.capabilities?.reasoning?.default
    if (def) return [def === 'off' ? 'none' : def]
    return ['none']
}

function lmStudioDefaultReasoningLevel(m: LMStudioModel, levels: string[]): string {
    const def = m.capabilities?.reasoning?.default
    const normalized = def === 'off' ? 'none' : def
    if (normalized && levels.includes(normalized)) return normalized
    return levels.includes('none') ? 'none' : levels[0] ?? 'none'
}

function lmStudioCapabilities(m: LMStudioModel): Capability[] {
    const capabilities: Capability[] = ['text', 'function_calling']
    if (m.capabilities?.vision) capabilities.push('image')
    if (m.capabilities?.reasoning) capabilities.push('thinking')
    return capabilities
}

function lmStudioFeatures(contextWindow: number | undefined, loadedContext: number | undefined): ModelFeature[] {
    const max = contextWindow && contextWindow > 0 ? contextWindow : undefined
    const defaultValue = max
        ? Math.min(LM_STUDIO_DEFAULT_CONTEXT_TOKENS, max)
        : LM_STUDIO_DEFAULT_CONTEXT_TOKENS
    if (!defaultValue || defaultValue <= 0) return []
    return [{
        id: 'lm_studio_context_length',
        label: 'Context length',
        description: 'Context tokens requested when Orchestrator auto-loads this LM Studio model.',
        category: 'LM Studio load',
        providerParam: 'context_length',
        type: 'number',
        min: 1024,
        ...(max ? { max } : {}),
        step: 1024,
        unit: 'tokens',
        defaultValue: loadedContext && max && loadedContext > max ? max : defaultValue,
    }]
}

function lmStudioDisplayName(id: string): string {
    const last = id.split('/').filter(Boolean).pop() ?? id
    return last
        .replace(/\.(gguf|bin|safetensors)$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || id
}

function lmStudioDescription(m: LMStudioModel): string {
    const parts = [
        m.description || 'Local LM Studio model.',
        m.state ? `State: ${m.state}.` : null,
        m.compatibility_type ? `Compatibility: ${m.compatibility_type}.` : null,
        m.selected_variant ? `Variant: ${m.selected_variant}.` : null,
    ].filter(Boolean)
    return parts.join(' ')
}

function metadata(id: string, label: string, value: string | number | boolean | null | undefined, unit?: string) {
    if (value === null || value === undefined || value === '') return null
    return {
        id,
        label,
        value,
        ...(unit ? { unit } : {}),
        category: 'LM Studio',
    }
}

function lmStudioQuantizationLabel(value: LMStudioModel['quantization']): string | null {
    if (!value) return null
    if (typeof value === 'string') return value
    const bits = typeof value.bits_per_weight === 'number' ? `${value.bits_per_weight}-bit` : null
    return [value.name, bits].filter(Boolean).join(' · ') || null
}

function booleanLabel(value: boolean | undefined): string | null {
    if (value === undefined) return null
    return value ? 'yes' : 'no'
}

function formatBytes(value: number | null | undefined): string | null {
    if (!value || value <= 0) return null
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let n = value
    let unit = 0
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024
        unit += 1
    }
    return `${n >= 10 || unit === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`
}

function nonEmptyString(value: string | null | undefined): string | null {
    return value && value.trim() ? value.trim() : null
}

function openRouterOutputsText(m: OpenRouterModel): boolean {
    const output = m.architecture?.output_modalities
    if (!output || output.length === 0) return true
    return output.some(modality => modality.toLowerCase() === 'text')
}

function openRouterTokenPricing(pricing: OpenRouterModel['pricing']): ModelPricing | null {
    if (!pricing) return null
    const prompt = pricePerMillion(pricing.prompt)
    const completion = pricePerMillion(pricing.completion)
    if (prompt === null || completion === null) return null
    const cachedInput = pricePerMillion(pricing.input_cache_read)
    return {
        kind: 'tokens',
        inputPerMillion: prompt,
        outputPerMillion: completion,
        ...(cachedInput !== null ? { cachedInputPerMillion: cachedInput } : {}),
    }
}

function pricePerMillion(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return null
    return value * 1_000_000
}

function positiveInt(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined
}
