import { Building2, Mountain, Satellite } from "lucide-react"
import type { ComponentType } from "react"

import type {
  MapAreaSelection,
  MapRuntimeBasemap,
  MapRuntimeSettings,
} from "@/components/artifacts/renderers/map-renderer"
import {
  parseMapArtifact,
  type MapArtifact,
  type MapBBox,
  type MapCoordinate,
  type MapPin,
  type MapPolygon,
  type MapRoute,
} from "@/lib/maps/schema"
import type { UserMapLocation } from "@/lib/maps/user-location"

export interface SmartMapItem {
  id: string
  conversationId: string
  conversationTitle: string | null
  conversationOrigin?: "user" | "inbox" | null
  identifier: string
  version: number
  title: string
  display: string | null
  createdAt: number
  deletable: boolean
}

export interface SmartMapSearchResult {
  id: string
  title: string
  address: string | null
  position: [number, number]
  rating: number | null
  photoUrl: string | null
  googleMapsUri: string | null
  provider: "google-places" | "google-geocoding"
}

export interface SmartMapSearchSuggestion {
  id: string
  title: string
  subtitle: string | null
  query: string
  placeId: string | null
  kind: "place" | "query"
  provider: "google-places-autocomplete"
}

export interface MapsConfigSummary {
  id: "maps"
  configured: boolean
  mapIdConfigured: boolean
  mapIdSource: "env" | "demo"
  mapIdLabel: string
}

export interface SavedMapPlace {
  id: string
  title: string
  address: string | null
  description: string | null
  position: [number, number]
  placeId: string | null
  googleMapsUri: string | null
  websiteUri: string | null
  sourceUrl: string | null
  photoUrl: string | null
  rating: number | null
  userRatingCount: number | null
  openNow: boolean | null
  phoneNumber: string | null
  notes: string | null
  updatedAt: number
}

export interface SavedMapArea {
  id: string
  title: string
  description: string | null
  ring: MapCoordinate[]
  bbox: MapBBox
  center: MapCoordinate
  areaSqKm: number | null
  color: string
  notes: string | null
  updatedAt: number
}

export interface SavedPlacesRouteDraft {
  key: string
  title: string
  source: string
  summary: string
  warning: string | null
  savedMapId: string | null
}

export type MapSidePanelMode = "chat" | "places" | "map"

export type SmartMapActionRequest =
  | { type: "toggle-street-view" }
  | { type: "clear-search" }
  | { type: "start-area-draw" }
  | { type: "cancel-area-draw" }
  | { type: "clear-area-selection" }
  | { type: "undo-area-point" }
  | { type: "finish-area-draw" }
  | { type: "set-area-selection"; selection: MapAreaSelection }
  | { type: "recenter"; position: [number, number]; zoom?: number }
  | { type: "orbit-around-center" }

export const DEFAULT_MAP_SETTINGS: MapRuntimeSettings = {
  basemap: "satellite",
  satelliteLabels: false,
  traffic: false,
  transit: false,
  bicycling: false,
  earth3d: false,
  tilt: 0,
  heading: 0,
}

export const DEFAULT_3D_TILT = 60
export const MAX_3D_TILT = 75
export const MAP_PREFERENCES_STORAGE_KEY = "orch:smart-maps:preferences:v1"
export const MAX_ROUTE_STOPS = 24
export const MAPS_CONFIG_CHANGED_EVENT = "orch:maps-config-changed"
export const MAPS_CONFIG_FETCH_TIMEOUT_MS = 10_000

export const BASEMAP_OPTIONS: Array<{
  value: MapRuntimeBasemap
  label: string
  Icon: ComponentType<{ className?: string }>
}> = [
  { value: "roadmap", label: "City", Icon: Building2 },
  { value: "satellite", label: "Satellite", Icon: Satellite },
  { value: "terrain", label: "Terrain", Icon: Mountain },
]

export type BrowserGeoState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "watching"; position: [number, number]; accuracy: number | null }
  | { status: "denied"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }

export interface ServerMapLocation {
  source: "home-assistant" | "profile"
  label: string
  position: [number, number]
  accuracyMeters: number | null
  entityId?: string
  state?: string
  lastUpdated?: string | null
  fallbackReason?: string
}

export type ServerLocationState =
  | { status: "loading"; location: null; error: null }
  | { status: "ready"; location: ServerMapLocation; error: null }
  | { status: "error"; location: null; error: string }

