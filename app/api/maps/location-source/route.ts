import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    clearHomeAssistantLocationSource,
    getConfiguredHomeAssistantLocationSource,
    listHomeAssistantLocationCandidates,
    resolveCurrentMapLocation,
    saveHomeAssistantLocationSource,
    validateHomeAssistantLocationEntity,
} from '@/lib/maps/current-location'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const url = new URL(request.url)
    const includeCandidates = url.searchParams.get('candidates') === '1'
    const source = getConfiguredHomeAssistantLocationSource()

    if (!includeCandidates) {
        return NextResponse.json(
            { source },
            { headers: NO_STORE },
        )
    }

    try {
        const candidates = await listHomeAssistantLocationCandidates()
        return NextResponse.json(
            { source, candidates },
            { headers: NO_STORE },
        )
    } catch (err) {
        return NextResponse.json(
            {
                source,
                candidates: [],
                candidatesError: err instanceof Error ? err.message : 'Could not read Home Assistant entities.',
            },
            { headers: NO_STORE },
        )
    }
}

export async function PUT(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400, headers: NO_STORE })
    }

    if (!isRecord(body)) {
        return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400, headers: NO_STORE })
    }

    const provider = typeof body.provider === 'string' ? body.provider : 'home-assistant'
    const entityId = typeof body.entityId === 'string' ? body.entityId : ''
    const label = typeof body.label === 'string' ? body.label : null
    if (provider !== 'home-assistant') {
        return NextResponse.json({ error: 'Only provider "home-assistant" is supported.' }, { status: 400, headers: NO_STORE })
    }

    try {
        const validated = await validateHomeAssistantLocationEntity(entityId)
        const source = saveHomeAssistantLocationSource({
            entityId,
            label: label || validated.location.label,
        })
        const location = await resolveCurrentMapLocation()
        return NextResponse.json(
            { source, location },
            { headers: NO_STORE },
        )
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not save Home Assistant location source.' },
            { status: 400, headers: NO_STORE },
        )
    }
}

export async function DELETE(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    clearHomeAssistantLocationSource()
    const location = await resolveCurrentMapLocation()
    return NextResponse.json(
        { source: null, location },
        { headers: NO_STORE },
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
