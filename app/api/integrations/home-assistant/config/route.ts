import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { saveHomeAssistantConfig } from '@/lib/integrations/home-assistant'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ConfigBodySchema = z.object({
    baseUrl: z.string().optional(),
    token: z.string().optional(),
    rawEnv: z.string().optional(),
})

export async function PUT(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = ConfigBodySchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid Home Assistant config', issues: parsed.error.issues }, { status: 400 })
    }

    try {
        const homeAssistant = await saveHomeAssistantConfig(parsed.data)
        recordIntegrationStatuses({ homeAssistant })
        return NextResponse.json({
            success: true,
            verified: homeAssistant.connected,
            homeAssistant,
        })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not save Home Assistant config' },
            { status: 400 }
        )
    }
}
