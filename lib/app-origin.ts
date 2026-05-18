const DEFAULT_APP_ORIGIN = 'http://localhost:3000'

const PUBLIC_ORIGIN_ENV_KEYS = [
    'ORCHESTRATOR_PUBLIC_URL',
    'ORCHESTRATOR_APP_URL',
    'NEXT_PUBLIC_APP_URL',
]

export function resolveRequestOrigin(request: Request): string {
    return resolveAppOrigin(originFromRequestHeaders(request) ?? safeRequestUrlOrigin(request.url))
}

export function resolveAppOrigin(candidate?: string | null): string {
    for (const key of PUBLIC_ORIGIN_ENV_KEYS) {
        const origin = normalizeOrigin(process.env[key], false)
        if (origin) return origin
    }

    return normalizeOrigin(candidate, true) ?? DEFAULT_APP_ORIGIN
}

export function resolveOAuthRedirectUri(configured: string | null | undefined, origin: string, callbackPath: string): string {
    const appOrigin = resolveAppOrigin(origin)
    const fallback = new URL(callbackPath, appOrigin).toString()
    const clean = configured?.trim()
    if (!clean) return fallback

    let configuredUrl: URL
    try {
        configuredUrl = new URL(clean)
    } catch {
        return fallback
    }

    if (configuredUrl.protocol !== 'http:' && configuredUrl.protocol !== 'https:') return fallback

    const appHost = hostnameOf(appOrigin)
    if (isWildcardHost(configuredUrl.hostname)) return fallback
    if (isLoopbackHost(configuredUrl.hostname) && appHost && !isLoopbackHost(appHost)) return fallback

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

function hostnameOf(origin: string): string | null {
    try {
        return new URL(origin).hostname
    } catch {
        return null
    }
}

function isWildcardHost(hostname: string): boolean {
    const host = normalizeHostname(hostname)
    return host === '0.0.0.0' || host === '::' || host === '[::]'
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}
