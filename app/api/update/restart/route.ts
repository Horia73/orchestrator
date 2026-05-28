import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { triggerContainerRestart } from '@/lib/update/manager'

export const dynamic = 'force-dynamic'

/** POST /api/update/restart — restart the orchestrator container via the host bridge. */
export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const result = await triggerContainerRestart()
    return NextResponse.json(result, {
        status: result.ok ? 200 : 502,
        headers: { 'Cache-Control': 'no-store' },
    })
}
