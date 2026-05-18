import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { startGmailOAuth } from '@/lib/integrations/gmail'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const origin = resolveRequestOrigin(request)
        return NextResponse.json(startGmailOAuth(origin))
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not start Gmail OAuth' },
            { status: 400 }
        )
    }
}
