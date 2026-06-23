import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { setWebhookFunnel } from '@/lib/remote-access/manager'
import { getCurrentProfileFromRequest, runWithRequestProfile } from '@/lib/profiles/server'

export const dynamic = 'force-dynamic'

/** POST /api/remote-access/funnel — toggle the public webhook funnel (Tailscale). */
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

    let body: { enable?: boolean }
    try {
      body = (await request.json()) ?? {}
    } catch {
      body = {}
    }

    const result = await setWebhookFunnel(body.enable === true)
    return NextResponse.json(result, {
      status: result.ok ? 200 : 502,
      headers: { 'Cache-Control': 'no-store' },
    })
  })
}
