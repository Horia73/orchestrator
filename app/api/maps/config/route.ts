import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getEnvValue } from '@/lib/config'
import { readGoogleMapsApiKey } from '@/lib/maps/google-session'

const NO_STORE = { 'Cache-Control': 'no-store' }

// ---------------------------------------------------------------------------
// GET /api/maps/config
//
// Returns the client-side bootstrap config the map iframe needs to load
// Google Maps JavaScript API: the API key + a `mapId` (required by
// Advanced Markers). Exposing a Google Maps JavaScript key to authenticated
// browser sessions is the designed flow — same as embedding it in a
// NEXT_PUBLIC_* var, just with a single source of truth (the server's env).
//
// Returns 503 with a clear actionable message when the key isn't set,
// so the renderer can show "Maps backend is not configured" instead of
// silently loading Google JS with an empty key.
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const key = readGoogleMapsApiKey()
    if (!key) {
        return NextResponse.json(
            {
                configured: false,
                error: 'GOOGLE_MAPS_API_KEY is not set. See INTEGRATIONS/maps.md for the GCP setup steps.',
            },
            { status: 503, headers: NO_STORE },
        )
    }
    const customMapId = getEnvValue('GOOGLE_MAPS_MAP_ID')
    return NextResponse.json({
        configured: true,
        key,
        // Google's universal demo mapId — works without per-user Cloud
        // Console setup and is enough for Advanced Markers + styles.
        // The user can override later by setting GOOGLE_MAPS_MAP_ID in
        // their env to a custom mapId from their GCP project with
        // bespoke styling.
        mapId: customMapId || 'DEMO_MAP_ID',
        mapIdSource: customMapId ? 'env' : 'demo',
        earth3d: {
            readyToTry: true,
            channel: 'beta',
        },
    }, { headers: NO_STORE })
}
