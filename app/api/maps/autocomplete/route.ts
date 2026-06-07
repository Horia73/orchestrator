import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { autocompletePlaces } from "@/lib/maps/google-places"
import type { MapCoordinate } from "@/lib/maps/schema"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

interface UiMapSearchSuggestion {
  id: string
  title: string
  subtitle: string | null
  query: string
  placeId: string | null
  kind: "place" | "query"
  provider: "google-places-autocomplete"
}

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      const url = new URL(request.url)
      const input = (url.searchParams.get("q") ?? "").trim()
      if (input.length < 2) {
        return NextResponse.json(
          { suggestions: [] },
          { headers: NO_STORE }
        )
      }

      try {
        const result = await autocompletePlaces({
          input,
          center: parseCenter(url.searchParams.get("center")),
          radiusMeters: 12_000,
          includeQueryPredictions: true,
          languageCode: cleanParam(url.searchParams.get("language")),
          sessionToken: cleanParam(url.searchParams.get("sessionToken")),
        })

        return NextResponse.json(
          {
            suggestions: result.suggestions.map(
              (suggestion): UiMapSearchSuggestion => ({
                id: suggestion.id,
                title: suggestion.mainText,
                subtitle: suggestion.secondaryText,
                query: suggestion.text,
                placeId: suggestion.placeId,
                kind: suggestion.kind,
                provider: "google-places-autocomplete",
              })
            ),
          },
          { headers: NO_STORE }
        )
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Autocomplete failed." },
          { status: 502, headers: NO_STORE }
        )
      }
  })
}

function parseCenter(value: string | null): MapCoordinate | undefined {
  if (!value) return undefined
  const [lngRaw, latRaw] = value.split(",")
  const lng = Number(lngRaw)
  const lat = Number(latRaw)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return undefined
  return [lng, lat]
}

function cleanParam(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
