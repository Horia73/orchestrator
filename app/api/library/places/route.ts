import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { listLocationPlaceDays } from "@/lib/location-intelligence/journal"
import type { LocationPlacesList } from "@/lib/location-intelligence/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export type LibraryPlacesResponse = LocationPlacesList

export async function GET(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const url = new URL(request.url)
  const limit = Math.max(
    1,
    Math.min(365, Number.parseInt(url.searchParams.get("limit") ?? "60", 10) || 60)
  )

  try {
    const body = await listLocationPlaceDays(limit)
    return NextResponse.json(body, { headers: NO_STORE })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Location Intelligence journal.",
      },
      { status: 500, headers: NO_STORE }
    )
  }
}
