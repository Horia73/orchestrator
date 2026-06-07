import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    getWebhookEndpointByIdOrSlug,
    listWebhookDispatches,
    listWebhookEvents,
} from '@/lib/webhooks/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { slug } = await params
        const endpoint = getWebhookEndpointByIdOrSlug(slug)
        if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404, headers: NO_STORE })

        const url = new URL(request.url)
        const limit = Math.floor(Number(url.searchParams.get('limit')) || 100)
        const includeDispatches = url.searchParams.get('dispatches') === '1'
        const events = listWebhookEvents(endpoint.id, limit)

        return NextResponse.json(
            {
                events: includeDispatches
                    ? events.map((event) => ({ ...event, dispatches: listWebhookDispatches(event.id) }))
                    : events,
            },
            { headers: NO_STORE },
        )
  })
}
