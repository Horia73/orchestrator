import { NextResponse } from 'next/server'

const JSON_HEADERS = {
    'Cache-Control': 'no-store',
}

const API_TOKEN_ENV_KEYS = [
    'ORCHESTRATOR_API_TOKEN',
    'ORCHESTRATOR_ACCESS_TOKEN',
]
const API_TOKEN_HEADER_NAMES = [
    'x-orchestrator-api-token',
    'x-orchestrator-access-token',
]
const API_TOKEN_COOKIE_NAMES = [
    'orchestrator_api_token',
    'orchestrator_access_token',
]
const TRUSTED_LOOPBACK_FORWARDERS_ENV_KEY = 'ORCHESTRATOR_TRUSTED_LOOPBACK_FORWARDERS'

export function guardSensitiveRequest(request: Request): NextResponse | null {
    const message = getGuardFailureMessage(request)
    if (!message) return null

    return NextResponse.json(
        { error: 'Forbidden', message },
        { status: 403, headers: JSON_HEADERS }
    )
}

function getGuardFailureMessage(request: Request): string | null {
    let requestUrl: URL
    try {
        requestUrl = new URL(request.url)
    } catch {
        return 'Malformed request URL.'
    }

    const host = request.headers.get('host')
    const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
    const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'))
    if (host && forwardedHost && normalizeHost(host) !== normalizeHost(forwardedHost)) {
        return 'Request forwarded host does not match host.'
    }
    if (host && !forwardedHost && normalizeHost(host) !== normalizeHost(requestUrl.host)) {
        return 'Request host does not match URL host.'
    }

    const effectiveHost = forwardedHost || host || requestUrl.host
    const effectiveProtocol = (forwardedProto || requestUrl.protocol.replace(':', '')).toLowerCase()
    const effectiveOrigin = `${effectiveProtocol}://${effectiveHost}`
    const validApiToken = hasValidApiToken(request)
    const effectiveHostname = extractHostname(effectiveHost)

    if (isForwardedLoopbackHostClaim(request, effectiveHostname)) {
        return 'Forwarded requests cannot claim a loopback host.'
    }

    const origin = request.headers.get('origin')?.trim()
    if (!origin) {
        const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase()
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            return 'Cross-origin requests are not allowed.'
        }
        if (fetchSite !== 'same-origin' && !isLoopbackHost(effectiveHostname) && !validApiToken) {
            return 'Direct API requests to non-loopback hosts require ORCHESTRATOR_API_TOKEN.'
        }
        return null
    }

    if (validApiToken) return null

    if (origin.toLowerCase() === 'null') {
        return 'Cross-origin requests are not allowed.'
    }

    let originUrl: URL
    try {
        originUrl = new URL(origin)
    } catch {
        return 'Malformed Origin header.'
    }

    if (originUrl.origin !== effectiveOrigin) {
        return 'Cross-origin requests are not allowed.'
    }

    if (normalizeHost(originUrl.host) !== normalizeHost(effectiveHost)) {
        return 'Request origin does not match host.'
    }

    return null
}

function firstHeaderValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

function normalizeHost(host: string): string {
    return host.trim().replace(/\.$/, '').toLowerCase()
}

function isForwardedLoopbackHostClaim(request: Request, effectiveHostname: string): boolean {
    if (!isLoopbackHost(effectiveHostname)) return false

    const hasForwardedHeaders = Boolean(
        firstHeaderValue(request.headers.get('x-forwarded-host'))
        || firstHeaderValue(request.headers.get('x-forwarded-proto'))
        || firstHeaderValue(request.headers.get('x-forwarded-for'))
        || firstHeaderValue(request.headers.get('x-real-ip'))
    )
    if (!hasForwardedHeaders) return false

    const clientIp = firstHeaderValue(request.headers.get('x-forwarded-for'))
        || firstHeaderValue(request.headers.get('x-real-ip'))
    if (!clientIp) {
        if (isLoopbackHost(extractHostname(firstHeaderValue(request.headers.get('x-forwarded-host')) || ''))) {
            return false
        }

        const hostHostname = extractHostname(request.headers.get('host') || '')
        let urlHostname = ''
        try {
            urlHostname = new URL(request.url).hostname
        } catch {
            return true
        }
        return !(isLoopbackHost(hostHostname) || isLoopbackHost(urlHostname))
    }

    const clientHostname = extractHostname(clientIp)
    if (isLoopbackHost(clientHostname)) return false
    if (requestIdentifiesLoopback(request) && isTrustedLoopbackForwarder(clientHostname)) return false

    return true
}

