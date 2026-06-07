import { NextResponse } from 'next/server'

import { getUpdateStatus } from '@/lib/update/manager'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const refresh = url.searchParams.get('refresh') === '1'
        const status = await getUpdateStatus({ refresh })
        return NextResponse.json(status, {
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}