export type MapsConfigState =
  | { status: "loading"; config: null; error: null }
  | { status: "ready"; config: MapsConfigSummary; error: null }
  | { status: "error"; config: null; error: string }

export interface StoredMapPreferences {
  mapSettings?: Partial<MapRuntimeSettings>
  savedPlacesVisible?: boolean
  savedAreasVisible?: boolean
}

export function readStoredMapPreferences(): StoredMapPreferences | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(MAP_PREFERENCES_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    return {
      mapSettings: sanitizeStoredMapSettings(record.mapSettings),
      savedPlacesVisible:
        typeof record.savedPlacesVisible === "boolean"
          ? record.savedPlacesVisible
          : undefined,
      savedAreasVisible:
        typeof record.savedAreasVisible === "boolean"
          ? record.savedAreasVisible
          : undefined,
    }
  } catch {
    return null
  }
}

export function sanitizeStoredMapSettings(
  value: unknown
): Partial<MapRuntimeSettings> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const record = value as Record<string, unknown>
  const settings: Partial<MapRuntimeSettings> = {}
  if (
    record.basemap === "roadmap" ||
    record.basemap === "satellite" ||
    record.basemap === "terrain"
  ) {
    settings.basemap = record.basemap
  }
  if (typeof record.satelliteLabels === "boolean") {
    settings.satelliteLabels = record.satelliteLabels
  }
  if (typeof record.traffic === "boolean") settings.traffic = record.traffic
  if (typeof record.transit === "boolean") settings.transit = record.transit
  if (typeof record.bicycling === "boolean") {
    settings.bicycling = record.bicycling
  }
  if (typeof record.earth3d === "boolean") {
    settings.earth3d = record.earth3d
  }
  if (typeof record.tilt === "number" && Number.isFinite(record.tilt)) {
    settings.tilt =
      record.earth3d === true
        ? DEFAULT_3D_TILT
        : Math.max(0, Math.min(MAX_3D_TILT, record.tilt))
  }
  if (typeof record.heading === "number" && Number.isFinite(record.heading)) {
    settings.heading =
      record.earth3d === true ? 0 : ((record.heading % 360) + 360) % 360
  }

  return Object.keys(settings).length > 0 ? settings : undefined
}

export function writeStoredMapPreferences(preferences: {
  mapSettings: MapRuntimeSettings
  savedPlacesVisible: boolean
  savedAreasVisible: boolean
}) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      MAP_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    )
  } catch {
    // Persisting map chrome is best-effort; the map remains usable.
  }
}

export function activate3DMapSettings(
  current: MapRuntimeSettings
): MapRuntimeSettings {
  return {
    ...current,
    basemap: "satellite",
    satelliteLabels: true,
    earth3d: true,
    tilt: DEFAULT_3D_TILT,
    heading: 0,
  }
}

export function deactivate3DMapSettings(
  current: MapRuntimeSettings
): MapRuntimeSettings {
  return {
    ...current,
    earth3d: false,
    tilt: 0,
    heading: 0,
  }
}

export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

