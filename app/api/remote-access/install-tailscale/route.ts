import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { installTailscale } from '@/lib/remote-access/manager'
import { getCurrentProfileFromRequest, runWithRequestProfile } from '@/lib/profiles/server'

export const dynamic = 'force-dynamic'

/** POST /api/remote-access/install-tailscale — best-effort install via host bridge. */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const current = getCurrentProfileFromRequest(request)
    if (!current?.isAdmin) {
      return NextResponse.json(
        { error: 'Admin profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const result = await installTailscale()
    return NextResponse.json(result, {
      status: result.ok ? 200 : 502,
      headers: { 'Cache-Control': 'no-store' },
    })
  })
}
