import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getMicroscript } from '@/lib/microscripts/store'
import {
    createWebhookSubscription,
    getWebhookEndpointByIdOrSlug,
    listWebhookSubscriptions,
} from '@/lib/webhooks/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { slug } = await params
    const endpoint = getWebhookEndpointByIdOrSlug(slug)
    if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })

    return NextResponse.json(
        { subscriptions: listWebhookSubscriptions(endpoint.id) },
        { headers: NO_STORE },
    )
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const { slug } = await params
        const endpoint = getWebhookEndpointByIdOrSlug(slug)
        if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })

        const body = await request.json()
        if (body?.targetKind === 'microscript' && typeof body.targetId === 'string' && !getMicroscript(body.targetId)) {
            return NextResponse.json({ error: `Microscript ${body.targetId} not found.` }, { status: 400, headers: NO_STORE })
        }

        const subscription = createWebhookSubscription({
            ...body,
            endpointId: endpoint.id,
        })
        return NextResponse.json({ subscription }, { headers: NO_STORE })
    } catch (err) {
        const status = isBadInput(err) ? 400 : 500
        if (status === 500) console.error('Failed to create webhook subscription', err)
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to create webhook subscription.' },
            { status, headers: NO_STORE },
        )
    }
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || err instanceof SyntaxError
}
