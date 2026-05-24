import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  deleteSavedMapArea,
  getSavedMapArea,
  updateSavedMapArea,
  type SavedMapAreaUpdateInput,
} from "@/lib/maps/saved-areas"
import type { MapCoordinate } from "@/lib/maps/schema"

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
  const area = getSavedMapArea(id)
  if (!area) {
    return NextResponse.json(
      { error: "Saved area not found." },
      { status: 404, headers: NO_STORE }
    )
  }
  return NextResponse.json({ area }, { headers: NO_STORE })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const { id } = await params
  if (!deleteSavedMapArea(id)) {
    return NextResponse.json(
      { error: "Saved area not found." },
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

  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Body must be a JSON object." },
        { status: 400, headers: NO_STORE }
      )
    }

    const input: SavedMapAreaUpdateInput = {}
    if ("title" in body) input.title = optionalStringOrNull(body.title)
    if ("description" in body) {
      input.description = optionalStringOrNull(body.description)
    }
    if ("color" in body) input.color = optionalStringOrNull(body.color)
    if ("notes" in body) input.notes = optionalStringOrNull(body.notes)
    if ("ring" in body) {
      const ring = parseRing(body.ring)
      if (!ring) {
        return NextResponse.json(
          { error: "ring must be an array of [lng, lat] coordinates." },
          { status: 400, headers: NO_STORE }
        )
      }
      input.ring = ring
    }

    const { id } = await params
    const area = updateSavedMapArea(id, input)
    if (!area) {
      return NextResponse.json(
        { error: "Saved area not found." },
        { status: 404, headers: NO_STORE }
      )
    }
    return NextResponse.json({ area }, { headers: NO_STORE })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update area."
    return NextResponse.json(
      { error: message },
      { status: 400, headers: NO_STORE }
    )
  }
}

function optionalStringOrNull(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === "string") return value
  throw new Error("Field must be a string or null.")
}

function parseRing(value: unknown): MapCoordinate[] | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const ring: MapCoordinate[] = []
  for (const coord of value) {
    const parsed = parsePosition(coord)
    if (!parsed) return null
    ring.push(parsed)
  }
  return ring
}

function parsePosition(value: unknown): MapCoordinate | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [lng, lat] = value
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    return null
  }
  return [lng, lat]
}
