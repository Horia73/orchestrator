import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { authenticateWebhookRequest, checkWebhookRateLimit } from '@/lib/webhooks/auth'
import { dispatchWebhookEvent } from '@/lib/webhooks/dispatch'
import { computeWebhookDedupeKey, normalizeWebhookEvent } from '@/lib/webhooks/normalize'
import { resolveWebhookProfileBySlug } from '@/lib/webhooks/profile-scope'
import { runWithProfileContext } from '@/lib/profiles/context'
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    createWebhookEvent,
    deleteWebhookEndpoint,
    getWebhookEndpointByIdOrSlug,
    listWebhookSubscriptions,
    setWebhookEventStatus,
    toPublicWebhookEndpoint,
    updateWebhookEndpoint,
} from '@/lib/webhooks/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_BODY_BYTES = 512_000

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { slug } = await params
        const endpoint = getWebhookEndpointByIdOrSlug(slug)
        if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })

        return NextResponse.json(
            {
                endpoint: toPublicWebhookEndpoint(endpoint),
                subscriptions: listWebhookSubscriptions(endpoint.id),
            },
            { headers: NO_STORE },
        )
  })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const { slug } = await params
            const body = await request.json()
            const updated = updateWebhookEndpoint(slug, body)
            if (!updated) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })
            return NextResponse.json(
                {
                    endpoint: toPublicWebhookEndpoint(updated.endpoint),
                    ...(updated.generatedSecret ? { secret: updated.generatedSecret } : {}),
                },
                { headers: NO_STORE },
            )
        } catch (err) {
            const status = isBadInput(err) ? 400 : 500
            if (status === 500) console.error('Failed to update webhook', err)
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Failed to update webhook.' },
                { status, headers: NO_STORE },
            )
        }
  })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { slug } = await params
        const ok = deleteWebhookEndpoint(slug)
        if (!ok) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })
        return NextResponse.json({ success: true }, { headers: NO_STORE })
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
        const { slug } = await params
        const resolution = resolveWebhookProfileBySlug(slug)
        if (resolution.status === 'not_found') {
            return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })
        }
        if (resolution.status === 'ambiguous') {
            return NextResponse.json(
                { error: 'Webhook slug is owned by more than one profile.' },
                { status: 409, headers: NO_STORE },
            )
        }

        return runWithProfileContext({ profileId: resolution.profileId }, async () => {
        const endpoint = getWebhookEndpointByIdOrSlug(slug)
        if (!endpoint || !endpoint.enabled) {
            return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })
        }

        const rate = checkWebhookRateLimit(endpoint, request)
        if (!rate.ok) {
            return NextResponse.json(
                { error: rate.error ?? 'Rate limited.' },
                {
                    status: rate.status,
                    headers: {
                        ...NO_STORE,
                        ...(rate.retryAfterSeconds ? { 'Retry-After': String(rate.retryAfterSeconds) } : {}),
                    },
                },
            )
        }

        const declaredLength = Number(request.headers.get('content-length') ?? '0')
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
            return NextResponse.json({ error: 'Webhook payload too large.' }, { status: 413, headers: NO_STORE })
        }

        let rawBody: string
        try {
            rawBody = await request.text()
        } catch {
            return NextResponse.json({ error: 'Could not read request body.' }, { status: 400, headers: NO_STORE })
        }
        if (Buffer.byteLength(rawBody, 'utf-8') > MAX_BODY_BYTES) {
            return NextResponse.json({ error: 'Webhook payload too large.' }, { status: 413, headers: NO_STORE })
        }

        const auth = authenticateWebhookRequest(endpoint, request, rawBody)
        if (!auth.ok) {
            return NextResponse.json({ error: auth.error ?? 'Unauthorized.' }, { status: auth.status, headers: NO_STORE })
        }

        let payload: Record<string, unknown>
        try {
            payload = parseJsonPayload(request, rawBody)
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Invalid webhook payload.' },
                { status: 400, headers: NO_STORE },
            )
        }

        const normalized = normalizeWebhookEvent(endpoint, request, payload)
        const dedupeKey = computeWebhookDedupeKey(endpoint, request, rawBody, payload, normalized)
        const { event, duplicate } = createWebhookEvent({
            endpointId: endpoint.id,
            slug: endpoint.slug,
            payload,
            dedupeKey,
            normalized,
        })

        if (duplicate) {
            return NextResponse.json(
                {
                    accepted: true,
                    duplicate: true,
                    eventId: event.id,
                    status: event.status,
                },
                { status: 200, headers: NO_STORE },
            )
        }

        void dispatchWebhookEvent(event.id).catch((err) => {
            setWebhookEventStatus(
                event.id,
                'error',
                err instanceof Error ? err.message : String(err),
            )
        })

        return NextResponse.json(
            {
                accepted: true,
                duplicate: false,
                eventId: event.id,
                eventType: event.eventType,
            },
            { status: 202, headers: NO_STORE },
        )
  })
}

function parseJsonPayload(request: Request, rawBody: string): Record<string, unknown> {
    const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
        throw new Error('Webhook payload must be JSON.')
    }
    const parsed = JSON.parse(rawBody) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Webhook payload must be a JSON object.')
    }
    return parsed as Record<string, unknown>
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || err instanceof SyntaxError
}
