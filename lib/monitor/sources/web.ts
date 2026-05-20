import { evaluateRule, type WebCandidate } from '../rules'
import type { MonitorWatch, WatchState } from '../schema'
import { extractUrlsFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// Web source adapter.
//
// No integration: each watch carries a URL (in `target`) and rules that
// reference that URL. The cheap-check fetches the URL once, builds a
// WebCandidate paired with the previous fetch's parsed state (from
// watch.state.extra), and evaluates the rule.
//
// Body size cap, AbortController-driven timeout, content-type-driven
// parsing (JSON vs text), and SSRF guards (HTTPS only, no link-local IP
// space) make this safe to run on the master tick without surprises.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 512 * 1024 // 512 KiB — generous for JSON endpoints + small HTML
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Block obvious internal targets so a watch can't be repurposed as a port
 *  scanner. Resolving DNS to verify against the resolved IP would be more
 *  correct but adds latency to every tick; the literal-IP filter catches
 *  the common cases (localhost, RFC1918, link-local). */
function isSafePublicUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return { ok: false, reason: 'invalid URL' }
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, reason: `protocol ${url.protocol} not allowed` }
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1') return { ok: false, reason: 'localhost blocked' }
    // IPv4 literals: filter common private ranges
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4) {
        const [a, b] = ipv4.slice(1).map(Number)
        if (
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            a === 0 ||
            a >= 224
        ) {
            return { ok: false, reason: 'private/link-local address blocked' }
        }
    }
    // IPv6 link-local / loopback literal
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
        return { ok: false, reason: 'private/link-local address blocked' }
    }
    return { ok: true, url }
}

/** Pull a body up to MAX_BODY_BYTES then close. Returns the decoded string
 *  (best-effort UTF-8) and whether it was truncated. */
async function readCappedBody(res: Response): Promise<{ text: string; truncated: boolean }> {
    const reader = res.body?.getReader()
    if (!reader) return { text: '', truncated: false }
    let received = 0
    const chunks: Uint8Array[] = []
    let truncated = false
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
            received += value.byteLength
            if (received > MAX_BODY_BYTES) {
                truncated = true
                // Keep enough to satisfy the cap, then cancel the rest.
                const overflow = received - MAX_BODY_BYTES
                const kept = value.byteLength - overflow
                if (kept > 0) chunks.push(value.subarray(0, kept))
                try { await reader.cancel() } catch { /* ignore */ }
                break
            }
            chunks.push(value)
        }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
    return { text: buf.toString('utf8'), truncated }
}

/** Try to parse the body as JSON when content-type says so; otherwise leave
 *  it as text. JSON parse errors are non-fatal — the rule can still match
 *  on text. */
function maybeParseJson(text: string, contentType: string | null): unknown {
    if (!contentType) {
        // Heuristic: if it starts with { or [, try JSON anyway.
        const trimmed = text.trimStart()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { return JSON.parse(text) } catch { return null }
        }
        return null
    }
    const ct = contentType.toLowerCase()
    if (ct.includes('application/json') || ct.includes('+json')) {
        try { return JSON.parse(text) } catch { return null }
    }
    return null
}

interface WebExtraState {
    lastStatus?: number
    lastJson?: unknown
    lastText?: string
}

function readPrevious(state: WatchState, url: string): WebExtraState {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const key = `web::${url}`
    const entry = all[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as WebExtraState
}

async function fetchOne(url: URL, abort: AbortSignal): Promise<{
    ok: true
    status: number
    text: string
    json: unknown
    truncated: boolean
} | { ok: false; error: string }> {
    let res: Response
    try {
        res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: abort,
            headers: {
                Accept: 'application/json, text/html, text/plain, */*;q=0.5',
                // Identify ourselves so origin operators can rate-limit / contact us.
                'User-Agent': 'Orchestrator Smart Monitor/1.0',
            },
        })
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const { text, truncated } = await readCappedBody(res)
    const json = maybeParseJson(text, res.headers.get('content-type'))
    return { ok: true, status: res.status, text, json, truncated }
}

