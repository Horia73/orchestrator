import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { revealWorkspaceEnvValue } from '@/lib/settings/workspace-files'

const JSON_HEADERS = {
    'Cache-Control': 'no-store',
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { id } = await params
    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: JSON_HEADERS })
    }

    const key = body && typeof body === 'object' && 'key' in body
        ? (body as { key?: unknown }).key
        : undefined
    const occurrence = body && typeof body === 'object' && 'occurrence' in body
        ? (body as { occurrence?: unknown }).occurrence
        : 0

    if (typeof key !== 'string' || !key.trim()) {
        return NextResponse.json({ error: 'Missing env var name' }, { status: 400, headers: JSON_HEADERS })
    }
    if (occurrence !== undefined && typeof occurrence !== 'number') {
        return NextResponse.json({ error: 'Invalid env var occurrence' }, { status: 400, headers: JSON_HEADERS })
    }
    const numericOccurrence = typeof occurrence === 'number' ? occurrence : 0

    try {
        const value = revealWorkspaceEnvValue(id, key.trim(), numericOccurrence)
        if (!value) return NextResponse.json({ error: 'Env var not found' }, { status: 404, headers: JSON_HEADERS })
        return NextResponse.json(value, { headers: JSON_HEADERS })
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to reveal env var' },
            { status: 400, headers: JSON_HEADERS }
        )
    }
}
