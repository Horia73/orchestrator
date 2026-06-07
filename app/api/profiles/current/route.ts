import { NextResponse } from "next/server"

import {
  getCurrentProfileFromRequest,
  publicProfile,
} from "@/lib/profiles/server"

export async function GET(request: Request) {
  const current = getCurrentProfileFromRequest(request)
  if (!current) {
    return NextResponse.json(
      { profile: null, isAdmin: false },
      { headers: { "Cache-Control": "no-store" } }
    )
  }
  return NextResponse.json(
    {
      profile: publicProfile(current.profile),
      permissions: current.profile.permissions,
      isAdmin: current.isAdmin,
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
