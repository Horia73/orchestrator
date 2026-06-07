import { NextResponse } from "next/server"

import {
  listAdminProfileAuditEvents,
  requireAdminProfile,
} from "@/lib/profiles/server"

export async function GET(request: Request) {
  const current = await requireAdminProfile()
  if (current instanceof NextResponse) return current

  const { searchParams } = new URL(request.url)
  const profileId = searchParams.get("profileId") ?? undefined
  const limitRaw = Number(searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200
  return NextResponse.json({
    events: listAdminProfileAuditEvents({ profileId, limit }),
  })
}
