import { NextResponse } from 'next/server'

import { listApps } from '@/lib/apps/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/** GET /api/apps — all registered internal apps, most recently updated first. */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        return NextResponse.json({ apps: listApps() })
  })
}
