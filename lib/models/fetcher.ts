import { z } from 'zod'

import {
    type LiveProviderEntry,
    type LiveModelEntry,
    type ModelKind,
} from './schema'

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