function requestIdentifiesLoopback(request: Request): boolean {
    const candidates = [
        extractHostname(request.headers.get('host') || ''),
        extractHostname(firstHeaderValue(request.headers.get('x-forwarded-host')) || ''),
    ]
    try {
        candidates.push(new URL(request.url).hostname)
    } catch {
        // Malformed request URLs are handled by the caller.
    }
    return candidates.some(isLoopbackHost)
}

function isTrustedLoopbackForwarder(hostname: string): boolean {
    const host = normalizeIpAddress(hostname)
    if (!host) return false

    const configured = process.env[TRUSTED_LOOPBACK_FORWARDERS_ENV_KEY] || ''
    return configured
        .split(/[\s,]+/)
        .map(entry => entry.trim())
        .filter(Boolean)
        .some(entry => trustedForwarderEntryMatches(host, entry))
}

function trustedForwarderEntryMatches(host: string, entry: string): boolean {
    const clean = normalizeIpAddress(entry)
    if (!clean) return false

    if (!clean.includes('/')) return host === clean

    const [network, prefixText] = clean.split('/')
    const networkInt = ipv4ToInt(network || '')
    const hostInt = ipv4ToInt(host)
    const prefix = Number.parseInt(prefixText || '', 10)
    if (networkInt === null || hostInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return false
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (networkInt & mask) === (hostInt & mask)
}

function configuredApiTokens(): string[] {
    return API_TOKEN_ENV_KEYS
        .map(key => process.env[key]?.trim())
        .filter((token): token is string => Boolean(token))
}

function hasValidApiToken(request: Request): boolean {
    const configured = configuredApiTokens()
    if (configured.length === 0) return false

    const candidates = requestApiTokenCandidates(request)
    if (candidates.length === 0) return false

    return candidates.some(candidate =>
        configured.some(token => constantTimeEqual(candidate, token))
    )
}

function requestApiTokenCandidates(request: Request): string[] {
    const candidates: string[] = []

    const auth = request.headers.get('authorization')?.trim()
    if (auth?.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim()
        if (token) candidates.push(token)
    }

    for (const header of API_TOKEN_HEADER_NAMES) {
        const value = request.headers.get(header)?.trim()
        if (value) candidates.push(value)
    }

    const cookieHeader = request.headers.get('cookie')
    if (cookieHeader) {
        const cookies = parseCookieHeader(cookieHeader)
        for (const name of API_TOKEN_COOKIE_NAMES) {
            const value = cookies.get(name)?.trim()
            if (value) candidates.push(value)
        }
    }

    return candidates
}

function parseCookieHeader(header: string): Map<string, string> {
    const cookies = new Map<string, string>()
    for (const part of header.split(';')) {
        const index = part.indexOf('=')
        if (index <= 0) continue
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        if (!key) continue
        try {
            cookies.set(key, decodeURIComponent(value))
        } catch {
            cookies.set(key, value)
        }
    }
    return cookies
}

function constantTimeEqual(a: string, b: string): boolean {
    const max = Math.max(a.length, b.length)
    let diff = a.length ^ b.length
    for (let i = 0; i < max; i += 1) {
        diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
    }
    return diff === 0
}

function extractHostname(host: string): string {
    const clean = host.trim()
    if (!clean) return ''
    if (clean.startsWith('[')) {
        const end = clean.indexOf(']')
        return end >= 0 ? clean.slice(1, end) : clean
    }
    const colonCount = (clean.match(/:/g) || []).length
    if (colonCount > 1) return clean
    return clean.split(':')[0] ?? clean
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.trim().replace(/\.$/, '').replace(/^\[(.*)]$/, '$1').toLowerCase()
    if (host.startsWith('::ffff:')) {
        return isLoopbackHost(host.slice('::ffff:'.length))
    }
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host === '::1'
        || host === '0:0:0:0:0:0:0:1'
        || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function normalizeIpAddress(value: string): string {
    const clean = value.trim().replace(/\.$/, '').replace(/^\[(.*)]$/, '$1').toLowerCase()
    if (clean.startsWith('::ffff:')) return clean.slice('::ffff:'.length)
    return clean
}

function ipv4ToInt(value: string): number | null {
    const parts = value.split('.')
    if (parts.length !== 4) return null

    let result = 0
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null
        const byte = Number.parseInt(part, 10)
        if (byte < 0 || byte > 255) return null
        result = ((result << 8) | byte) >>> 0
    }
    return result >>> 0
}