export function formatDate(value: number): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function buildHomeMapSource(
  homeLocation: UserMapLocation,
  browserGeo: BrowserGeoState,
  serverLocation: ServerMapLocation | null
): string {
  const homeAssistantLocation =
    serverLocation?.source === "home-assistant" ? serverLocation : null
  const hasBrowserPosition =
    !homeAssistantLocation && browserGeo.status === "watching"
  const fallback = serverLocation ?? {
    source: "profile" as const,
    label: homeLocation.label,
    position: homeLocation.position,
    accuracyMeters: null,
  }
  const activeLocation =
    homeAssistantLocation ?? (hasBrowserPosition ? null : fallback)
  const position =
    homeAssistantLocation?.position ??
    (hasBrowserPosition ? browserGeo.position : fallback.position)
  const accuracy =
    homeAssistantLocation?.accuracyMeters ??
    (hasBrowserPosition ? browserGeo.accuracy : null)
  const label =
    homeAssistantLocation?.label ??
    (hasBrowserPosition ? "Locatia curenta" : fallback.label)
  const sourceLabel = homeAssistantLocation
    ? "Home Assistant"
    : hasBrowserPosition
      ? "browser"
      : null
  const accuracyText =
    sourceLabel && typeof accuracy === "number"
      ? `Acuratete ${sourceLabel} ~${Math.round(accuracy)} m.`
      : null
  const savedLocationDescription =
    fallback.source === "home-assistant"
      ? `Home Assistant${fallback.entityId ? ` - ${fallback.entityId}` : ""}${fallback.state ? ` (${fallback.state})` : ""}.`
      : fallback.fallbackReason
        ? `Profil local. ${fallback.fallbackReason}`
        : "Smart Maps se deschide aici pana alegi o harta din conversatii."
  const accuracyPolygon =
    (homeAssistantLocation || hasBrowserPosition) &&
    typeof accuracy === "number" &&
    accuracy > 0
      ? accuracyCircle(position, Math.min(accuracy, 5000))
      : null

  return JSON.stringify({
    viewport: {
      center: position,
      zoom:
        homeAssistantLocation || hasBrowserPosition
          ? zoomForAccuracy(accuracy)
          : 16,
    },
    basemap: "satellite",
    pins: [
      {
        id: "user-location",
        position,
        label,
        address: hasBrowserPosition
          ? "Locatie curenta"
          : activeLocation?.source === "home-assistant"
            ? "Home Assistant live location"
            : "Locatie salvata in profil",
        description: accuracyText ?? savedLocationDescription,
        color: "#2563eb",
        icon: "home",
      },
    ],
    polygons: accuracyPolygon
      ? [
          {
            id: "location-accuracy",
            rings: [accuracyPolygon],
            color: "#2563eb",
            fillOpacity: 0.12,
            label: accuracyText ?? "Location accuracy",
          },
        ]
      : [],
  })
}

export function zoomForAccuracy(accuracy: number | null): number {
  if (typeof accuracy !== "number") return 17
  if (accuracy <= 50) return 18
  if (accuracy <= 150) return 17
  if (accuracy <= 500) return 16
  if (accuracy <= 1500) return 15
  return 14
}

export function accuracyCircle(
  center: [number, number],
  radiusMeters: number
): Array<[number, number]> {
  const points: Array<[number, number]> = []
  const [lng, lat] = center
  const latRad = (lat * Math.PI) / 180
  const latRadius = radiusMeters / 111_320
  const lngRadius = radiusMeters / (111_320 * Math.max(Math.cos(latRad), 0.01))
  for (let i = 0; i <= 32; i++) {
    const angle = (i / 32) * Math.PI * 2
    points.push([
      lng + Math.cos(angle) * lngRadius,
      lat + Math.sin(angle) * latRadius,
    ])
  }
  return points
}

export function geoErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED)
    return "Browser location permission was denied."
  if (error.code === error.POSITION_UNAVAILABLE)
    return "Browser location is unavailable."
  if (error.code === error.TIMEOUT) return "Browser location request timed out."
  return error.message || "Browser location failed."
}

export function viewportCenterFromSource(
  source: string
): [number, number] | null {
  const parsed = parseMapArtifact(source)
  return parsed.ok ? parsed.value.viewport.center : null
}

export function savedPlacesToOverlayPins(
  source: string,
  savedPlaces: SavedMapPlace[]
): MapPin[] {
  if (savedPlaces.length === 0) return []
  const parsed = parseMapArtifact(source)
  const existingPins = parsed.ok ? collectArtifactPins(parsed.value) : []
  return savedPlaces
    .filter(
      (place) => !existingPins.some((pin) => savedPlaceMatchesPin(place, pin))
    )
    .map(savedPlaceToOverlayPin)
}

export function collectArtifactPins(artifact: MapArtifact): MapPin[] {
  return [
    ...(artifact.pins ?? []),
    ...(artifact.days ?? []).flatMap((day) => day.pins ?? []),
  ]
}

export function savedPlaceMatchesPin(
  place: SavedMapPlace,
  pin: MapPin
): boolean {
  if (place.placeId && pin.placeId && place.placeId === pin.placeId) return true
  if (
    place.googleMapsUri &&
    pin.googleMapsUri &&
    place.googleMapsUri === pin.googleMapsUri
  )
    return true

  const label = pin.label ?? ""
  return (
    normalize(place.title) === normalize(label) &&
    distanceMeters(place.position, pin.position) <= 30
  )
}

