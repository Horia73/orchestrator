import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    getHomeAssistantActionPolicy,
    getHomeAssistantIntegrationStatus,
    saveHomeAssistantActionPolicy,
} from '@/lib/integrations/home-assistant'
import {
    hasGrantAccess,
    resolveIntegrationConnectionForProfile,
} from '@/lib/integrations/connection-store'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ActionPolicyBodySchema = z.object({
    enabled: z.boolean().optional(),
    directDomains: z.array(z.string()).optional(),
    confirmOtherDomains: z.boolean().optional(),
})

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        return NextResponse.json({ actionMode: getHomeAssistantActionPolicy() })
  })
}

export async function PUT(request: Request) {
  return runWithRequestProfile(request, async (current) => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard
        const connection = resolveIntegrationConnectionForProfile(
            current.profile.id,
            'home_assistant'
        )
        if (connection && !hasGrantAccess(connection.access, 'setup')) {
            return NextResponse.json(
                {
                    error: 'Managing Home Assistant action policy requires Manage access to the selected connection.',
                    code: 'connection_access_denied',
                },
                { status: 403 }
            )
        }

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
            recordIntegrationStatuses({ homeAssistant })
            return NextResponse.json({ success: true, actionMode, homeAssistant })
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Could not update Home Assistant action policy' },
                { status: 400 }
            )
        }
  })
}
