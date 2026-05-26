"use client"

/* eslint-disable @next/next/no-img-element */

import * as React from "react"
import { MapPinned } from "lucide-react"

import { cn } from "@/lib/utils"
import type {
  LocationCoordinate,
  LocationStop,
} from "@/lib/location-intelligence/schema"

const TILE_SIZE = 256
const MAP_WIDTH = 1000
const MAP_HEIGHT = 560

function tileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
}

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z)
}

function latToTileY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180
  return (
    ((1 -
      Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2) *
    Math.pow(2, z)
  )
}

function latToWorldY(lat: number): number {
  const latRad = (lat * Math.PI) / 180
  return (
    0.5 -
    Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function viewportForCoordinates(coords: LocationCoordinate[]) {
  if (coords.length === 0) {
    return { center: [0, 0] as LocationCoordinate, zoom: 2 }
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

  const center: LocationCoordinate = [(west + east) / 2, (south + north) / 2]
  const lngSpan = Math.max(0.001, east - west)
  const ySpan = Math.max(0.001, Math.abs(latToWorldY(north) - latToWorldY(south)))
  const lngZoom = Math.log2((MAP_WIDTH * 0.72) / (TILE_SIZE * (lngSpan / 360)))
  const latZoom = Math.log2((MAP_HEIGHT * 0.72) / (TILE_SIZE * ySpan))
  const zoom = clamp(Math.floor(Math.min(lngZoom, latZoom)), 2, 17)
  return { center, zoom }
}

export function LocationDayMap({
  route,
  stops,
  className,
}: {
  route: LocationCoordinate[]
  stops: LocationStop[]
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)
  const stopCoords = stops
    .map((stop) => stop.position)
    .filter((coord): coord is LocationCoordinate => Boolean(coord))
  const coordinates = route.length >= 2 ? [...route, ...stopCoords] : stopCoords
  const viewport = React.useMemo(
    () => viewportForCoordinates(coordinates),
    [coordinates]
  )

  if (coordinates.length === 0 || failed) {
    return (
      <div
        className={cn(
          "flex min-h-[360px] w-full items-center justify-center rounded-lg border border-border/70 bg-muted/25 text-muted-foreground",
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

  const z = viewport.zoom
  const centerTileX = lngToTileX(viewport.center[0], z)
  const centerTileY = latToTileY(viewport.center[1], z)
  const cols = Math.ceil(MAP_WIDTH / TILE_SIZE) + 2
  const rows = Math.ceil(MAP_HEIGHT / TILE_SIZE) + 2
  const baseX = Math.floor(centerTileX - cols / 2)
  const baseY = Math.floor(centerTileY - rows / 2)
  const offsetX = MAP_WIDTH / 2 - (centerTileX - baseX) * TILE_SIZE
  const offsetY = MAP_HEIGHT / 2 - (centerTileY - baseY) * TILE_SIZE
  const maxTile = Math.pow(2, z) - 1

  const point = ([lng, lat]: LocationCoordinate) => ({
    x: (lngToTileX(lng, z) - baseX) * TILE_SIZE + offsetX,
    y: (latToTileY(lat, z) - baseY) * TILE_SIZE + offsetY,
  })

  const routePath =
    route.length >= 2
      ? route
          .map(point)
          .map((p, index) => `${index === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
          .join(" ")
      : ""

  return (
    <div
      className={cn(
        "relative min-h-[360px] overflow-hidden rounded-lg border border-border/70 bg-muted/30",
        className
      )}
      style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
    >
      <div
        className="absolute"
        style={{
          width: cols * TILE_SIZE,
          height: rows * TILE_SIZE,
          transform: `translate(${offsetX}px, ${offsetY}px)`,
        }}
      >
        {Array.from({ length: rows }).map((_, row) =>
          Array.from({ length: cols }).map((__, col) => {
            const tx = baseX + col
            const ty = baseY + row
            if (ty < 0 || ty > maxTile) {
              return (
                <div
                  key={`${col}-${row}`}
                  className="absolute bg-muted"
                  style={{
                    left: col * TILE_SIZE,
                    top: row * TILE_SIZE,
                    width: TILE_SIZE,
                    height: TILE_SIZE,
                  }}
                />
              )
            }
            const wrappedX = ((tx % Math.pow(2, z)) + Math.pow(2, z)) % Math.pow(2, z)
            return (
              <img
                key={`${col}-${row}`}
                src={tileUrl(z, wrappedX, ty)}
                alt=""
                width={TILE_SIZE}
                height={TILE_SIZE}
                loading="lazy"
                onError={() => setFailed(true)}
                className="absolute select-none"
                style={{ left: col * TILE_SIZE, top: row * TILE_SIZE }}
                draggable={false}
              />
            )
          })
        )}
      </div>

      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        style={{ width: "100%", height: "100%" }}
      >
        {routePath ? (
          <>
            <path
              d={routePath}
              fill="none"
              stroke="rgba(15, 23, 42, 0.32)"
              strokeWidth={9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={routePath}
              fill="none"
              stroke="rgb(8, 145, 178)"
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : null}

        {stops.map((stop, index) => {
          if (!stop.position) return null
          const p = point(stop.position)
          const isHome = stop.label.toLowerCase() === "home"
          return (
            <g key={stop.id || index} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
              <circle r={13} fill={isHome ? "rgba(16, 185, 129, 0.22)" : "rgba(244, 63, 94, 0.20)"} />
              <circle
                r={8}
                fill={isHome ? "rgb(16, 185, 129)" : "rgb(244, 63, 94)"}
                stroke="white"
                strokeWidth={2}
              />
              <text
                y={3.2}
                textAnchor="middle"
                className="fill-white text-[9px] font-bold"
              >
                {index + 1}
              </text>
            </g>
          )
        })}
      </svg>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 shadow-[inset_0_0_36px_rgba(0,0,0,0.12)]"
      />
      <span className="pointer-events-none absolute right-1.5 bottom-1 rounded bg-white/85 px-1 py-0.5 text-[8.5px] font-medium text-slate-600 shadow-sm">
        © OpenStreetMap
      </span>
    </div>
  )
}
