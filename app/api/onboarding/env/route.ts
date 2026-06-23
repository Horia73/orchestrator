import { NextResponse } from 'next/server'

import { getCurrentProfileFromRequest } from '@/lib/profiles/server'
import { ONBOARDING_ENV_ALLOWLIST, setOnboardingEnvValue } from '@/lib/onboarding/env'

function noStore<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const current = getCurrentProfileFromRequest(request)
  if (!current) return noStore({ error: 'Profile required', code: 'profile_required' }, 401)
  if (!current.isAdmin) return noStore({ error: 'Only an admin profile can configure keys.' }, 403)

  let body: { key?: string; value?: string }
  try {
    body = (await request.json()) ?? {}
  } catch {
    body = {}
  }

  const key = typeof body.key === 'string' ? body.key.trim() : ''
  const value = typeof body.value === 'string' ? body.value : ''
  if (!key || !ONBOARDING_ENV_ALLOWLIST.has(key)) {
    return noStore({ error: 'Unsupported key.' }, 400)
  }

  try {
    setOnboardingEnvValue(key, value)
    return noStore({ ok: true })
  } catch (e) {
    return noStore({ error: e instanceof Error ? e.message : 'Failed to save key.' }, 400)
  }
}
