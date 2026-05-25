import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { queueUpdate } from '@/lib/update/manager'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const body = await request.json().catch(() => null) as {
            mode?: unknown
            branch?: unknown
        } | null
        const status = await queueUpdate({
            mode: body?.mode === 'branch' ? 'branch' : 'release',
            branch: typeof body?.branch === 'string' ? body.branch : undefined,
        })
        return NextResponse.json(status, {
            headers: { 'Cache-Control': 'no-store' },
        })
    } catch (err) {
        return NextResponse.json({
            error: err instanceof Error ? err.message : 'Failed to queue update.',
        }, {
            status: 409,
            headers: { 'Cache-Control': 'no-store' },
        })
    }
}
