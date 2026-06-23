import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { setupHttps } from '@/lib/remote-access/manager'
import { getCurrentProfileFromRequest, runWithRequestProfile } from '@/lib/profiles/server'

export const dynamic = 'force-dynamic'

/** POST /api/remote-access/https — provision public HTTPS (DuckDNS) via the host bridge. */
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

    let body: { domain?: string; token?: string; email?: string }
    try {
      body = (await request.json()) ?? {}
    } catch {
      body = {}
    }

    const domain = typeof body.domain === 'string' ? body.domain.trim() : ''
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!domain || !token) {
      return NextResponse.json(
        { error: 'A DuckDNS domain and token are required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const result = await setupHttps({ domain, token, email })
    return NextResponse.json(result, {
      status: result.ok ? 200 : 502,
      headers: { 'Cache-Control': 'no-store' },
    })
  })
}
