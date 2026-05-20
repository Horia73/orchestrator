import { getEnvValue } from '@/lib/config'

const DEFAULT_APP_ORIGIN = 'http://localhost:3000'
const DEFAULT_OAUTH_LOOPBACK_ORIGIN = 'http://localhost:3000'

const PUBLIC_ORIGIN_ENV_KEYS = [
    'ORCHESTRATOR_PUBLIC_URL',
    'ORCHESTRATOR_APP_URL',
    'NEXT_PUBLIC_APP_URL',
]

export function resolveRequestOrigin(request: Request): string {
    return resolveRequestAwareOrigin(originFromRequestHeaders(request) ?? safeRequestUrlOrigin(request.url))
}

export function resolveAppOrigin(candidate?: string | null): string {
    for (const key of PUBLIC_ORIGIN_ENV_KEYS) {
        const origin = normalizeOrigin(getEnvValue(key), false)
        if (origin) return origin
    }

    return normalizeOrigin(candidate, true) ?? DEFAULT_APP_ORIGIN
}

export function resolveOAuthRedirectUri(configured: string | null | undefined, origin: string, callbackPath: string): string {
    const appOrigin = resolveOriginPreferLoopback(origin)
    const fallbackOrigin = isOAuthCompatibleOrigin(appOrigin)
        ? appOrigin
        : loopbackOriginFor(appOrigin)
    const fallback = new URL(callbackPath, fallbackOrigin).toString()
    const clean = configured?.trim()
    if (!clean) return fallback

    let configuredUrl: URL
    try {
        configuredUrl = new URL(clean)
    } catch {
        return fallback
    }

    if (configuredUrl.protocol !== 'http:' && configuredUrl.protocol !== 'https:') return fallback

    if (isWildcardHost(configuredUrl.hostname)) return fallback
    if (!isOAuthCompatibleUrl(configuredUrl)) return fallback

    return configuredUrl.toString()
}

export function isLoopbackHost(hostname: string): boolean {
    const host = normalizeHostname(hostname)
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host === '::1'
        || host === '0:0:0:0:0:0:0:1'
        || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function originFromRequestHeaders(request: Request): string | null {
    let requestUrl: URL
    try {
        requestUrl = new URL(request.url)
    } catch {
        return null
    }

    const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
    const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'))
    const forwardedPort = firstHeaderValue(request.headers.get('x-forwarded-port'))
    const host = forwardedHost || firstHeaderValue(request.headers.get('host')) || requestUrl.host
    if (!host) return null

    const proto = (forwardedProto || requestUrl.protocol.replace(':', '') || 'http').toLowerCase()
    const hostWithPort = forwardedPort && !host.includes(':') ? `${host}:${forwardedPort}` : host
    return `${proto}://${hostWithPort}`
}

function safeRequestUrlOrigin(value: string): string | null {
    try {
        return new URL(value).origin
    } catch {
        return null
    }
}

function normalizeOrigin(value: string | null | undefined, allowWildcardLoopback: boolean): string | null {
    const raw = value?.trim()
    if (!raw) return null

    let url: URL
    try {
        url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    } catch {
        return null
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (isWildcardHost(url.hostname)) {
        if (!allowWildcardLoopback) return null
        if (normalizeHostname(url.hostname) === '0.0.0.0') {
            url.hostname = '127.0.0.1'
        } else {
            return null
        }
    }

    return url.origin
}

function firstHeaderValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

function resolveOriginPreferLoopback(candidate?: string | null): string {
    const origin = normalizeOrigin(candidate, true)
    if (origin && isLoopbackOrigin(origin)) return origin
    return resolveAppOrigin(candidate)
}

function resolveRequestAwareOrigin(candidate?: string | null): string {
    const origin = normalizeOrigin(candidate, true)
    if (origin && isLoopbackOrigin(origin)) return origin

    const configured = configuredPublicOrigin()
    if (origin && configured) {
        if (isPublicHttpsOrigin(origin) && !isPublicHttpsOrigin(configured)) {
            return origin
        }
        return configured
    }

    return origin ?? configured ?? DEFAULT_APP_ORIGIN
}

function configuredPublicOrigin(): string | null {
    for (const key of PUBLIC_ORIGIN_ENV_KEYS) {
        const origin = normalizeOrigin(getEnvValue(key), false)
        if (origin) return origin
    }
    return null
}

function isLoopbackOrigin(origin: string): boolean {
    try {
        return isLoopbackHost(new URL(origin).hostname)
    } catch {
        return false
    }
}

function loopbackOriginFor(origin: string): string {
    try {
        const url = new URL(origin)
        const port = url.port && url.port !== '80' && url.port !== '443' ? url.port : '3000'
        return `http://localhost:${port}`
    } catch {
        return DEFAULT_OAUTH_LOOPBACK_ORIGIN
    }
}

function isOAuthCompatibleOrigin(origin: string): boolean {
    try {
        return isOAuthCompatibleUrl(new URL(origin))
    } catch {
        return false
    }
}

function isPublicHttpsOrigin(origin: string): boolean {
    try {
        const url = new URL(origin)
        return url.protocol === 'https:' && !isLoopbackHost(url.hostname) && isPublicDomainLike(normalizeHostname(url.hostname))
    } catch {
        return false
    }
}

function isOAuthCompatibleUrl(url: URL): boolean {
    const host = normalizeHostname(url.hostname)
    if (isLoopbackHost(host)) return url.protocol === 'http:' || url.protocol === 'https:'
    if (url.protocol !== 'https:') return false
    if (isIpAddress(host)) return false
    return isPublicDomainLike(host)
}

function isPublicDomainLike(hostname: string): boolean {
    const labels = hostname.split('.').filter(Boolean)
    if (labels.length < 2) return false
    const tld = labels[labels.length - 1]
    if (!/^[a-z]{2,63}$/i.test(tld)) return false

    const reservedTlds = new Set([
        'example',
        'home',
        'internal',
        'invalid',
        'lan',
        'local',
        'localhost',
        'test',
    ])
    return !reservedTlds.has(tld.toLowerCase())
}

function isIpAddress(hostname: string): boolean {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')
}

function isWildcardHost(hostname: string): boolean {
    const host = normalizeHostname(hostname)
    return host === '0.0.0.0' || host === '::' || host === '[::]'
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}
