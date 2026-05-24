import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  addSavedMapPlace,
  listSavedMapPlaces,
  type SavedMapPlaceInput,
} from "@/lib/maps/saved-places"
import type { MapCoordinate } from "@/lib/maps/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export async function GET(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const url = new URL(request.url)
  const limit = clampLimit(url.searchParams.get("limit"))
  return NextResponse.json(
    { places: listSavedMapPlaces(limit) },
    { headers: NO_STORE }
  )
}

export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Body must be a JSON object." },
        { status: 400, headers: NO_STORE }
      )
    }

    const position = parsePosition(body.position)
    if (!position) {
      return NextResponse.json(
        { error: "position must be [lng, lat]." },
        { status: 400, headers: NO_STORE }
      )
    }

    const input: SavedMapPlaceInput = {
      title: typeof body.title === "string" ? body.title : "",
      address: optionalString(body.address),
      description: optionalString(body.description),
      position,
      placeId: optionalString(body.placeId),
      googleMapsUri: optionalString(body.googleMapsUri),
      websiteUri: optionalString(body.websiteUri),
      sourceUrl: optionalString(body.sourceUrl),
      photoUrl: optionalString(body.photoUrl),
      rating: optionalNumber(body.rating),
      userRatingCount: optionalNumber(body.userRatingCount),
      openNow: typeof body.openNow === "boolean" ? body.openNow : null,
      phoneNumber: optionalString(body.phoneNumber),
      notes: optionalString(body.notes),
    }

    const place = addSavedMapPlace(input)
    return NextResponse.json({ place }, { headers: NO_STORE })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save place."
    return NextResponse.json(
      { error: message },
      { status: 400, headers: NO_STORE }
    )
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
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

function clampLimit(value: string | null): number {
  const raw = Number(value ?? DEFAULT_LIMIT)
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)))
}
