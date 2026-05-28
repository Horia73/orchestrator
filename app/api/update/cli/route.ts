import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { triggerCliUpdate } from '@/lib/update/manager'

export const dynamic = 'force-dynamic'

/** POST /api/update/cli — update claude-code + codex in the container, then restart. */
export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const result = await triggerCliUpdate()
    return NextResponse.json(result, {
        status: result.ok ? 200 : 502,
        headers: { 'Cache-Control': 'no-store' },
    })
}
