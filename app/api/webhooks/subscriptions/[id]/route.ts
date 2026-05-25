import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    deleteWebhookSubscription,
    getWebhookSubscription,
    updateWebhookSubscription,
} from '@/lib/webhooks/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { id } = await params
    const subscription = getWebhookSubscription(id)
    if (!subscription) return NextResponse.json({ error: 'Subscription not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ subscription }, { headers: NO_STORE })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const { id } = await params
        const body = await request.json()
        const subscription = updateWebhookSubscription(id, body)
        if (!subscription) return NextResponse.json({ error: 'Subscription not found.' }, { status: 404, headers: NO_STORE })
        return NextResponse.json({ subscription }, { headers: NO_STORE })
    } catch (err) {
        const status = isBadInput(err) ? 400 : 500
        if (status === 500) console.error('Failed to update webhook subscription', err)
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to update webhook subscription.' },
            { status, headers: NO_STORE },
        )
    }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { id } = await params
    const ok = deleteWebhookSubscription(id)
    if (!ok) return NextResponse.json({ error: 'Subscription not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ success: true }, { headers: NO_STORE })
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || err instanceof SyntaxError
}
