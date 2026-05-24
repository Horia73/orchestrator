import { readGoogleMapsApiKey } from './google-session'
import type { MapBBox, MapCoordinate, MapRoute } from './schema'

const GOOGLE_ROUTES_BASE = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const ROUTES_FIELD_MASK = [
    'routes.duration',
    'routes.distanceMeters',
    'routes.polyline.geoJsonLinestring',
    'routes.viewport',
    'routes.legs.duration',
    'routes.legs.distanceMeters',
].join(',')

export type MapsTravelMode = 'driving' | 'walking' | 'bicycling' | 'transit' | 'two_wheeler'

export interface MapsRouteWaypoint {
    /** GeoJSON-order coordinate. Kept as a fallback and for local UI distance checks. */
    position?: MapCoordinate
    /** Google Place ID. Preferred by Routes API when present because it preserves the exact Google destination/entrance semantics. */
    placeId?: string | null
}

export type MapsRouteWaypointInput = MapCoordinate | MapsRouteWaypoint

export interface DirectionsOptions {
    travelMode?: MapsTravelMode
    avoidTolls?: boolean
    avoidHighways?: boolean
    avoidFerries?: boolean
    departureTime?: string
    arrivalTime?: string
    regionCode?: string
    languageCode?: string
}

export interface DirectionsRoute {
    id: string
    coordinates: MapCoordinate[]
    distanceMeters: number | null
    durationSeconds: number | null
    durationText: string | null
    fitBounds: MapBBox | null
    mapRoute: MapRoute
    legs: Array<{
        distanceMeters: number | null
        durationSeconds: number | null
    }>
}

export interface DirectionsResult {
    routes: DirectionsRoute[]
}

interface GoogleRoutesResponse {
    routes?: Array<{
        duration?: string
        distanceMeters?: number
        polyline?: {
            geoJsonLinestring?: {
                type?: string
                coordinates?: unknown
            }
        }
        viewport?: GoogleViewport
        legs?: Array<{
            duration?: string
            distanceMeters?: number
        }>
    }>
    error?: {
        code?: number
        message?: string
        status?: string
    }
}

interface GoogleViewport {
    low?: { latitude?: number; longitude?: number }
    high?: { latitude?: number; longitude?: number }
}

export async function computeDirections(
    waypoints: MapsRouteWaypointInput[],
    options: DirectionsOptions = {},
): Promise<DirectionsResult> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) {
        throw new Error('GOOGLE_MAPS_API_KEY is not set')
    }
    if (waypoints.length < 2) {
        throw new Error('At least two waypoints are required')
    }

    const normalizedWaypoints = normalizeRouteWaypoints(waypoints)
    const body = buildRoutesRequest(normalizedWaypoints, options)
    let resp: Response
    try {
        resp = await fetch(GOOGLE_ROUTES_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': ROUTES_FIELD_MASK,
            },
            body: JSON.stringify(body),
        })
    } catch (e) {
        throw new Error(`network: ${(e as Error).message}`)
    }

    let data: GoogleRoutesResponse
    try {
        data = await resp.json() as GoogleRoutesResponse
    } catch (e) {
        throw new Error(`bad json: ${(e as Error).message}`)
    }

    if (!resp.ok || data.error) {
        const err = data.error
        const prefix = err?.status ?? (resp.ok ? 'ROUTES_ERROR' : `HTTP ${resp.status}`)
        throw new Error(`${prefix}: ${err?.message ?? resp.statusText}`)
    }

    const routes = (data.routes ?? [])
        .map((route, index): DirectionsRoute | null => {
            const coordinates = parseGeoJsonCoordinates(route.polyline?.geoJsonLinestring?.coordinates)
            if (coordinates.length < 2) return null
            const distanceMeters = finiteNumber(route.distanceMeters)
            const durationSeconds = parseDurationSeconds(route.duration)
            const durationText = durationSeconds === null ? null : formatDuration(durationSeconds)
            const fitBounds = parseViewport(route.viewport) ?? bboxForCoordinates(coordinates)
            const id = `route-${index + 1}`
            const labelParts = [
                durationText,
                distanceMeters === null ? null : formatDistance(distanceMeters),
            ].filter(Boolean)
            const label = labelParts.length ? labelParts.join(' / ') : `Route ${index + 1}`
            return {
                id,
                coordinates,
                distanceMeters,
                durationSeconds,
                durationText,
                fitBounds,
                mapRoute: {
                    id,
                    coordinates,
                    color: '#2563eb',
                    width: 5,
                    label,
                },
                legs: (route.legs ?? []).map(leg => ({
                    distanceMeters: finiteNumber(leg.distanceMeters),
                    durationSeconds: parseDurationSeconds(leg.duration),
                })),
            }
        })
        .filter((route): route is DirectionsRoute => route !== null)

    if (routes.length === 0) {
        throw new Error('Routes API returned no usable route geometry')
    }

    return { routes }
}

export function normalizeRouteWaypoints(waypoints: MapsRouteWaypointInput[]): MapsRouteWaypoint[] {
    return waypoints.map((waypoint, index) => normalizeRouteWaypoint(waypoint, index))
}

