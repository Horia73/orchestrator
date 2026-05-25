import { createHmac, timingSafeEqual } from 'crypto'

import type { WebhookEndpoint } from './schema'

interface AuthResult {
    ok: boolean
    status: number
    error?: string
    retryAfterSeconds?: number
}

interface RateBucket {
    resetAt: number
    count: number
}

const buckets = new Map<string, RateBucket>()

export function checkWebhookRateLimit(endpoint: WebhookEndpoint, request: Request, now = Date.now()): AuthResult {
    const limit = endpoint.rateLimitPerMinute
    if (!Number.isFinite(limit) || limit <= 0) return { ok: true, status: 200 }

    const key = `${endpoint.id}:${requestIp(request)}`
    const current = buckets.get(key)
    if (!current || current.resetAt <= now) {
        buckets.set(key, { resetAt: now + 60_000, count: 1 })
        return { ok: true, status: 200 }
    }

    current.count += 1
    if (current.count <= limit) return { ok: true, status: 200 }

    return {
        ok: false,
        status: 429,
        error: 'Webhook rate limit exceeded.',
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    }
}

export function authenticateWebhookRequest(
    endpoint: WebhookEndpoint,
    request: Request,
    rawBody: string,
    now = Date.now(),
): AuthResult {
    if (!endpoint.enabled) {
        return { ok: false, status: 404, error: 'Webhook endpoint not found.' }
    }

    if (endpoint.authMode === 'none') {
        return { ok: true, status: 200 }
    }

    if (!endpoint.secret) {
        return { ok: false, status: 500, error: 'Webhook endpoint has no configured secret.' }
    }

    if (endpoint.authMode === 'bearer') {
        const candidates = bearerCandidates(request)
        const ok = candidates.some((candidate) => constantTimeEqual(candidate, endpoint.secret ?? ''))
        return ok
            ? { ok: true, status: 200 }
            : { ok: false, status: 401, error: 'Invalid webhook secret.' }
    }

    const verified = verifyHmac(endpoint, request, rawBody, now)
    return verified
        ? { ok: true, status: 200 }
        : { ok: false, status: 401, error: 'Invalid webhook signature.' }
}

function bearerCandidates(request: Request): string[] {
    const candidates: string[] = []
    const auth = request.headers.get('authorization')?.trim()
    if (auth?.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim()
        if (token) candidates.push(token)
    }
    for (const header of ['x-orchestrator-webhook-secret', 'x-webhook-secret']) {
        const value = request.headers.get(header)?.trim()
        if (value) candidates.push(value)
    }
    return candidates
}

function verifyHmac(endpoint: WebhookEndpoint, request: Request, rawBody: string, now: number): boolean {
    const secret = endpoint.secret
    if (!secret) return false

    const signature = cleanSignature(
        request.headers.get('x-orchestrator-signature')
            ?? request.headers.get('x-hub-signature-256')
            ?? request.headers.get('x-webhook-signature'),
    )
    if (!signature) return false

    const timestamp = request.headers.get('x-orchestrator-webhook-timestamp')
        ?? request.headers.get('x-webhook-timestamp')
    const timestampSeconds = timestamp ? Number(timestamp) : null
    const candidates = [hmacHex(secret, rawBody)]

    if (timestamp && timestampSeconds !== null && Number.isFinite(timestampSeconds)) {
        const tsMs = timestampSeconds > 10_000_000_000 ? timestampSeconds : timestampSeconds * 1000
        const skewSeconds = Math.abs(now - tsMs) / 1000
        if (skewSeconds > endpoint.hmacToleranceSeconds) return false
        candidates.push(hmacHex(secret, `${timestamp}.${rawBody}`))
    }

    return candidates.some((candidate) => constantTimeEqual(signature, candidate))
}

function cleanSignature(value: string | null): string | null {
    const clean = value?.trim()
    if (!clean) return null
    return clean.toLowerCase().startsWith('sha256=')
        ? clean.slice('sha256='.length)
        : clean
}

function hmacHex(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a)
    const bBuffer = Buffer.from(b)
    if (aBuffer.length !== bBuffer.length) return false
    return timingSafeEqual(aBuffer, bBuffer)
}

function requestIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
    return request.headers.get('x-real-ip')?.trim() || 'unknown'
}
