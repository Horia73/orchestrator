import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { triggerRollback } from '@/lib/update/manager'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

/** POST /api/update/rollback — switch to the cached previous Docker image via the host bridge. */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const result = await triggerRollback()
        return NextResponse.json(result, {
            status: result.ok ? 200 : 502,
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}
