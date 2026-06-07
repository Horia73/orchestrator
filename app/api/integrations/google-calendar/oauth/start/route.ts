import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { startGoogleCalendarOAuth } from '@/lib/integrations/google-calendar'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const origin = resolveRequestOrigin(request)
            return NextResponse.json(startGoogleCalendarOAuth(origin))
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Could not start Google Calendar OAuth' },
                { status: 400 }
            )
        }
  })
}