export function savedPlaceToOverlayPin(place: SavedMapPlace): MapPin {
  return {
    id: `saved-${place.id}`,
    position: place.position,
    label: place.title,
    address: place.address ?? undefined,
    description: place.description ?? "Saved place from Smart Maps.",
    notes: place.notes ?? undefined,
    photoUrl: place.photoUrl ?? undefined,
    rating: place.rating ?? undefined,
    userRatingCount: place.userRatingCount ?? undefined,
    openNow: place.openNow ?? undefined,
    phoneNumber: place.phoneNumber ?? undefined,
    placeId: place.placeId ?? undefined,
    googleMapsUri: place.googleMapsUri ?? undefined,
    websiteUri: place.websiteUri ?? undefined,
    sourceUrl: place.sourceUrl ?? undefined,
    savedPlaceId: place.id,
    color: "#111827",
    icon: "star",
  }
}

export function savedAreaToPolygon(area: SavedMapArea): MapPolygon {
  return {
    id: `saved-area-${area.id}`,
    rings: [area.ring],
    color: area.color || "#1a73e8",
    fillOpacity: 0.16,
    label: area.title,
  }
}

export function sourceWithSavedAreaOverlays(
  source: string,
  savedAreas: SavedMapArea[],
  visible: boolean
): string {
  if (!visible || savedAreas.length === 0) return source
  const parsed = parseMapArtifact(source)
  if (!parsed.ok) return source
  const existingIds = new Set(
    (parsed.value.polygons ?? []).map((poly) => poly.id)
  )
  const overlays = savedAreas
    .map(savedAreaToPolygon)
    .filter((polygon) => !existingIds.has(polygon.id))
  if (overlays.length === 0) return source
  return JSON.stringify({
    ...parsed.value,
    polygons: [...(parsed.value.polygons ?? []), ...overlays],
  })
}

export function savedAreaToSelection(area: SavedMapArea): MapAreaSelection {
  return {
    ring: area.ring,
    bbox: area.bbox,
    center: area.center,
    areaSqKm: area.areaSqKm,
  }
}

export function areaSelectionToGeoJson(selection: MapAreaSelection): string {
  const closedRing =
    selection.ring.length > 0
      ? [...selection.ring, selection.ring[0]]
      : selection.ring
  return JSON.stringify(
    {
      type: "Feature",
      properties: {
        bbox: selection.bbox,
        center: selection.center,
        areaSqKm: selection.areaSqKm,
      },
      geometry: {
        type: "Polygon",
        coordinates: [closedRing],
      },
    },
    null,
    2
  )
}

export function savedPlaceToRoutePin(
  place: SavedMapPlace,
  order: number
): MapPin {
  return {
    ...savedPlaceToOverlayPin(place),
    id: `route-stop-${order}-${safeMapIdPart(place.id)}`,
    description:
      place.notes?.trim() ||
      place.description?.trim() ||
      "Saved place from Smart Maps route.",
    color: "#0891b2",
    icon: "flag",
  }
}

export function buildSavedPlacesRouteArtifact({
  start,
  startLabel,
  places,
  route,
  fitBounds,
  warning,
}: {
  start: [number, number]
  startLabel: string
  places: SavedMapPlace[]
  route: MapRoute
  fitBounds: MapBBox
  warning: string | null
}): MapArtifact {
  const paddedBounds = padBBox(fitBounds)
  return {
    viewport: {
      center: bboxCenter(paddedBounds),
      zoom: places.length <= 1 ? 14 : 12,
      pitch: 0,
      bearing: 0,
    },
    basemap: "satellite-streets",
    pins: [
      {
        id: "route-start",
        position: start,
        label: startLabel,
        address: "Route start",
        description: warning ?? "Starting point for this Smart Maps route.",
        color: "#2563eb",
        icon: "home",
      },
      ...places.map((place, index) => savedPlaceToRoutePin(place, index + 1)),
    ],
    routes: [route],
    polygons: [],
    attribution: warning ?? "Smart Maps saved places route.",
  }
}

export function safeMapIdPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42) || "place"
  )
}

export function bboxCenter(bounds: MapBBox): [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
}

export function padBBox(bounds: MapBBox): MapBBox {
  const lngPad = Math.max((bounds[2] - bounds[0]) * 0.1, 0.002)
  const latPad = Math.max((bounds[3] - bounds[1]) * 0.1, 0.002)
  return [
    Math.max(-180, bounds[0] - lngPad),
    Math.max(-90, bounds[1] - latPad),
    Math.min(180, bounds[2] + lngPad),
    Math.min(90, bounds[3] + latPad),
  ]
}

export function routeDraftTitle(places: SavedMapPlace[]): string {
  if (places.length === 0) return "Saved places route"
  if (places.length === 1) return `Route to ${places[0].title}`
  return `${places[0].title} + ${places.length - 1} stops`
}

