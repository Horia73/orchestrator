import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  addSavedMapArea,
  listSavedMapAreas,
  type SavedMapAreaInput,
} from "@/lib/maps/saved-areas"
import type { MapCoordinate } from "@/lib/maps/schema"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      const url = new URL(request.url)
      const limit = clampLimit(url.searchParams.get("limit"))
      return NextResponse.json(
        { areas: listSavedMapAreas(limit) },
        { headers: NO_STORE }
      )
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
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

        const ring = parseRing(body.ring)
        if (!ring) {
          return NextResponse.json(
            { error: "ring must be an array of [lng, lat] coordinates." },
            { status: 400, headers: NO_STORE }
          )
        }

        const input: SavedMapAreaInput = {
          title: optionalString(body.title),
          description: optionalString(body.description),
          ring,
          color: optionalString(body.color),
          notes: optionalString(body.notes),
        }

        const area = addSavedMapArea(input)
        return NextResponse.json({ area }, { headers: NO_STORE })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save area."
        return NextResponse.json(
          { error: message },
          { status: 400, headers: NO_STORE }
        )
      }
  })
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
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

function clampLimit(value: string | null): number {
  const raw = Number(value ?? DEFAULT_LIMIT)
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)))
}
