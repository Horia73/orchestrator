import type { ComponentType } from "react"
import { Bike, Car, Footprints, TrainFront } from "lucide-react"
import type {
  MapCoordinate,
  MapPin as MapPinType,
  MapRoute,
} from "@/lib/maps/schema"
import type {
  ActiveDirections,
  DirectionsApiResponse,
  DirectionsPoint,
  DirectionsTravelMode,
  PinRow,
  ResolvedDirectionsPoint,
  RouteSearchResult,
} from "./types"

export const CURRENT_LOCATION_LABEL = "Locația ta"

export const TRAVEL_MODE_OPTIONS: Array<{
  value: DirectionsTravelMode
  label: string
  Icon: ComponentType<{ className?: string }>
}> = [
  { value: "driving", label: "Auto", Icon: Car },
  { value: "walking", label: "Pe jos", Icon: Footprints },
  { value: "bicycling", label: "Bicicletă", Icon: Bike },
  { value: "transit", label: "Transport", Icon: TrainFront },
]

export function fallbackTravelModes(
  requested: DirectionsTravelMode
): DirectionsTravelMode[] {
  if (requested !== "driving") return [requested]
  return ["driving", "walking", "transit", "bicycling"]
}

export function travelModeLabel(mode: DirectionsTravelMode): string {
  return (
    TRAVEL_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
  )
}

export function currentDirectionsPoint(): DirectionsPoint {
  return { kind: "current", label: CURRENT_LOCATION_LABEL }
}

export function nullPoint(): DirectionsPoint {
  return { kind: "place", label: "" }
}

export function directionsPointFromRow(row: PinRow): DirectionsPoint {
  return {
    kind: "place",
    label: row.pin.label ?? `Location ${row.number}`,
    address: row.pin.address ?? null,
    position: row.pin.position,
    placeId: row.pin.placeId ?? null,
    provider: row.pin.placeId ? "google-places" : null,
  }
}

export function isCurrentLocationText(value: string): boolean {
  const normalized = value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return (
    normalized === "locatia ta" ||
    normalized === "locatia mea" ||
    normalized === "locatie curenta" ||
    normalized === "current location"
  )
}

export async function resolveDirectionsPoint(
  point: DirectionsPoint
): Promise<ResolvedDirectionsPoint> {
  if (point.kind === "current") {
    return { position: await resolveDirectionsOrigin() }
  }
  if (point.position && isMapCoordinate(point.position)) {
    return {
      position: point.position,
      placeId: point.placeId ?? null,
    }
  }
  throw new Error("Alege o locație validă pentru rută.")
}

export async function fetchDirectionsRoute({
  origin,
  destination,
  stops,
  travelMode,
}: {
  origin: ResolvedDirectionsPoint
  destination: ResolvedDirectionsPoint
  stops?: ResolvedDirectionsPoint[]
  travelMode: DirectionsTravelMode
}): Promise<DirectionsApiResponse> {
  const hasStops = Array.isArray(stops) && stops.length > 0
  const payload: Record<string, unknown> = {
    travelMode,
    languageCode:
      typeof navigator !== "undefined" ? navigator.language : undefined,
  }
  if (hasStops) {
    payload.waypoints = [
      directionsWaypointPayload(origin),
      ...stops.map(directionsWaypointPayload),
      directionsWaypointPayload(destination),
    ]
  } else {
    payload.origin = directionsWaypointPayload(origin)
    payload.destination = directionsWaypointPayload(destination)
  }
  const response = await fetch("/api/maps/directions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const body = (await response
    .json()
    .catch(() => ({}))) as DirectionsApiResponse
  if (!response.ok || !body.route) {
    throw new Error(body.error ?? `Directions failed (${response.status})`)
  }
  return body
}

export function directionsWaypointPayload(point: ResolvedDirectionsPoint) {
  return {
    position: point.position,
    placeId: point.placeId ?? undefined,
  }
}

export function isTerminalDirectionsError(error: Error): boolean {
  return /GOOGLE_MAPS_(?:SERVER_)?API_KEY|REQUEST_DENIED|PERMISSION_DENIED|API_KEY|HTTP 40[13]|OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED/i.test(
    error.message
  )
}

