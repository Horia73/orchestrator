/**
 * Smoke test for the recipe image-search lib.
 *
 * Tests the pure pieces:
 *   - `parseWikimediaResponse` maps a Wikimedia action API payload into
 *     RecipeImageResult[] with HTML attribution stripped, MIME filtered,
 *     and search relevance order preserved.
 *   - Cache hit/miss/eviction behavior via `searchRecipeImages` (with
 *     `fetch` stubbed — no network in CI).
 *
 * Run: npx tsx scripts/smoke-recipe-images.ts
 */
import {
    parseWikimediaResponse,
    searchRecipeImages,
    __clearImageSearchCacheForTesting,
    __imageSearchCacheSizeForTesting,
} from '@/lib/recipe/image-search'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// --- parseWikimediaResponse ----------------------------------------------

const richResponse = {
    query: {
        pages: {
            '1001': {
                pageid: 1001,
                index: 1,
                title: 'File:Penne arrabbiata 1.jpg',
                imageinfo: [{
                    thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/Penne_arrabbiata_1.jpg/800px-Penne_arrabbiata_1.jpg',
                    thumbwidth: 800,
                    thumbheight: 600,
                    url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Penne_arrabbiata_1.jpg',
                    width: 4000,
                    height: 3000,
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Penne_arrabbiata_1.jpg',
                    mime: 'image/jpeg',
                    extmetadata: {
                        Artist: { value: '<a href="https://example.com/u/photographer" title="User:Photographer">Anna Bucătăreasa</a>' },
                        LicenseShortName: { value: 'CC BY-SA 4.0' },
                    },
                }],
            },
            '1002': {
                pageid: 1002,
                index: 2,
                title: 'File:Penne arrabbiata pdf.pdf',
                imageinfo: [{
                    thumburl: 'https://example.com/x.pdf',
                    url: 'https://example.com/x.pdf',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Penne_arrabbiata_pdf.pdf',
                    mime: 'application/pdf',
                }],
            },
            '1003': {
                pageid: 1003,
                index: 3,
                title: 'File:Penne arrabbiata 2.png',
                imageinfo: [{
                    thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/Penne_arrabbiata_2.png/800px-Penne_arrabbiata_2.png',
                    thumbwidth: 800,
                    thumbheight: 533,
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Penne_arrabbiata_2.png',
                    mime: 'image/png',
                    extmetadata: {
                        Credit: { value: 'Photo by &quot;tavolartegusto.it&quot; — CC BY-SA' },
                    },
                }],
            },
            '1004': {
                pageid: 1004,
                index: 4,
                title: 'File:No imageinfo.jpg',
                // imageinfo intentionally missing — should be skipped
            },
        },
    },
}

{
    const r = parseWikimediaResponse(richResponse, 4)
    check('parse: skipped PDF and entry without imageinfo', r.length === 2)
    check('parse: search-order preserved (index 1 first)', r[0]?.url?.includes('Penne_arrabbiata_1'))
    check('parse: PNG comes after JPEG (index 3)', r[1]?.url?.includes('Penne_arrabbiata_2'))
    check('parse: attribution HTML stripped', r[0]?.attribution === 'Anna Bucătăreasa')
    check('parse: Credit fallback used when Artist missing', r[1]?.attribution.startsWith('Photo by "tavolartegusto.it"'))
    check('parse: width/height from thumb dimensions', r[0]?.width === 800 && r[0]?.height === 600)
    check('parse: sourceUrl preserved', r[0]?.sourceUrl?.endsWith('Penne_arrabbiata_1.jpg'))
    check('parse: mime preserved as union type', r[0]?.mime === 'image/jpeg' && r[1]?.mime === 'image/png')

    const limited = parseWikimediaResponse(richResponse, 1)
    check('parse: respects limit', limited.length === 1)
}

{
    const emptyResp = parseWikimediaResponse({}, 4)
    check('parse: empty response → []', Array.isArray(emptyResp) && emptyResp.length === 0)

    const noPages = parseWikimediaResponse({ query: {} }, 4)
    check('parse: missing pages → []', noPages.length === 0)
}

// --- searchRecipeImages with stubbed fetch -------------------------------

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

// Cache behavior: second call for the same query should NOT trigger a fetch.
{
    __clearImageSearchCacheForTesting()
    let calls = 0
    const stub = {
        restore: (() => {
            const real = globalThis.fetch
            globalThis.fetch = (async () => { calls++; return jsonResponse(richResponse) }) as typeof fetch
            return () => { globalThis.fetch = real }
        })(),
    }
    try {
        const a = await searchRecipeImages('arrabbiata test', { limit: 4 })
        const b = await searchRecipeImages('arrabbiata test', { limit: 4 })
        check('cache: same query+limit returns identical array', a.length === b.length && a[0].url === b[0].url)
        check('cache: fetched once for two identical calls', calls === 1, { calls })
        const c = await searchRecipeImages('arrabbiata test', { limit: 2 })
        check('cache: different limit is a different key', calls === 2 && c.length === 2, { calls })
    } finally {
        stub.restore()
    }
}

// Upstream failure: throws — does not silently return empty (the API route
// translates this to a 502 the frontend hides gracefully).
{
    __clearImageSearchCacheForTesting()
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch
    let threw = false
    try {
        await searchRecipeImages('failure case')
    } catch (e) {
        threw = e instanceof Error && /503/.test(e.message)
    } finally {
        globalThis.fetch = real
    }
    check('error: upstream 503 surfaces as throw with status in message', threw)
}

// Empty query short-circuits without a fetch call.
{
    __clearImageSearchCacheForTesting()
    let called = false
    const real = globalThis.fetch
    globalThis.fetch = (async () => { called = true; return jsonResponse({}) }) as typeof fetch
    try {
        const r = await searchRecipeImages('   ')
        check('empty query: returns [] without fetching', r.length === 0 && !called)
    } finally {
        globalThis.fetch = real
    }
}

// Cache size sanity.
{
    __clearImageSearchCacheForTesting()
    check('cache: starts empty after clear', __imageSearchCacheSizeForTesting() === 0)
    const real = globalThis.fetch
    globalThis.fetch = (async () => jsonResponse(richResponse)) as typeof fetch
    try {
        await searchRecipeImages('q1')
        await searchRecipeImages('q2')
        await searchRecipeImages('q3')
        check('cache: grows by 1 per unique query', __imageSearchCacheSizeForTesting() === 3)
    } finally {
        globalThis.fetch = real
    }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
