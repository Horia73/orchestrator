import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { factoryResetAppData } from '@/lib/settings/factory-reset'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        body = {}
    }

    const confirm = body && typeof body === 'object' && 'confirm' in body
        ? (body as { confirm?: unknown }).confirm
        : null
    if (confirm !== 'factory-reset') {
        return NextResponse.json(
            { error: 'Missing factory reset confirmation.' },
            { status: 400, headers: { 'Cache-Control': 'no-store' } }
        )
    }

    const preserveEnvLocal = body && typeof body === 'object' && 'preserveEnvLocal' in body
        ? (body as { preserveEnvLocal?: unknown }).preserveEnvLocal !== false
        : true

    try {
        const result = factoryResetAppData({ preserveEnvLocal })
        return NextResponse.json(
            { success: true, ...result },
            { headers: { 'Cache-Control': 'no-store' } }
        )
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Factory reset failed.' },
            { status: 500, headers: { 'Cache-Control': 'no-store' } }
        )
    }
}
