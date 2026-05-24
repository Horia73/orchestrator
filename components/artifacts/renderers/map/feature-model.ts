import type {
  MapArtifact,
  MapBBox,
  MapCoordinate,
  MapPin as MapPinType,
  MapPolygon,
  MapRoute,
} from "@/lib/maps/schema"

import type { PinRow, PlaceClickFallback } from "./types"

/**
 * Build the active set of pins given the day filter.
 *   activeDay = -1  → "Toate" — every pin from every day + top-level pins
 *   activeDay >= 0 → global top-level pins + that day's pins, so anchors like
 *                    hotel/home stay visible while the itinerary changes.
 * Pins are numbered 1..N in the order returned, so the marker number and
 * the sidebar card number always agree.
 */
export function collectPins(artifact: MapArtifact, activeDay: number): PinRow[] {
  const out: PinRow[] = []
  const days = artifact.days ?? []
  const hasDays = days.length > 0

  if (hasDays && activeDay >= 0) {
    const day = days[activeDay] ?? days[0]
    for (const p of artifact.pins ?? [])
      out.push({ key: `pin:${p.id}`, pin: p, number: 0 })
    for (const p of day.pins ?? [])
      out.push({
        key: `day-${day.id}:${p.id}`,
        pin: p,
        number: 0,
        dayLabel: day.label,
      })
  } else if (hasDays) {
    // Toate
    for (const day of days) {
      for (const p of day.pins ?? [])
        out.push({
          key: `day-${day.id}:${p.id}`,
          pin: p,
          number: 0,
          dayLabel: day.label,
        })
    }
    for (const p of artifact.pins ?? [])
      out.push({ key: `pin:${p.id}`, pin: p, number: 0 })
  } else {
    for (const p of artifact.pins ?? [])
      out.push({ key: `pin:${p.id}`, pin: p, number: 0 })
  }
  return out.map((row, idx) => ({ ...row, number: idx + 1 }))
}

export function collectRoutes(artifact: MapArtifact, activeDay: number): MapRoute[] {
  const days = artifact.days ?? []
  const hasDays = days.length > 0
  if (hasDays && activeDay >= 0) {
    return [...(artifact.routes ?? []), ...(days[activeDay]?.routes ?? [])]
  }
  if (hasDays) {
    return [
      ...(artifact.routes ?? []),
      ...days.flatMap((day) => day.routes ?? []),
    ]
  }
  return [...(artifact.routes ?? [])]
}

export function collectPolygons(artifact: MapArtifact): MapPolygon[] {
  // Polygons are currently global overlays (zones, risk areas, search
  // regions). Day-scoped polygons can be added to the schema later without
  // changing the iframe contract.
  return [...(artifact.polygons ?? [])]
}

export function collectOverlayPins(
  pins: MapPinType[] | undefined,
  startNumber: number
): PinRow[] {
  if (!pins || pins.length === 0) return []
  return pins.map((pin, index) => ({
    key: `overlay:${pin.id}`,
    pin,
    number: startNumber + index + 1,
    dayLabel: "Saved place",
  }))
}

export function dynamicPlaceKey(placeId: string): string {
  return `place:${placeId}`
}

export function dynamicPlaceRowFromFallback({
  key,
  placeId,
  position,
  fallback,
}: {
  key: string
  placeId: string
  position: MapCoordinate
  fallback?: PlaceClickFallback | null
}): PinRow {
  const realPlaceId =
    fallback?.provider === "google-places" ? placeId : undefined
  return {
    key,
    number: 0,
    pin: {
      id: `place-${placeId}`,
      position,
      label: fallback?.label?.trim() || undefined,
      address: fallback?.address?.trim() || undefined,
      rating:
        typeof fallback?.rating === "number" ? fallback.rating : undefined,
      photoUrl: fallback?.photoUrl ?? undefined,
      description: fallback?.description?.trim() || undefined,
      notes: fallback?.notes?.trim() || undefined,
      placeId: realPlaceId,
      googleMapsUri: fallback?.googleMapsUri ?? undefined,
      websiteUri: fallback?.websiteUri ?? undefined,
      sourceUrl: fallback?.sourceUrl ?? undefined,
      savedPlaceId: fallback?.savedPlaceId ?? undefined,
      userRatingCount:
        typeof fallback?.userRatingCount === "number"
          ? fallback.userRatingCount
          : undefined,
      openNow:
        typeof fallback?.openNow === "boolean" ? fallback.openNow : undefined,
      phoneNumber: fallback?.phoneNumber ?? undefined,
      color: "#0891b2",
      icon: "default",
    },
  }
}

export function boundsForVisibleFeatures(
  rows: PinRow[],
  routes: MapRoute[],
  polygons: MapPolygon[]
): MapBBox | undefined {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  let count = 0

  function extend(coord: MapCoordinate | undefined) {
    if (!coord) return
    const [lng, lat] = coord
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
    west = Math.min(west, lng)
    south = Math.min(south, lat)
    east = Math.max(east, lng)
    north = Math.max(north, lat)
    count++
  }

  for (const row of rows) extend(row.pin.position)
  for (const route of routes) {
    for (const coord of route.coordinates) extend(coord)
  }
  for (const polygon of polygons) {
    for (const ring of polygon.rings) {
      for (const coord of ring) extend(coord)
    }
  }

  if (count === 0) return undefined
  const lngPad = Math.max((east - west) * 0.08, 0.002)
  const latPad = Math.max((north - south) * 0.08, 0.002)
  return [
    clampLng(west - lngPad),
    clampLat(south - latPad),
    clampLng(east + lngPad),
    clampLat(north + latPad),
  ]
}

function clampLng(value: number): number {
  return Math.max(-180, Math.min(180, value))
}

function clampLat(value: number): number {
  return Math.max(-90, Math.min(90, value))
}

export function viewportForRows(
  rows: PinRow[],
  fallback: MapArtifact["viewport"],
  fitBounds?: MapBBox
): MapArtifact["viewport"] {
  if (fitBounds) {
    return {
      center: [
        (fitBounds[0] + fitBounds[2]) / 2,
        (fitBounds[1] + fitBounds[3]) / 2,
      ],
      zoom: fallback.zoom,
      pitch: fallback.pitch,
      bearing: fallback.bearing,
    }
  }
  if (rows.length === 0) return fallback
  // The iframe will fitBounds after the markers land — this is only
  // the camera the map opens to before pins are dropped in.
  let sumLng = 0,
    sumLat = 0
  for (const r of rows) {
    sumLng += r.pin.position[0]
    sumLat += r.pin.position[1]
  }
  return {
    center: [sumLng / rows.length, sumLat / rows.length],
    zoom: rows.length === 1 ? Math.max(fallback.zoom, 14) : fallback.zoom,
    pitch: fallback.pitch,
    bearing: fallback.bearing,
  }
}
