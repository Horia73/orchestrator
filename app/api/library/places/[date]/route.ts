import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getLocationPlaceDay } from "@/lib/location-intelligence/journal"
import type { LocationPlacesDayResponse } from "@/lib/location-intelligence/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export type LibraryPlaceDayResponse = LocationPlacesDayResponse

export async function GET(
  request: Request,
  { params }: { params: Promise<{ date: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const { date } = await params
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "Invalid date." },
      { status: 400, headers: NO_STORE }
    )
  }

  try {
    const body = await getLocationPlaceDay(date)
    if (!body.day) {
      return NextResponse.json(body, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json(body, { headers: NO_STORE })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Location Intelligence day.",
      },
      { status: 500, headers: NO_STORE }
    )
  }
}
