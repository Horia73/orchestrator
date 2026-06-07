import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { resolveCurrentMapLocation } from '@/lib/maps/current-location'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const location = await resolveCurrentMapLocation()
        return NextResponse.json(
            { location },
            { headers: { 'Cache-Control': 'no-store' } },
        )
  })
}
