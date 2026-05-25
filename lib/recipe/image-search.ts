/**
 * Recipe image search backed by Wikimedia Commons.
 *
 * Wikimedia is the pragmatic default here:
 *   - Free, no API key, no opt-in flow before the user can see a card with
 *     photos. Other options (Google Custom Search Images, Bing, Tavily,
 *     Brave) all require credential setup the user hasn't done.
 *   - Every image carries clear attribution and a CC-family license, so
 *     surfacing the photographer's name + a click-through to the file page
 *     keeps us inside the license terms.
 *   - Curated, NSFW-moderated, and rich in food photography — exactly the
 *     content we need for the recipe card.
 *
 * If a deployment later wants to layer Google Image Search on top (richer
 * results for niche dishes), keep the {@link RecipeImageResult} shape stable
 * and add a provider chain — the renderer doesn't need to know which
 * backend served the photo.
 */

export interface RecipeImageResult {
    /** Direct thumbnail URL hosted at upload.wikimedia.org. ~800px wide. */
    url: string
    /** Click-through to the Commons file description page. */
    sourceUrl: string
    /** Photographer / source credit, HTML stripped, ≤120 chars. */
    attribution: string
    /** Thumbnail dimensions returned by Wikimedia. Used for aspect-ratio
     *  reservation to avoid CLS while images load. */
    width: number
    height: number
    /** MIME type — guaranteed to be jpeg/png/webp by the filter below. */
    mime: 'image/jpeg' | 'image/png' | 'image/webp'
}

interface CacheEntry {
    expiresAt: number
    value: RecipeImageResult[]
}

const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const CACHE_MAX_ENTRIES = 200
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

const ENDPOINT = 'https://commons.wikimedia.org/w/api.php'

/**
 * Search Wikimedia Commons for images matching `query`. Returns up to `limit`
 * results (default 4, capped at 8). LRU-cached for 24h per (query, limit).
 *
 * Throws on network failure or non-2xx upstream — callers should map to a
 * user-friendly state. The frontend treats failure as "no images" and just
 * hides the carousel rather than showing a noisy error inside a recipe card.
 */
export async function searchRecipeImages(
    rawQuery: string,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RecipeImageResult[]> {
    const query = rawQuery.trim()
    if (!query) return []
    const limit = Math.min(8, Math.max(1, Math.floor(options.limit ?? 4)))
    const cacheKey = `${query.toLowerCase()}::${limit}`

    // Cache hit: also touch (move to end) so eviction is true LRU.
    const cached = CACHE.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
        CACHE.delete(cacheKey)
        CACHE.set(cacheKey, cached)
        return cached.value
    }

    const url = new URL(ENDPOINT)
    // Search the File: namespace (6). `filemime` filter would be ideal but
    // isn't a `gsrsearch` keyword; we filter MIME in code after the fetch.
    // We over-fetch (limit × 3) to leave room after MIME filtering and after
    // dropping any entry that lacks a thumbnail.
    const searchParams = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: '6',
        gsrlimit: String(Math.min(30, limit * 4)),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata|mime',
        iiurlwidth: '800',
        origin: '*',
    })
    url.search = searchParams.toString()

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            // Wikimedia asks for a descriptive UA so they can route abuse
            // reports / debug. Include project name + a contact URL.
            'User-Agent': 'orchestrator-recipe/1.0 (+https://github.com/horia/orchestrator)',
            'Accept': 'application/json',
        },
        signal: options.signal,
    })

    if (!response.ok) {
        throw new Error(`Wikimedia API responded ${response.status}`)
    }

    const json = (await response.json()) as WikimediaResponse
    const results = parseWikimediaResponse(json, limit)

    writeCache(cacheKey, results)
    return results
}

// ---------------------------------------------------------------------------
// Wikimedia response shape (only the bits we actually read).
// ---------------------------------------------------------------------------

interface WikimediaImageInfo {
    thumburl?: string
    thumbwidth?: number
    thumbheight?: number
    url?: string
    width?: number
    height?: number
    descriptionurl?: string
    mime?: string
    extmetadata?: {
        Artist?: { value?: string }
        Credit?: { value?: string }
        LicenseShortName?: { value?: string }
        ImageDescription?: { value?: string }
    }
}

interface WikimediaPage {
    pageid?: number
    title?: string
    imageinfo?: WikimediaImageInfo[]
    index?: number
}

interface WikimediaResponse {
    query?: {
        pages?: Record<string, WikimediaPage>
    }
}

/**
 * Pure function so a smoke test can exercise the response → result mapping
 * without making a real HTTP call.
 */
export function parseWikimediaResponse(
    json: WikimediaResponse,
    limit: number,
): RecipeImageResult[] {
    const pages = json.query?.pages
    if (!pages) return []

    // Wikimedia returns pages as an object keyed by pageid. Preserve the
    // `index` field's order (search relevance) when iterating.
    const ordered = Object.values(pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

    const out: RecipeImageResult[] = []
    for (const page of ordered) {
        const info = page.imageinfo?.[0]
        if (!info) continue
        const mime = String(info.mime ?? '').toLowerCase()
        if (!ALLOWED_MIME.has(mime)) continue
        const url = info.thumburl || info.url
        const sourceUrl = info.descriptionurl
        if (!url || !sourceUrl) continue

        const attribution = pickAttribution(info.extmetadata)
        const width = info.thumbwidth ?? info.width ?? 0
        const height = info.thumbheight ?? info.height ?? 0

        out.push({
            url,
            sourceUrl,
            attribution,
            width,
            height,
            mime: mime as RecipeImageResult['mime'],
        })
        if (out.length >= limit) break
    }
    return out
}

/**
 * Wikimedia attribution lives in `extmetadata.Artist` as HTML (often an
 * `<a>` tag with the photographer's display name). Fall back to `Credit` if
 * `Artist` is absent, then "Wikimedia Commons" as a last resort. Strip HTML
 * and clamp length so noisy markup doesn't blow out the overlay.
 */
function pickAttribution(meta: WikimediaImageInfo['extmetadata']): string {
    const raw = meta?.Artist?.value ?? meta?.Credit?.value ?? 'Wikimedia Commons'
    return stripHtml(raw).slice(0, 120) || 'Wikimedia Commons'
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
}

function writeCache(key: string, value: RecipeImageResult[]): void {
    CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    if (CACHE.size > CACHE_MAX_ENTRIES) {
        const overflow = CACHE.size - CACHE_MAX_ENTRIES
        const iter = CACHE.keys()
        for (let i = 0; i < overflow; i++) {
            const k = iter.next().value
            if (k !== undefined) CACHE.delete(k)
        }
    }
}

/** Test helper — flush cache between smoke runs. Not exported elsewhere. */
export function __clearImageSearchCacheForTesting(): void {
    CACHE.clear()
}

/** Test helper — inspect cache for smoke assertions. */
export function __imageSearchCacheSizeForTesting(): number {
    return CACHE.size
}
