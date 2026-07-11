import { createHmac, timingSafeEqual } from 'crypto'

import { SlidingWindowRateLimiter } from '@/lib/api/sliding-window-rate-limit'
import type { WebhookEndpoint } from './schema'

interface AuthResult {
    ok: boolean
    status: number
    error?: string
    retryAfterSeconds?: number
}

const rateLimiter = new SlidingWindowRateLimiter(60_000, 5_000)

export function checkWebhookRateLimit(endpoint: WebhookEndpoint, request: Request, now = Date.now()): AuthResult {
    const limit = endpoint.rateLimitPerMinute
    if (!Number.isFinite(limit) || limit <= 0) return { ok: true, status: 200 }

    const key = `${endpoint.id}:${requestIp(request)}`
    const result = rateLimiter.check(key, limit, now)
    if (result.allowed) return { ok: true, status: 200 }

    return {
        ok: false,
        status: 429,
        error: 'Webhook rate limit exceeded.',
        retryAfterSeconds: result.retryAfterSeconds,
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

    const verified = endpoint.authMode === 'svix'
        ? verifySvix(endpoint, request, rawBody, now)
        : verifyHmac(endpoint, request, rawBody, now)
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

    const signatures = hmacSignatureCandidates(request)
    if (signatures.length === 0) return false

    const timestamp = request.headers.get('x-orchestrator-webhook-timestamp')
        ?? request.headers.get('x-webhook-timestamp')
        ?? request.headers.get('x-slack-request-timestamp')
        ?? timestampFromStripeSignature(request.headers.get('stripe-signature'))
    const timestampMs = parseTimestampMs(timestamp)
    const signedPayloads = [rawBody]

    if (timestamp) {
        if (timestampMs === null) return false
        const skewSeconds = Math.abs(now - timestampMs) / 1000
        if (skewSeconds > endpoint.hmacToleranceSeconds) return false
        signedPayloads.push(`${timestamp}.${rawBody}`)
        signedPayloads.push(`v0:${timestamp}:${rawBody}`)
    }

    const expected = signedPayloads.flatMap((payload) => [
        hmacHex(secret, payload),
        hmacBase64(secret, payload),
    ])

    return signatures.some((signature) => expected.some((candidate) => signaturesEqual(signature, candidate)))
}

function verifySvix(endpoint: WebhookEndpoint, request: Request, rawBody: string, now: number): boolean {
    const secret = endpoint.secret
    if (!secret) return false

    const messageId = request.headers.get('svix-id') ?? request.headers.get('webhook-id')
    const timestamp = request.headers.get('svix-timestamp') ?? request.headers.get('webhook-timestamp')
    const signatureHeader = request.headers.get('svix-signature') ?? request.headers.get('webhook-signature')
    if (!messageId || !timestamp || !signatureHeader) return false

    const timestampMs = parseTimestampMs(timestamp)
    if (timestampMs === null) return false
    const skewSeconds = Math.abs(now - timestampMs) / 1000
    if (skewSeconds > endpoint.hmacToleranceSeconds) return false

    const signingKey = svixSecretBytes(secret)
    if (!signingKey) return false
    const signedContent = `${messageId}.${timestamp}.${rawBody}`
    const expected = createHmac('sha256', signingKey).update(signedContent).digest('base64')
    return svixSignatures(signatureHeader).some((signature) => constantTimeEqual(signature, expected))
}

function hmacHex(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex')
}

function hmacBase64(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('base64')
}

function constantTimeEqual(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a)
    const bBuffer = Buffer.from(b)
    if (aBuffer.length !== bBuffer.length) return false
    return timingSafeEqual(aBuffer, bBuffer)
}

function signaturesEqual(a: string, b: string): boolean {
    if (constantTimeEqual(a, b)) return true
    return isHexLike(a) && isHexLike(b) && constantTimeEqual(a.toLowerCase(), b.toLowerCase())
}

function hmacSignatureCandidates(request: Request): string[] {
    const values = [
        request.headers.get('x-orchestrator-signature'),
        request.headers.get('x-hub-signature-256'),
        request.headers.get('x-webhook-signature'),
        request.headers.get('x-shopify-hmac-sha256'),
        request.headers.get('x-signature'),
        request.headers.get('x-signature-256'),
        request.headers.get('x-slack-signature'),
    ]
    const signatures = values.flatMap(extractSignatureValues)
    signatures.push(...stripeSignatureCandidates(request.headers.get('stripe-signature')))
    return Array.from(new Set(signatures.filter(Boolean)))
}

function extractSignatureValues(value: string | null): string[] {
    const clean = value?.trim()
    if (!clean) return []
    return clean
        .split(/\s+/)
        .flatMap((part) => part.split(','))
        .map(cleanSignaturePart)
        .filter((part): part is string => Boolean(part))
}

function cleanSignaturePart(value: string): string | null {
    const clean = value.trim()
    if (!clean) return null
    for (const prefix of ['sha256=', 'v0=', 'v1=']) {
        if (clean.toLowerCase().startsWith(prefix)) return clean.slice(prefix.length).trim()
    }
    return clean
}

function stripeSignatureCandidates(value: string | null): string[] {
    const clean = value?.trim()
    if (!clean) return []
    const out: string[] = []
    for (const part of clean.split(',')) {
        const [key, ...rest] = part.split('=')
        if (key?.trim() === 'v1') {
            const signature = rest.join('=').trim()
            if (signature) out.push(signature)
        }
    }
    return out
}

function timestampFromStripeSignature(value: string | null): string | null {
    const clean = value?.trim()
    if (!clean) return null
    for (const part of clean.split(',')) {
        const [key, ...rest] = part.split('=')
        if (key?.trim() === 't') return rest.join('=').trim() || null
    }
    return null
}

function svixSignatures(value: string): string[] {
    return value
        .trim()
        .split(/\s+/)
        .map((part) => {
            const clean = part.trim()
            const comma = clean.indexOf(',')
            return comma >= 0 ? clean.slice(comma + 1).trim() : clean
        })
        .filter(Boolean)
}

function svixSecretBytes(secret: string): Buffer | null {
    const raw = secret.trim()
    const encoded = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw
    try {
        return Buffer.from(encoded, 'base64')
    } catch {
        return null
    }
}

function parseTimestampMs(value: string | null): number | null {
    if (!value) return null
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null
    return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000
}

function isHexLike(value: string): boolean {
    return /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0
}

function requestIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
    return request.headers.get('x-real-ip')?.trim() || 'unknown'
}
