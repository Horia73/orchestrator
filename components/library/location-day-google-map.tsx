"use client"

import * as React from "react"
import { MapPinned } from "lucide-react"

import {
  MapRenderer,
  type MapActionCommand,
} from "@/components/artifacts/renderers/map-renderer"
import { cn } from "@/lib/utils"
import type {
  LocationCoordinate,
  LocationStop,
} from "@/lib/location-intelligence/schema"
import type {
  MapArtifact,
  MapCoordinate,
  MapPin,
  MapRoute,
} from "@/lib/maps/schema"

function isCoordinate(
  value: LocationCoordinate | null
): value is LocationCoordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function viewportForCoordinates(
  coords: MapCoordinate[]
): MapArtifact["viewport"] {
  if (coords.length === 0) {
    return { center: [23.589954, 46.77121], zoom: 12 }
  }

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

  const lngSpan = Math.max(east - west, 0.001)
  const latSpan = Math.max(north - south, 0.001)
  const span = Math.max(lngSpan, latSpan)
  const zoom = clamp(Math.floor(14 - Math.log2(span / 0.01)), 2, 17)

  return {
    center: [(west + east) / 2, (south + north) / 2],
    zoom,
  }
}

function stopColor(stop: LocationStop): string {
  const label = stop.label.toLowerCase()
  const kind = stop.kind?.toLowerCase() ?? ""
  if (label === "home" || kind.includes("home")) return "#059669"
  if (label.includes("gym") || kind.includes("gym")) return "#2563eb"
  if (kind.includes("pass")) return "#d97706"
  return "#e11d48"
}

function stopIcon(stop: LocationStop): string {
  const label = stop.label.toLowerCase()
  if (label === "home") return "star"
  if (label.includes("gym")) return "flag"
  return "dot"
}

function coordinateKey(position: MapCoordinate): string {
  return `${position[0].toFixed(5)},${position[1].toFixed(5)}`
}

function roundedCoordinate([lng, lat]: MapCoordinate): MapCoordinate {
  return [Number(lng.toFixed(7)), Number(lat.toFixed(7))]
}

function offsetCoordinate(
  [lng, lat]: MapCoordinate,
  index: number,
  total: number
): MapCoordinate {
  if (index === 0 || total <= 1) return [lng, lat]

  const radiusMeters = 14
  const angle = ((index - 1) / Math.max(1, total - 1)) * Math.PI * 2
  const latOffset = (Math.sin(angle) * radiusMeters) / 111_320
  const lngOffset =
    (Math.cos(angle) * radiusMeters) /
    (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))

  return roundedCoordinate([lng + lngOffset, lat + latOffset])
}

function spreadOverlappingPins(pins: MapPin[]): MapPin[] {
  const groups = new Map<string, MapPin[]>()
  for (const pin of pins) {
    const group = groups.get(coordinateKey(pin.position))
    if (group) group.push(pin)
    else groups.set(coordinateKey(pin.position), [pin])
  }

  return pins.map((pin) => {
    const group = groups.get(coordinateKey(pin.position))
    if (!group || group.length <= 1) return pin
    const index = group.findIndex((candidate) => candidate === pin)
    return {
      ...pin,
      position: offsetCoordinate(
        pin.position,
        Math.max(0, index),
        group.length
      ),
    }
  })
}

function compactTime(value: string | null): string | null {
  if (!value) return null
  if (/^\d{1,2}:\d{2}/.test(value)) return value.slice(0, 5)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed))
}

function stopTimeSummary(stop: LocationStop): string | undefined {
  const start = compactTime(stop.startTime)
  const end = compactTime(stop.endTime)
  const duration =
    typeof stop.durationMinutes === "number" && stop.durationMinutes > 0
      ? Math.round(stop.durationMinutes)
      : null

  if (start && end && start !== end) {
    return duration ? `${start}-${end} · ${duration} min` : `${start}-${end}`
  }
  if (start || end) {
    if (duration && duration > 1) return `${start ?? end} · ${duration} min`
    return `${start ?? end} · <1 min`
  }
  return duration ? `${duration} min` : undefined
}

function buildMapArtifact({
  title,
  route,
  stops,
}: {
  title: string
  route: LocationCoordinate[]
  stops: LocationStop[]
}): MapArtifact | null {
  const pins: MapPin[] = spreadOverlappingPins(
    stops
      .filter((stop) => isCoordinate(stop.position))
      .map((stop, index) => ({
        id: stop.id || `stop-${index + 1}`,
        position: stop.position as MapCoordinate,
        label: stop.label || `Stop ${index + 1}`,
        address: stopTimeSummary(stop),
        description: stop.kind ? `Type: ${stop.kind}` : undefined,
        color: stopColor(stop),
        icon: stopIcon(stop),
      }))
  )

  const routeCoords = route.filter(isCoordinate) as MapCoordinate[]
  const routes: MapRoute[] =
    routeCoords.length >= 2
      ? [
          {
            id: "daily-route",
            coordinates: routeCoords,
            color: "#0891b2",
            width: 5,
            label: "Observed route",
          },
        ]
      : []

  const coordinates = [...routeCoords, ...pins.map((pin) => pin.position)]
  if (coordinates.length === 0) return null

  return {
    basemap: "satellite-streets",
    viewport: viewportForCoordinates(coordinates),
    pins,
    routes,
    polygons: [],
    attribution: "Location Intelligence",
  }
}

export function LocationDayGoogleMap({
  title,
  route,
  stops,
  actionCommand,
  className,
}: {
  title: string
  route: LocationCoordinate[]
  stops: LocationStop[]
  actionCommand?: MapActionCommand | null
  className?: string
}) {
  const artifact = React.useMemo(
    () => buildMapArtifact({ title, route, stops }),
    [route, stops, title]
  )

  if (!artifact) {
    return (
      <div
        className={cn(
          "flex h-full min-h-[520px] w-full items-center justify-center bg-muted/25 text-muted-foreground",
          className
        )}
      >
        <div className="flex flex-col items-center gap-2 text-center text-[12.5px]">
          <MapPinned className="size-7" strokeWidth={1.6} />
          <span>No display coordinates for this day.</span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("relative h-full min-h-[520px]", className)}>
      <MapRenderer
        source={JSON.stringify(artifact)}
        title={title}
        mode="panel"
        hideSidebar
        frameless
        className="h-full min-h-[520px]"
        cameraResetKey={title}
        actionCommand={actionCommand}
      />
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 z-10 w-4 bg-transparent sm:w-5"
      />
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 z-10 w-4 bg-transparent sm:w-5"
      />
    </div>
  )
}
