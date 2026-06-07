import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    createWebhookEndpoint,
    listWebhookEndpoints,
    toPublicWebhookEndpoint,
} from '@/lib/webhooks/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const endpoints = listWebhookEndpoints().map(toPublicWebhookEndpoint)
            return NextResponse.json({ endpoints }, { headers: NO_STORE })
        } catch (err) {
            console.error('Failed to list webhooks', err)
            return NextResponse.json({ error: 'Failed to list webhooks.' }, { status: 500, headers: NO_STORE })
        }
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const body = await request.json()
            const { endpoint, generatedSecret } = createWebhookEndpoint(body, 'user')
            return NextResponse.json(
                {
                    endpoint: toPublicWebhookEndpoint(endpoint),
                    ...(generatedSecret ? { secret: generatedSecret } : {}),
                },
                { headers: NO_STORE },
            )
        } catch (err) {
            const status = isBadInput(err) ? 400 : 500
            if (status === 500) console.error('Failed to create webhook', err)
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Failed to create webhook.' },
                { status, headers: NO_STORE },
            )
        }
  })
}

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || err instanceof SyntaxError
}
