import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getGmailIntegrationStatus } from '@/lib/integrations/gmail'
import { getGoogleCalendarIntegrationStatus } from '@/lib/integrations/google-calendar'
import { getGoogleDriveIntegrationStatus } from '@/lib/integrations/google-drive'
import { getHomeAssistantIntegrationStatus } from '@/lib/integrations/home-assistant'
import { getWhatsAppIntegrationStatus } from '@/lib/integrations/whatsapp'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'
import { getRuntimeAccessInfo } from '@/lib/runtime-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const origin = resolveRequestOrigin(request)
    const [gmail, googleCalendar, googleDrive, whatsapp, homeAssistant, runtime] = await Promise.all([
        getGmailIntegrationStatus(origin, true),
        getGoogleCalendarIntegrationStatus(origin, true),
        getGoogleDriveIntegrationStatus(origin, true),
        getWhatsAppIntegrationStatus(origin),
        getHomeAssistantIntegrationStatus(true),
        getRuntimeAccessInfo(origin),
    ])
    // Warm the prompt-side snapshot so the next agent turn reflects reality
    // without paying for its own async status round-trip.
    recordIntegrationStatuses({ gmail, googleCalendar, googleDrive, whatsapp, homeAssistant })
    return NextResponse.json({ gmail, googleCalendar, googleDrive, whatsapp, homeAssistant, runtime })
}
