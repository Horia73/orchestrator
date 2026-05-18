import { NextResponse } from 'next/server'

const JSON_HEADERS = {
    'Cache-Control': 'no-store',
}

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

    const origin = request.headers.get('origin')?.trim()
    if (!origin) {
        const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase()
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            return 'Cross-origin requests are not allowed.'
        }
        return null
    }

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
