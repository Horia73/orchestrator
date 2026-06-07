import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { geocodeAddresses } from "@/lib/maps/google-geocoding"
import {
  getPlaceDetails,
  searchPlaces,
  type PlaceResult,
} from "@/lib/maps/google-places"
import type { MapCoordinate } from "@/lib/maps/schema"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

interface UiMapSearchResult {
  id: string
  title: string
  address: string | null
  position: MapCoordinate
  rating: number | null
  photoUrl: string | null
  googleMapsUri: string | null
  provider: "google-places" | "google-geocoding"
}

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      const url = new URL(request.url)
      const query = (url.searchParams.get("q") ?? "").trim()
      const placeId = (url.searchParams.get("placeId") ?? "").trim()
      if (!query && !placeId) {
        return NextResponse.json(
          { error: "Missing search query or placeId." },
          { status: 400, headers: NO_STORE }
        )
      }

      const center = parseCenter(url.searchParams.get("center"))
      const languageCode = cleanParam(url.searchParams.get("language"))
      const sessionToken = cleanParam(url.searchParams.get("sessionToken"))

      try {
        if (placeId) {
          const place = await getPlaceDetails(placeId, {
            languageCode,
            sessionToken,
            includePhoto: false,
          })
          return NextResponse.json(
            {
              results: [placeToUiResult(place)],
            },
            { headers: NO_STORE }
          )
        }

        const places = await searchPlaces({
          mode: "text",
          query: query.slice(0, 180),
          center,
          radiusMeters: center ? 12_000 : undefined,
          maxResults: 7,
          includeRatings: true,
          languageCode,
        })

        return NextResponse.json(
          {
            results: places.places.map(placeToUiResult),
          },
          { headers: NO_STORE }
        )
      } catch (placesError) {
        if (!query) {
          return NextResponse.json(
            {
              error:
                placesError instanceof Error
                  ? placesError.message
                  : "Place lookup failed.",
            },
            { status: 502, headers: NO_STORE }
          )
        }
        const geocoded = await geocodeAddresses([query], { concurrency: 1 })
        const first = geocoded[0]
        if (!first || "error" in first) {
          return NextResponse.json(
            {
              error:
                first?.error ??
                (placesError instanceof Error
                  ? placesError.message
                  : "Search failed."),
            },
            { status: 502, headers: NO_STORE }
          )
        }

        return NextResponse.json(
          {
            results: [
              {
                id: first.placeId ?? stableSearchId(first.formattedAddress),
                title: shortAddressTitle(first.formattedAddress),
                address: first.formattedAddress,
                position: first.position,
                rating: null,
                photoUrl: null,
                googleMapsUri: null,
                provider: "google-geocoding",
              } satisfies UiMapSearchResult,
            ],
          },
          { headers: NO_STORE }
        )
      }
  })
}

function placeToUiResult(place: PlaceResult): UiMapSearchResult {
  return {
    id: place.id,
    title: place.displayName,
    address: place.shortFormattedAddress ?? place.formattedAddress,
    position: place.position,
    rating: place.rating,
    photoUrl: place.photoUrl,
    googleMapsUri: place.googleMapsUri,
    provider: "google-places",
  }
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

function shortAddressTitle(value: string): string {
  return value.split(",")[0]?.trim() || value
}

function stableSearchId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "search-result"
  )
}
