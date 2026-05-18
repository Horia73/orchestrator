import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    getHomeAssistantActionPolicy,
    getHomeAssistantIntegrationStatus,
    saveHomeAssistantActionPolicy,
} from '@/lib/integrations/home-assistant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ActionPolicyBodySchema = z.object({
    enabled: z.boolean().optional(),
    directDomains: z.array(z.string()).optional(),
    confirmOtherDomains: z.boolean().optional(),
})

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    return NextResponse.json({ actionMode: getHomeAssistantActionPolicy() })
}

export async function PUT(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = ActionPolicyBodySchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid Home Assistant action policy', issues: parsed.error.issues }, { status: 400 })
    }

    try {
        const actionMode = saveHomeAssistantActionPolicy(parsed.data)
        const homeAssistant = await getHomeAssistantIntegrationStatus(true)
        return NextResponse.json({ success: true, actionMode, homeAssistant })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not update Home Assistant action policy' },
            { status: 400 }
        )
    }
}
