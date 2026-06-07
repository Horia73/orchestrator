import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getWeatherIntegrationStatus } from '@/lib/integrations/weather'
import { getMapsIntegrationConfigSummary, saveGoogleMapsConfig } from '@/lib/integrations/maps'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const ConfigBodySchema = z.object({
    apiKey: z.string().optional(),
    mapId: z.string().optional(),
    rawEnv: z.string().optional(),
})

export function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    return NextResponse.json(
        { maps: getMapsIntegrationConfigSummary() },
        { headers: NO_STORE },
    )
}

export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
        }

        const parsed = ConfigBodySchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ error: 'Invalid Google Maps config', issues: parsed.error.issues }, { status: 400, headers: NO_STORE })
        }

        try {
            const maps = await saveGoogleMapsConfig(parsed.data)
            const weather = await getWeatherIntegrationStatus(false)
            recordIntegrationStatuses({ maps, weather })
            return NextResponse.json({
                success: true,
                maps,
                weather,
            }, { headers: NO_STORE })
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Could not save Google Maps config' },
                { status: 400, headers: NO_STORE }
            )
        }
  })
}
