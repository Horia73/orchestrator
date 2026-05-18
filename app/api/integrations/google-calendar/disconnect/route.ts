import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectGoogleCalendar } from '@/lib/integrations/google-calendar'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const googleCalendar = await disconnectGoogleCalendar()
        return NextResponse.json({ success: true, googleCalendar })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not disconnect Google Calendar' },
            { status: 500 }
        )
    }
}
