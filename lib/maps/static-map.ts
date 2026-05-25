import { z } from "zod"

import {
  MapArtifactSchema,
  type MapArtifact,
  type MapCoordinate,
  type MapPin,
  type MapPolygon,
  type MapRoute,
} from "@/lib/maps/schema"

const GOOGLE_STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap"
const MAX_STATIC_MARKERS = 40
const MAX_STATIC_PATH_POINTS = 96
const MAX_STATIC_URL_LENGTH = 16_000

const StaticMapBasemapSchema = z.enum([
  "roadmap",
  "satellite",
  "terrain",
  "hybrid",
])

export const StaticMapRequestSchema = z.object({
  artifact: MapArtifactSchema.optional(),
  source: z.string().max(100_000).optional(),
  dayId: z.string().max(64).optional(),
  dayIndex: z.number().int().min(0).optional(),
  width: z.number().int().min(160).max(1280).default(640),
  height: z.number().int().min(120).max(1280).default(360),
  scale: z.union([z.literal(1), z.literal(2)]).default(2),
  basemap: StaticMapBasemapSchema.optional(),
})
export type StaticMapRequest = z.input<typeof StaticMapRequestSchema>
type ParsedStaticMapRequest = Required<
  Pick<z.output<typeof StaticMapRequestSchema>, "width" | "height" | "scale">
> &
  Omit<
    z.output<typeof StaticMapRequestSchema>,
    "artifact" | "width" | "height" | "scale"
  > & {
    artifact: MapArtifact
  }

export interface StaticMapBuildResult {
  url: string
  mapType: z.infer<typeof StaticMapBasemapSchema>
  markerCount: number
  pathCount: number
  warnings: string[]
}

interface StaticMapScene {
  artifact: MapArtifact
  pins: MapPin[]
  routes: MapRoute[]
  polygons: MapPolygon[]
  fitBounds: [number, number, number, number] | null
}

export function buildGoogleStaticMapUrl(
  input: unknown,
  apiKey: string
): StaticMapBuildResult {
  const request = parseStaticMapRequest(input)
  const scene = selectStaticMapScene(request)
  const warnings: string[] = []
  const params = new URLSearchParams()

  params.set("key", apiKey)
  params.set("format", "png")
  params.set("size", `${request.width}x${request.height}`)
  params.set("scale", String(request.scale))
  const mapType = resolveStaticMapType(request, scene.artifact)
  params.set("maptype", mapType)

  const markers = scene.pins.slice(0, MAX_STATIC_MARKERS)
  if (scene.pins.length > markers.length) {
    warnings.push(
      `Static map includes first ${markers.length} of ${scene.pins.length} pins.`
    )
  }
  for (const [index, pin] of markers.entries()) {
    params.append("markers", staticMarkerParam(pin, index))
  }

  let pathCount = 0
  for (const route of scene.routes) {
    const path = staticRoutePathParam(route)
    if (!path) continue
    params.append("path", path)
    pathCount += 1
  }
  for (const polygon of scene.polygons) {
    for (const path of staticPolygonPathParams(polygon)) {
      params.append("path", path)
      pathCount += 1
    }
  }

  if (markers.length === 0 && pathCount === 0) {
    params.set("center", staticCoord(scene.artifact.viewport.center))
    params.set("zoom", String(Math.round(scene.artifact.viewport.zoom)))
  } else if (scene.fitBounds && markers.length === 0) {
    params.set("center", staticCoord(bboxCenter(scene.fitBounds)))
  }

  const url = `${GOOGLE_STATIC_MAP_URL}?${params.toString()}`
  if (url.length > MAX_STATIC_URL_LENGTH) {
    warnings.push(
      `Static map URL is ${url.length} chars; Google may reject very complex scenes.`
    )
  }

  return {
    url,
    mapType,
    markerCount: markers.length,
    pathCount,
    warnings,
  }
}