export function googleDirectionsUrl({
  originPoint,
  origin,
  destinationPoint,
  destination,
  stopPoints,
  stops,
  travelMode,
}: {
  originPoint: DirectionsPoint
  origin: ResolvedDirectionsPoint
  destinationPoint: DirectionsPoint
  destination: ResolvedDirectionsPoint
  stopPoints?: DirectionsPoint[]
  stops?: ResolvedDirectionsPoint[]
  travelMode: DirectionsTravelMode
}): string {
  const params = new URLSearchParams({ api: "1" })
  if (originPoint.kind !== "current") {
    params.set("origin", googleDirectionsQuery(originPoint, origin))
    if (origin.placeId) params.set("origin_place_id", origin.placeId)
  }
  params.set(
    "destination",
    googleDirectionsQuery(destinationPoint, destination)
  )
  if (destination.placeId) {
    params.set("destination_place_id", destination.placeId)
  }
  if (stopPoints && stops && stopPoints.length > 0) {
    const labels: string[] = []
    const ids: string[] = []
    stopPoints.forEach((point, index) => {
      const resolved = stops[index]
      if (!resolved) return
      labels.push(googleDirectionsQuery(point, resolved))
      if (resolved.placeId) ids.push(resolved.placeId)
    })
    if (labels.length > 0) params.set("waypoints", labels.join("|"))
    if (ids.length > 0) params.set("waypoint_place_ids", ids.join("|"))
  }
  params.set("travelmode", travelMode)
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

export function googleDirectionsQuery(
  point: DirectionsPoint,
  resolved: ResolvedDirectionsPoint
): string {
  const text = point.label?.trim() || point.address?.trim()
  if (text) return text
  return coordinateQuery(resolved.position)
}

export function coordinateQuery(position: MapCoordinate): string {
  const [lng, lat] = position
  return `${lat},${lng}`
}

export async function searchDirectionsPoint(
  query: string,
  center: MapCoordinate,
  options: { placeId?: string | null; sessionToken?: string | null } = {}
): Promise<DirectionsPoint> {
  const trimmed = query.trim()
  if (isCurrentLocationText(trimmed)) return currentDirectionsPoint()
  if (!trimmed) throw new Error("Alege o locație validă pentru rută.")

  const params = new URLSearchParams({ q: trimmed })
  params.set("center", `${center[0]},${center[1]}`)
  if (options.placeId) params.set("placeId", options.placeId)
  if (options.sessionToken) params.set("sessionToken", options.sessionToken)
  if (typeof navigator !== "undefined" && navigator.language) {
    params.set("language", navigator.language)
  }

  const response = await fetch(`/api/maps/search?${params.toString()}`, {
    cache: "no-store",
  })
  const body = (await response.json().catch(() => ({}))) as {
    results?: RouteSearchResult[]
    error?: string
  }
  if (!response.ok) {
    throw new Error(body.error ?? `Search failed (${response.status})`)
  }
  const result = body.results?.[0]
  if (!result || !isMapCoordinate(result.position)) {
    throw new Error("Nu am găsit locația.")
  }
  return {
    kind: "place",
    label: result.title,
    address: result.address,
    position: result.position,
    placeId: result.provider === "google-places" ? result.id : null,
    provider: result.provider,
  }
}

export function createDirectionsSessionToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function visiblePinDescription(pin: MapPinType): string | null {
  const description = pin.description?.trim()
  if (!description) return null
  if (extractGoogleMapsUrl(description)) return null
  return description
}

export function routeSummary(route: ActiveDirections | null): string | null {
  if (!route) return null
  const parts = [
    route.durationText,
    formatRouteDistance(route.distanceMeters),
  ].filter(Boolean)
  const primary = parts.length ? parts.join(" / ") : null
  if (!route.accessDistanceMeters) return primary

  const walkParts = [
    route.accessDurationText,
    formatRouteDistance(route.accessDistanceMeters),
  ].filter(Boolean)
  const walk = walkParts.length ? walkParts.join(" / ") : "pe jos"
  return primary ? `${primary} + pe jos ${walk}` : `Pe jos ${walk}`
}

export function formatCompactCount(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value)
  } catch {
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
    if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
    return String(value)
  }
}

