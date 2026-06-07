import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  computeDirections,
  type MapsRouteWaypoint,
  type MapsTravelMode,
} from "@/lib/maps/google-routes"
import type { MapCoordinate } from "@/lib/maps/schema"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

interface DirectionsRequestBody {
  origin?: unknown
  destination?: unknown
  waypoints?: unknown
  travelMode?: unknown
  languageCode?: unknown
  regionCode?: unknown
}

const MAX_DIRECTIONS_WAYPOINTS = 25

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      let body: DirectionsRequestBody
      try {
        body = (await request.json()) as DirectionsRequestBody
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body." },
          { status: 400, headers: NO_STORE }
        )
      }

      const waypointsResult = parseDirectionsWaypoints(body)
      if ("error" in waypointsResult) {
        return NextResponse.json(
          { error: waypointsResult.error },
          { status: 400, headers: NO_STORE }
        )
      }

      const travelMode = parseTravelMode(body.travelMode)
      if (body.travelMode !== undefined && !travelMode) {
        return NextResponse.json(
          {
            error:
              "travelMode must be one of driving, walking, bicycling, transit, two_wheeler.",
          },
          { status: 400, headers: NO_STORE }
        )
      }

      try {
        const result = await computeDirections(waypointsResult.waypoints, {
          travelMode: travelMode ?? "driving",
          languageCode: stringOption(body.languageCode),
          regionCode: stringOption(body.regionCode),
        })
        const best = result.routes[0]
        if (!best) {
          return NextResponse.json(
            { error: "Routes API returned no route." },
            { status: 502, headers: NO_STORE }
          )
        }
        return NextResponse.json(
          {
            route: best.mapRoute,
            fitBounds: best.fitBounds,
            distanceMeters: best.distanceMeters,
            durationSeconds: best.durationSeconds,
            durationText: best.durationText,
            waypointCount: waypointsResult.waypoints.length,
          },
          {
            headers: NO_STORE,
          }
        )
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Directions failed." },
          { status: 502, headers: NO_STORE }
        )
      }
  })
}

function parseDirectionsWaypoints(
  body: DirectionsRequestBody
): { waypoints: MapsRouteWaypoint[] } | { error: string } {
  if (body.waypoints !== undefined) {
    if (!Array.isArray(body.waypoints)) {
      return {
        error:
          "waypoints must be an array of [lng, lat] pairs or { position, placeId } objects.",
      }
    }
    if (body.waypoints.length < 2) {
      return { error: "waypoints must include at least two coordinates." }
    }
    if (body.waypoints.length > MAX_DIRECTIONS_WAYPOINTS) {
      return {
        error: `waypoints accepts at most ${MAX_DIRECTIONS_WAYPOINTS} coordinates.`,
      }
    }

    const waypoints: MapsRouteWaypoint[] = []
    for (let index = 0; index < body.waypoints.length; index++) {
      const waypoint = parseDirectionsWaypoint(
        body.waypoints[index],
        `waypoints.${index}`
      )
      if ("error" in waypoint) return waypoint
      waypoints.push(waypoint.waypoint)
    }
    return { waypoints }
  }

  const origin = parseDirectionsWaypoint(body.origin, "origin")
  if ("error" in origin) return origin
  const destination = parseDirectionsWaypoint(body.destination, "destination")
  if ("error" in destination) return destination
  return { waypoints: [origin.waypoint, destination.waypoint] }
}

function parseDirectionsWaypoint(
  value: unknown,
  path: string
): { waypoint: MapsRouteWaypoint } | { error: string } {
  const coordinate = parseCoordinate(value)
  if (coordinate) return { waypoint: { position: coordinate } }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `${path} must be [lng (-180..180), lat (-90..90)] or { position: [lng, lat], placeId }.`,
    }
  }

  const record = value as { position?: unknown; placeId?: unknown }
  let position: MapCoordinate | undefined
  if (record.position !== undefined) {
    const parsedPosition = parseCoordinate(record.position)
    if (!parsedPosition) {
      return {
        error: `${path}.position must be [lng (-180..180), lat (-90..90)].`,
      }
    }
    position = parsedPosition
  }

  const placeId = parsePlaceId(record.placeId)
  if (record.placeId !== undefined && !placeId) {
    return { error: `${path}.placeId must be a non-empty string.` }
  }

  if (!position && !placeId) {
    return { error: `${path} must include position or placeId.` }
  }

  const waypoint: MapsRouteWaypoint = {}
  if (position) waypoint.position = position
  if (placeId) waypoint.placeId = placeId
  return { waypoint }
}

function parseCoordinate(value: unknown): MapCoordinate | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const lng = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null
  return [lng, lat]
}

function parsePlaceId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cleaned = value.trim().replace(/^places\//, "")
  return cleaned ? cleaned.slice(0, 256) : null
}

function parseTravelMode(value: unknown): MapsTravelMode | null {
  if (value === undefined || value === null || value === "") return null
  if (
    value === "driving" ||
    value === "walking" ||
    value === "bicycling" ||
    value === "transit" ||
    value === "two_wheeler"
  )
    return value
  return null
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
