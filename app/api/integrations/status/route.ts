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

    // Smart Monitor integration-install offer check — fire-and-forget so we
    // don't extend the status response time. Idempotent via a persisted
    // per-integration fingerprint, so polling does not duplicate offers.
    // Hooking here (vs. the individual connect endpoints) cleanly covers
    // WhatsApp's async "ready" event: the UI polls /api/integrations/status
    // while a connection is in progress, and the FIRST poll after ready
    // posts the offer.
    void import('@/lib/monitoring/smart-monitor-offer').then((mod) =>
        mod.maybeOfferSmartMonitor({ gmail, homeAssistant, whatsapp })
    ).catch((err) => console.warn('[smart-monitor-offer] background check failed', err))

    return NextResponse.json({ gmail, googleCalendar, googleDrive, whatsapp, homeAssistant, runtime })
}
