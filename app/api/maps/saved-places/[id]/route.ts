import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  deleteSavedMapPlace,
  getSavedMapPlace,
  updateSavedMapPlaceNotes,
} from "@/lib/maps/saved-places"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const { id } = await params
  const place = getSavedMapPlace(id)
  if (!place) {
    return NextResponse.json(
      { error: "Saved place not found." },
      { status: 404, headers: NO_STORE }
    )
  }
  return NextResponse.json({ place }, { headers: NO_STORE })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const { id } = await params
  if (!deleteSavedMapPlace(id)) {
    return NextResponse.json(
      { error: "Saved place not found." },
      { status: 404, headers: NO_STORE }
    )
  }
  return NextResponse.json({ deleted: true }, { headers: NO_STORE })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Body must be a JSON object." },
      { status: 400, headers: NO_STORE }
    )
  }
  if (body.notes !== null && typeof body.notes !== "string") {
    return NextResponse.json(
      { error: "notes must be a string or null." },
      { status: 400, headers: NO_STORE }
    )
  }

  const { id } = await params
  const place = updateSavedMapPlaceNotes(id, body.notes)
  if (!place) {
    return NextResponse.json(
      { error: "Saved place not found." },
      { status: 404, headers: NO_STORE }
    )
  }
  return NextResponse.json({ place }, { headers: NO_STORE })
}
