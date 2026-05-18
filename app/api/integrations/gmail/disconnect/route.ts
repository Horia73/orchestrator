import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectGmail } from '@/lib/integrations/gmail'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const origin = resolveRequestOrigin(request)
        await disconnectGmail(origin)
        return NextResponse.json({ success: true })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not disconnect Gmail' },
            { status: 500 }
        )
    }
}