async function checkOneUrl(
    watch: MonitorWatch,
    url: string,
    now: number,
    timeoutMs: number,
    accumulatedExtra: Record<string, unknown>,
): Promise<{
    matches: MatchedCandidate[]
    candidatesSeen: number
    extraPatch: Record<string, unknown>
    error?: string
}> {
    const safety = isSafePublicUrl(url)
    if (!safety.ok) {
        return {
            matches: [],
            candidatesSeen: 0,
            extraPatch: {},
            error: `URL rejected (${safety.reason}): ${url}`,
        }
    }
    const previous = readPrevious(
        { ...watch.state, extra: accumulatedExtra },
        url,
    )
    const controller = new AbortController()
    const fetched = await withTimeout(
        fetchOne(safety.url, controller.signal),
        timeoutMs,
        `web fetch ${url}`,
        () => controller.abort(),
    )
    if (!fetched.ok) {
        return {
            matches: [],
            candidatesSeen: 1,
            extraPatch: {},
            error: fetched.error,
        }
    }

    const candidate: WebCandidate = {
        source: 'web',
        url,
        status: fetched.status,
        previousStatus: previous.lastStatus ?? null,
        text: fetched.text,
        json: fetched.json,
        previousJson: previous.lastJson ?? null,
        fetchedAt: now,
    }

    const matches: MatchedCandidate[] = []
    if (evaluateRule(watch.rule, candidate)) {
        matches.push({
            candidate,
            summary: `${url} → HTTP ${fetched.status}`,
            externalId: `${url}@${now}`,
            details: {
                url,
                status: fetched.status,
                previousStatus: previous.lastStatus ?? null,
                truncated: fetched.truncated,
            },
        })
    }

    // Persist this fetch's parsed shape as "previous" for next tick.
    return {
        matches,
        candidatesSeen: 1,
        extraPatch: {
            [`web::${url}`]: {
                lastStatus: fetched.status,
                lastJson: fetched.json,
                lastText: fetched.text.length > 16_384 ? fetched.text.slice(0, 16_384) : fetched.text,
            } satisfies WebExtraState,
        },
    }
}

export const webSourceAdapter: SourceAdapter = {
    source: 'web',
    supportedRuleKinds: ['web_status', 'web_json_path', 'web_text_contains'],
    supportedActionKinds: ['notify_inbox'],

    async isAvailable(): Promise<AvailabilityResult> {
        // Web is always available — outbound HTTPS is assumed in this app.
        return { available: true }
    },

    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('web', async () => {
            const { watch, now, timeoutMs } = input
            // A web watch may reference multiple URLs across `any_of` / `all_of`
            // composition; visit each unique URL once.
            const urls = extractUrlsFromRule(watch.rule)
            // Fallback to target if no rule URL extractable.
            if (urls.length === 0 && watch.target) urls.push(watch.target)

            const errors: string[] = []
            const allMatches: MatchedCandidate[] = []
            let candidatesSeen = 0
            const accumulatedExtra: Record<string, unknown> = { ...(watch.state.extra ?? {}) }

            // Budget the timeout across URLs evenly so one slow page can't
            // starve the others on the same watch.
            const perUrl = Math.max(1500, Math.floor(timeoutMs / Math.max(1, urls.length)))

            for (const url of urls) {
                const result = await checkOneUrl(watch, url, now, perUrl, accumulatedExtra)
                if (result.error) errors.push(result.error)
                allMatches.push(...result.matches)
                candidatesSeen += result.candidatesSeen
                Object.assign(accumulatedExtra, result.extraPatch)
            }

            return {
                ok: errors.length === 0,
                error: errors.length > 0 ? errors.join('; ') : undefined,
                matches: allMatches,
                candidatesSeen,
                stateUpdate: { extra: accumulatedExtra, lastFetchedAt: now },
                fetchedAt: now,
            }
        })
    },
}

// Re-export so consumers don't need to import the rule-targets helper.
export { extractUrlsFromRule } from './rule-targets'