function parseStaticMapRequest(input: unknown): ParsedStaticMapRequest {
  const parsed = StaticMapRequestSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue.path.length ? issue.path.join(".") : "(root)"
    throw new Error(`Invalid static map request at ${path}: ${issue.message}`)
  }

  const request = parsed.data
  let artifact = request.artifact
  if (!artifact && request.source) {
    let decoded: unknown
    try {
      decoded = JSON.parse(request.source)
    } catch {
      throw new Error("Invalid static map request: source must be JSON.")
    }
    const artifactParsed = MapArtifactSchema.safeParse(decoded)
    if (!artifactParsed.success) {
      const issue = artifactParsed.error.issues[0]
      const path = issue.path.length ? issue.path.join(".") : "(root)"
      throw new Error(`Invalid static map artifact at ${path}: ${issue.message}`)
    }
    artifact = artifactParsed.data
  }

  if (!artifact) {
    throw new Error("Invalid static map request: artifact or source is required.")
  }

  return { ...request, artifact }
}

function selectStaticMapScene(
  request: ReturnType<typeof parseStaticMapRequest>
): StaticMapScene {
  const artifact = request.artifact
  const days = artifact.days ?? []
  const day =
    typeof request.dayId === "string"
      ? days.find((item) => item.id === request.dayId)
      : typeof request.dayIndex === "number"
        ? days[request.dayIndex]
        : undefined

  return {
    artifact,
    pins: [...artifact.pins, ...(day?.pins ?? [])],
    routes: [...artifact.routes, ...(day?.routes ?? [])],
    polygons: artifact.polygons,
    fitBounds: day?.fitBounds ?? null,
  }
}

function resolveStaticMapType(
  request: ReturnType<typeof parseStaticMapRequest>,
  artifact: MapArtifact
): z.infer<typeof StaticMapBasemapSchema> {
  if (request.basemap) return request.basemap
  return artifact.basemap === "satellite-streets" ? "hybrid" : "satellite"
}

function staticMarkerParam(pin: MapPin, index: number): string {
  const parts = [`color:${staticColor(pin.color ?? "#2563eb")}`]
  const label = staticMarkerLabel(pin.label, index)
  if (label) parts.push(`label:${label}`)
  parts.push(staticCoord(pin.position))
  return parts.join("|")
}

function staticMarkerLabel(label: string | undefined, index: number): string {
  const first = label?.trim().match(/[A-Za-z0-9]/)?.[0]
  if (first) return first.toUpperCase()
  if (index < 9) return String(index + 1)
  return ""
}

function staticRoutePathParam(route: MapRoute): string | null {
  if (route.coordinates.length < 2) return null
  const coords = sampleCoordinates(route.coordinates, MAX_STATIC_PATH_POINTS)
  return [
    `color:${staticColor(route.color ?? "#0891b2")}cc`,
    `weight:${Math.max(1, Math.min(20, route.width ?? 5))}`,
    ...coords.map(staticCoord),
  ].join("|")
}

function staticPolygonPathParams(polygon: MapPolygon): string[] {
  const color = staticColor(polygon.color ?? "#2563eb")
  const fillAlpha = Math.round((polygon.fillOpacity ?? 0.18) * 255)
    .toString(16)
    .padStart(2, "0")
  return polygon.rings.map((ring) => {
    const closed = closeRing(sampleCoordinates(ring, MAX_STATIC_PATH_POINTS))
    return [
      `color:${color}ff`,
      `fillcolor:${color}${fillAlpha}`,
      "weight:2",
      ...closed.map(staticCoord),
    ].join("|")
  })
}

function sampleCoordinates(
  coordinates: MapCoordinate[],
  maxPoints: number
): MapCoordinate[] {
  if (coordinates.length <= maxPoints) return coordinates
  const sampled: MapCoordinate[] = []
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * (coordinates.length - 1)) / (maxPoints - 1))
    sampled.push(coordinates[index])
  }
  return sampled
}

function closeRing(ring: MapCoordinate[]): MapCoordinate[] {
  if (ring.length === 0) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return ring
  return [...ring, first]
}

function staticCoord([lng, lat]: MapCoordinate): string {
  return `${roundCoord(lat)},${roundCoord(lng)}`
}

function roundCoord(value: number): string {
  return String(Number(value.toFixed(6)))
}

function staticColor(value: string): string {
  return `0x${value.replace(/^#/, "").toLowerCase()}`
}

function bboxCenter(bounds: [number, number, number, number]): MapCoordinate {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
}