export function phoneCallHref(phoneNumber: string): string | null {
  const trimmed = phoneNumber.trim()
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length < 3) return null
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`
}

export function todayOpeningHours(lines: string[] | undefined): string | null {
  if (!lines?.length) return null
  const today = new Date().getDay()
  const dayNames: Record<number, RegExp> = {
    0: /^(sun|duminic|dum|domingo|dimanche)/i,
    1: /^(mon|luni|lun|lunes|lundi)/i,
    2: /^(tue|marți|marti|mar|martes|mardi)/i,
    3: /^(wed|miercuri|mie|miércoles|mercredi)/i,
    4: /^(thu|joi|jueves|jeudi)/i,
    5: /^(fri|vineri|vin|viernes|vendredi)/i,
    6: /^(sat|sâmbătă|sambata|sâm|sam|sábado|samedi)/i,
  }
  const match = lines.find((line) => dayNames[today]?.test(line.trim()))
  return match ?? lines[0] ?? null
}

export function formatBusinessStatus(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.toUpperCase()
  if (normalized === "OPERATIONAL") return null
  if (normalized === "CLOSED_TEMPORARILY") return "Închis temporar"
  if (normalized === "CLOSED_PERMANENTLY") return "Închis permanent"
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function formatPriceLevel(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.toUpperCase()
  if (normalized === "PRICE_LEVEL_FREE") return "Gratuit"
  if (normalized === "PRICE_LEVEL_INEXPENSIVE") return "Preț redus"
  if (normalized === "PRICE_LEVEL_MODERATE") return "Preț moderat"
  if (normalized === "PRICE_LEVEL_EXPENSIVE") return "Scump"
  if (normalized === "PRICE_LEVEL_VERY_EXPENSIVE") return "Foarte scump"
  return value
}

export function formatRouteDistance(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  if (value < 1000) return `${Math.round(value)} m`
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} km`
}

export function lastRouteCoordinate(route: MapRoute): MapCoordinate | null {
  const coord = route.coordinates[route.coordinates.length - 1]
  return isMapCoordinate(coord) ? coord : null
}

export function appendDirectionsNotice(
  current: string | null,
  next: string
): string {
  return current ? `${current} ${next}` : next
}

export function distanceMetersBetween(
  a: MapCoordinate,
  b: MapCoordinate
): number {
  const radiusMeters = 6_371_000
  const lat1 = (a[1] * Math.PI) / 180
  const lat2 = (b[1] * Math.PI) / 180
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * radiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

async function resolveDirectionsOrigin(): Promise<MapCoordinate> {
  const browserPosition = await readBrowserPosition().catch(() => null)
  if (browserPosition) return browserPosition

  const response = await fetch("/api/maps/current-location", {
    cache: "no-store",
  })
  const body = (await response.json().catch(() => ({}))) as {
    location?: { position?: unknown; label?: string }
    error?: string
  }
  const position = body.location?.position
  if (isMapCoordinate(position)) return position

  throw new Error(body.error ?? "Nu am găsit o locație de pornire pentru rută.")
}

export function readBrowserPosition(): Promise<MapCoordinate | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coord: MapCoordinate = [
          position.coords.longitude,
          position.coords.latitude,
        ]
        resolve(isMapCoordinate(coord) ? coord : null)
      },
      () => resolve(null),
      {
        enableHighAccuracy: true,
        maximumAge: 60_000,
        timeout: 7000,
      }
    )
  })
}

export function isMapCoordinate(value: unknown): value is MapCoordinate {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lng, lat] = value
  return (
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  )
}

export function extractGoogleMapsUrl(value: string | undefined): string | null {
  const match = value?.match(/^Google Maps:\s*(https?:\/\/\S+)\s*$/i)
  return match?.[1] ?? null
}