export function routeSummaryText(
  durationText: string | null | undefined,
  distanceMeters: number | null | undefined,
  fallbackDistanceText: string
): string {
  const parts = [
    durationText ?? null,
    typeof distanceMeters === "number" && Number.isFinite(distanceMeters)
      ? formatRouteDistance(distanceMeters)
      : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" / ") : `Approx. ${fallbackDistanceText}`
}

export function formatRouteDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`
}

export function distanceMeters(
  a: [number, number],
  b: [number, number]
): number {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadius = 6_371_000
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function createSearchSessionToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function formatAreaSelectionLabel(
  selection: MapAreaSelection | null
): string {
  if (!selection) return "Area selected"
  const area =
    typeof selection.areaSqKm === "number" && selection.areaSqKm > 0
      ? ` · ${formatAreaSqKm(selection.areaSqKm)}`
      : ""
  return `Area selected · ${selection.ring.length} pts${area}`
}

export function formatAreaSqKm(value: number): string {
  if (value < 1) return `${Math.round(value * 1_000_000).toLocaleString()} m²`
  return `${value.toFixed(value < 10 ? 2 : 1)} km²`
}

export function formatContextCoordinate(position: [number, number]): string {
  return `[${Number(position[0].toFixed(6))}, ${Number(position[1].toFixed(6))}]`
}

export function formatContextRing(ring: MapCoordinate[]): string {
  return JSON.stringify(
    ring.map(([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))])
  )
}

export function summarizeMapForPrompt(source: string): string[] {
  const parsed = parseMapArtifact(source)
  if (!parsed.ok) return ["Active map artifact: failed to parse."]

  const artifact = parsed.value
  const pins = collectArtifactPins(artifact)
  const routes = artifact.routes ?? []
  const polygons = artifact.polygons ?? []
  const days = artifact.days ?? []
  const lines = [
    `Artifact features: ${pins.length} pins, ${routes.length} routes, ${polygons.length} polygons, ${days.length} days.`,
    `Artifact viewport center [lng,lat]: ${formatContextCoordinate(artifact.viewport.center)}; zoom ${artifact.viewport.zoom}.`,
  ]

  if (pins.length > 0) {
    lines.push(
      "Pins:",
      ...pins.slice(0, 24).map((pin, index) => {
        const label = pin.label ?? `Pin ${index + 1}`
        const address = pin.address ? `; address: ${pin.address}` : ""
        return `- ${label}: ${formatContextCoordinate(pin.position)}${address}`
      })
    )
    if (pins.length > 24) {
      lines.push(`- ${pins.length - 24} additional pins omitted.`)
    }
  }

  return lines
}

export function buildAreaResearchPrompt(
  selection: MapAreaSelection,
  mapTitle: string
): string {
  const ring = selection.ring.map(([lng, lat]) => [
    Number(lng.toFixed(6)),
    Number(lat.toFixed(6)),
  ])
  const bbox = selection.bbox.map((value) => Number(value.toFixed(6)))
  const center = selection.center.map((value) => Number(value.toFixed(6)))
  const area =
    typeof selection.areaSqKm === "number"
      ? `\nArie estimată: ${formatAreaSqKm(selection.areaSqKm)}`
      : ""

  return [
    `Am selectat o zonă pe harta "${mapTitle}".`,
    "Începe prin a întreba ce vreau să cercetez dacă intenția nu este evidentă.",
    "Folosește poligonul ca input geografic. Delegă research-ul către researcher/web search pentru date publice, iar browser_agent doar dacă o pagină cere interacțiune vizuală, login sau acțiuni într-un site.",
    "Dacă găsești locații relevante, întoarce coordonate [lng,lat], surse și un motiv scurt pentru fiecare. Dacă are sens vizual, compune la final o hartă cu MapRender.",
    "Dacă nu poți garanta că rezultatele sunt în poligon, spune clar ce ai filtrat strict și ce este doar aproape de zonă.",
    "",
    `Poligon [lng,lat]: ${JSON.stringify(ring)}`,
    `BBox [west,south,east,north]: ${JSON.stringify(bbox)}`,
    `Centru [lng,lat]: ${JSON.stringify(center)}${area}`,
    "",
    "GeoJSON:",
    "```json",
    areaSelectionToGeoJson(selection),
    "```",
  ].join("\n")
}
