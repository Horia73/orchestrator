import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectHomeAssistant } from '@/lib/integrations/home-assistant'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const homeAssistant = await disconnectHomeAssistant()
            recordIntegrationStatuses({ homeAssistant })
            return NextResponse.json({ success: true, homeAssistant })
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Could not disconnect Home Assistant' },
                { status: 400 }
            )
        }
  })
}
