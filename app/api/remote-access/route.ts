import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { getRuntimeAccessInfo } from '@/lib/runtime-access'
import { getRemoteAccessStatus } from '@/lib/remote-access/manager'
import { getCurrentProfileFromRequest, runWithRequestProfile } from '@/lib/profiles/server'

export const dynamic = 'force-dynamic'

/** GET /api/remote-access — local connectivity picture + Tailscale/bridge state. */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
    const current = getCurrentProfileFromRequest(request)
    if (!current?.isAdmin) {
      return NextResponse.json(
        { error: 'Admin profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    const origin = resolveRequestOrigin(request)
    const [access, bridge] = await Promise.all([getRuntimeAccessInfo(origin), getRemoteAccessStatus()])
    return NextResponse.json({ access, bridge }, { headers: { 'Cache-Control': 'no-store' } })
  })
}