function normalizeRouteWaypoint(waypoint: MapsRouteWaypointInput, index: number): MapsRouteWaypoint {
    if (isMapCoordinate(waypoint)) {
        return { position: waypoint }
    }

    if (!waypoint || typeof waypoint !== 'object' || Array.isArray(waypoint)) {
        throw new Error(`waypoints.${index} must be [lng, lat] or { position, placeId }.`)
    }

    const position = waypoint.position
    const placeId = cleanPlaceId(waypoint.placeId)
    if (position !== undefined && !isMapCoordinate(position)) {
        throw new Error(`waypoints.${index}.position must be [lng (-180..180), lat (-90..90)].`)
    }
    if (!position && !placeId) {
        throw new Error(`waypoints.${index} must include position or placeId.`)
    }

    return {
        position,
        placeId,
    }
}

function buildRoutesRequest(waypoints: MapsRouteWaypoint[], options: DirectionsOptions): Record<string, unknown> {
    const travelMode = googleTravelMode(options.travelMode ?? 'driving')
    const body: Record<string, unknown> = {
        origin: googleWaypoint(waypoints[0]),
        destination: googleWaypoint(waypoints[waypoints.length - 1]),
        travelMode,
        polylineQuality: 'HIGH_QUALITY',
        polylineEncoding: 'GEO_JSON_LINESTRING',
        computeAlternativeRoutes: false,
        units: 'METRIC',
    }
    const intermediates = waypoints.slice(1, -1).map(googleWaypoint)
    if (intermediates.length > 0) body.intermediates = intermediates

    if (travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER') {
        body.routingPreference = 'TRAFFIC_AWARE'
    }
    if (options.departureTime) body.departureTime = options.departureTime
    if (options.arrivalTime) body.arrivalTime = options.arrivalTime
    if (options.regionCode) body.regionCode = options.regionCode
    if (options.languageCode) body.languageCode = options.languageCode

    const routeModifiers: Record<string, boolean> = {}
    if (options.avoidTolls) routeModifiers.avoidTolls = true
    if (options.avoidHighways) routeModifiers.avoidHighways = true
    if (options.avoidFerries) routeModifiers.avoidFerries = true
    if (Object.keys(routeModifiers).length > 0) body.routeModifiers = routeModifiers

    return body
}

function googleWaypoint(waypoint: MapsRouteWaypoint): Record<string, unknown> {
    const placeId = cleanPlaceId(waypoint.placeId)
    if (placeId) return { placeId }

    const coord = waypoint.position
    if (!coord) {
        throw new Error('Route waypoint is missing both placeId and position.')
    }

    return {
        location: {
            latLng: {
                longitude: coord[0],
                latitude: coord[1],
            },
        },
    }
}

function isMapCoordinate(value: unknown): value is MapCoordinate {
    if (!Array.isArray(value) || value.length !== 2) return false
    const lng = Number(value[0])
    const lat = Number(value[1])
    return (
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        Math.abs(lng) <= 180 &&
        Math.abs(lat) <= 90
    )
}

function cleanPlaceId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const cleaned = value.trim().replace(/^places\//, '')
    return cleaned ? cleaned.slice(0, 256) : null
}

function googleTravelMode(mode: MapsTravelMode): string {
    switch (mode) {
        case 'walking': return 'WALK'
        case 'bicycling': return 'BICYCLE'
        case 'transit': return 'TRANSIT'
        case 'two_wheeler': return 'TWO_WHEELER'
        case 'driving':
        default:
            return 'DRIVE'
    }
}

function parseGeoJsonCoordinates(value: unknown): MapCoordinate[] {
    if (!Array.isArray(value)) return []
    const out: MapCoordinate[] = []
    for (const item of value) {
        if (!Array.isArray(item) || item.length < 2) continue
        const lng = Number(item[0])
        const lat = Number(item[1])
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
        if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue
        out.push([lng, lat])
    }
    return out
}

function parseDurationSeconds(value: string | undefined): number | null {
    if (!value) return null
    const match = value.match(/^(\d+(?:\.\d+)?)s$/)
    if (!match) return null
    const seconds = Number(match[1])
    return Number.isFinite(seconds) ? Math.round(seconds) : null
}

function parseViewport(viewport: GoogleViewport | undefined): MapBBox | null {
    const low = viewport?.low
    const high = viewport?.high
    if (!low || !high) return null
    const west = finiteNumber(low.longitude)
    const south = finiteNumber(low.latitude)
    const east = finiteNumber(high.longitude)
    const north = finiteNumber(high.latitude)
    if (west === null || south === null || east === null || north === null) return null
    return [west, south, east, north]
}

function bboxForCoordinates(coords: MapCoordinate[]): MapBBox {
    let west = coords[0][0]
    let east = coords[0][0]
    let south = coords[0][1]
    let north = coords[0][1]
    for (const [lng, lat] of coords) {
        west = Math.min(west, lng)
        east = Math.max(east, lng)
        south = Math.min(south, lat)
        north = Math.max(north, lat)
    }
    return [west, south, east, north]
}

function finiteNumber(value: unknown): number | null {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function formatDuration(seconds: number): string {
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)} m`
    return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`
}
