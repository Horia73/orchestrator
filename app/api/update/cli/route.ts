import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { triggerCliUpdate } from '@/lib/update/manager'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

/** POST /api/update/cli — update Codex CLI in the container, then restart. */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const result = await triggerCliUpdate()
        return NextResponse.json(result, {
            status: result.ok ? 200 : 502,
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}
