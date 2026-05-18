import dns from 'dns/promises'
import net from 'net'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { clamp, numberArg, stringArg, truncateText } from './helpers'

const FETCH_TIMEOUT_MS = 20_000
const MAX_FETCH_BYTES = 2_000_000
const DEFAULT_MAX_CHARS = 80_000
export const webFetchTool: ToolDef = {
    id: 'WebFetch',
    name: 'WebFetch',
    description: 'Fetches an HTTP(S) URL for research and returns extracted text or structured JSON. Blocks private/local network targets.',
    input_schema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'HTTP or HTTPS URL to fetch.',
            },
            max_chars: {
                type: 'integer',
                description: 'Maximum characters to return. Defaults to 80000.',
            },
        },
        required: ['url'],
    },
    tags: ['read', 'web'],
}

export async function executeWebFetch(args: Record<string, unknown>): Promise<ToolResult> {
    const url = stringArg(args, ['url'])
    if (!url) return { success: false, error: 'Missing required parameter: url' }
    const safety = await validatePublicHttpUrl(url)
    if (!safety.ok) return { success: false, error: safety.error }

    const maxChars = clamp(Math.floor(numberArg(args, ['max_chars'], DEFAULT_MAX_CHARS)), 1_000, 200_000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await safeFetch(safety.url, controller.signal)
        const contentType = response.headers.get('content-type') ?? ''
        const body = await readResponseBody(response, MAX_FETCH_BYTES)
        if (!response.ok) {
            return { success: false, error: `Fetch failed ${response.status} ${response.statusText}: ${body.slice(0, 1000)}` }
        }

        const processed = processFetchedBody(body, contentType)
        const truncated = truncateText(processed, maxChars)
        return {
            success: true,
            data: {
                url: response.url,
                status: response.status,
                content_type: contentType,
                content: truncated.text,
                truncated: truncated.truncated,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown web fetch error' }
    } finally {
        clearTimeout(timer)
    }
}

async function safeFetch(initialUrl: URL, signal: AbortSignal): Promise<Response> {
    let current = initialUrl
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
        const response = await fetch(current.toString(), {
            redirect: 'manual',
            signal,
            headers: {
                'User-Agent': 'orchestrator-agent/1.0',
                'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.2',
            },
        })

        if (response.status < 300 || response.status >= 400) return response
        const location = response.headers.get('location')
        if (!location) return response
        const nextUrl = new URL(location, current)
        const safety = await validatePublicHttpUrl(nextUrl.toString())
        if (!safety.ok) throw new Error(`Blocked unsafe redirect: ${safety.error}`)
        current = safety.url
    }
    throw new Error('Too many redirects')
}

async function validatePublicHttpUrl(raw: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return { ok: false, error: `Invalid URL: ${raw}` }
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'Only http and https URLs are supported.' }
    }

    const host = url.hostname
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return { ok: false, error: 'Localhost URLs are blocked for WebFetch.' }
    }

    const directIpVersion = net.isIP(host)
    const addresses = directIpVersion
        ? [{ address: host }]
        : await dns.lookup(host, { all: true }).catch(() => [])

    if (addresses.length === 0) return { ok: false, error: `Could not resolve host: ${host}` }
    if (addresses.some(entry => isPrivateAddress(entry.address))) {
        return { ok: false, error: 'Private or local network targets are blocked for WebFetch.' }
    }

    return { ok: true, url }
}

function isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number)
        return (
            a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            a === 0
        )
    }
    if (net.isIPv6(address)) {
        const lower = address.toLowerCase()
        return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
    }
    return true
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (received > maxBytes) {
            chunks.push(value.slice(0, Math.max(0, value.byteLength - (received - maxBytes))))
            break
        }
        chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf-8')
}

function processFetchedBody(body: string, contentType: string): string {
    if (contentType.includes('application/json')) {
        try {
            return JSON.stringify(JSON.parse(body), null, 2)
        } catch {
            return body
        }
    }
    if (contentType.includes('text/html') || /<html[\s>]/i.test(body)) {
        return htmlToText(body)
    }
    return body
}

function htmlToText(html: string): string {
    return decodeHtmlEntities(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
}
