import { NextResponse } from 'next/server'

import { getCurrentProfileFromRequest } from '@/lib/profiles/server'
import {
  isOnboardingComplete,
  markOnboardingComplete,
  markOnboardingStarted,
  readOnboardingState,
  writeOnboardingState,
  type OnboardingContext,
} from '@/lib/onboarding/state'

function noStore<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request) {
  const current = getCurrentProfileFromRequest(request)
  if (!current) return noStore({ error: 'Profile required', code: 'profile_required' }, 401)
  const state = readOnboardingState()
  return noStore({
    complete: isOnboardingComplete(),
    isAdmin: current.isAdmin,
    state,
  })
}

export async function POST(request: Request) {
  const current = getCurrentProfileFromRequest(request)
  if (!current) return noStore({ error: 'Profile required', code: 'profile_required' }, 401)
  if (!current.isAdmin) {
    return noStore({ error: 'Only an admin profile can run onboarding.' }, 403)
  }

  let body: {
    action?: 'start' | 'complete' | 'patch'
    step?: string
    skipped?: string[]
    context?: OnboardingContext | null
    reason?: string
  }
  try {
    body = (await request.json()) ?? {}
  } catch {
    body = {}
  }

  const action = body.action ?? 'patch'

  if (action === 'start') {
    return noStore({ state: markOnboardingStarted() })
  }

  if (action === 'complete') {
    return noStore({ state: markOnboardingComplete(body.reason ?? 'wizard', body.context ?? undefined) })
  }

  // patch: persist step / skipped / context as the user moves through the wizard
  const patch: Parameters<typeof writeOnboardingState>[0] = {}
  if (typeof body.step === 'string') patch.step = body.step
  if (Array.isArray(body.skipped)) patch.skipped = body.skipped.filter((s) => typeof s === 'string')
  if (body.context !== undefined) patch.context = body.context
  return noStore({ state: writeOnboardingState(patch) })
}
