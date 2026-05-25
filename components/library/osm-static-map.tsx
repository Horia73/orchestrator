"use client"

import * as React from "react"
import { MapPinned } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * OpenStreetMap-based static map preview. No API key needed — uses the
 * public tile.openstreetmap.org raster tiles.
 *
 * Strategy: we compute the slippy-tile coordinates for the requested
 * center at the requested zoom, then build a 3×3 grid of tiles around it
 * so the center sits comfortably in the middle (a single tile would put
 * the center near a tile edge whenever the lng/lat happens to be close
 * to a tile boundary). The 3×3 also gives us peripheral context — the
 * neighbourhood, not just the spot.
 *
 * Pins overlay: SVG dots rendered at the right relative (x, y) inside
 * the visible viewport, computed from each pin's lng/lat. They're not
 * the actual Google-Maps marker glyphs (we never have access to those
 * here); they're branded dots that match the artifact's accent colour.
 *
 * Tile attribution is required by OSM's tile usage policy — small text
 * in the corner. We cap dimensions and add a `lazy` loading attr so a
 * Library page with many maps doesn't hammer the tile server.
 */

const TILE_SIZE = 256
// Use OSM main tile server. Public, free, requires attribution.
const TILE_URL = (z: number, x: number, y: number) =>
    `https://tile.openstreetmap.org/${z}/${x}/${y}.png`

function lngToTileX(lng: number, z: number): number {
    return ((lng + 180) / 360) * Math.pow(2, z)
}

function latToTileY(lat: number, z: number): number {
    const latRad = (lat * Math.PI) / 180
    return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, z)
}

export interface OsmPin {
    lng: number
    lat: number
    /** Optional tailwind colour class for the dot fill (e.g. text-rose-500). */
    colorClass?: string
}

export function OsmStaticMap({
    center,
    zoom,
    pins = [],
    className,
    width = 640,
    height = 360,
}: {
    /** [lng, lat] center coordinate, GeoJSON order. */
    center: [number, number]
    /** OSM zoom 0..19. Clamped to 1..18 for tile availability. */
    zoom: number
    pins?: OsmPin[]
    className?: string
    width?: number
    height?: number
}) {
    const [failed, setFailed] = React.useState(false)
    const [tileLoadCount, setTileLoadCount] = React.useState(0)

    const z = Math.max(1, Math.min(18, Math.round(zoom)))
    const [lng, lat] = center

    // Float tile coordinates of the center.
    const centerTileX = lngToTileX(lng, z)
    const centerTileY = latToTileY(lat, z)

    // 3×3 grid of integer tile coords surrounding the center.
    const baseX = Math.floor(centerTileX) - 1
    const baseY = Math.floor(centerTileY) - 1

    // The viewport is 3×TILE_SIZE wide; we'll center it on the float
    // center coordinate by shifting the tile grid by (frac - 0.5).
    const fracX = centerTileX - Math.floor(centerTileX)
    const fracY = centerTileY - Math.floor(centerTileY)
    // Offset (in pixels) from the top-left of the 3×3 grid to the center.
    // The center should land at (viewport / 2). The center inside the
    // middle tile is at (TILE_SIZE + fracX * TILE_SIZE, TILE_SIZE + fracY * TILE_SIZE)
    // measured from the top-left of the grid. Viewport width is `width`,
    // so we translate the grid by (viewportCenter - inGridCenter).
    const grid3 = TILE_SIZE * 3
    const inGridX = TILE_SIZE + fracX * TILE_SIZE
    const inGridY = TILE_SIZE + fracY * TILE_SIZE
    const offsetX = width / 2 - inGridX
    const offsetY = height / 2 - inGridY

    const totalTiles = 9
    const allLoaded = tileLoadCount >= totalTiles

    // Convert a pin's lng/lat to a pixel position inside the viewport.
    const pinPos = (p: OsmPin): { x: number; y: number; visible: boolean } => {
        const pinTileX = lngToTileX(p.lng, z)
        const pinTileY = latToTileY(p.lat, z)
        // Position relative to the 3×3 grid top-left, then add offset.
        const gridX = (pinTileX - baseX) * TILE_SIZE
        const gridY = (pinTileY - baseY) * TILE_SIZE
        const x = gridX + offsetX
        const y = gridY + offsetY
        const visible = x >= -8 && x <= width + 8 && y >= -8 && y <= height + 8
        return { x, y, visible }
    }

    if (failed) {
        return (
            <div className={cn(
                "flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-sky-500/15",
                className,
            )}>
                <MapPinned className="size-8 text-foreground/35" strokeWidth={1.4} aria-hidden />
            </div>
        )
    }

    return (
        <div
            className={cn(
                "relative w-full overflow-hidden bg-muted/40",
                className,
            )}
            style={{ aspectRatio: `${width} / ${height}` }}
        >
            {/* Tile grid container — positioned so the center sits at viewport center. */}
            <div
                className="absolute"
                style={{
                    width: grid3,
                    height: grid3,
                    transform: `translate(${offsetX}px, ${offsetY}px)`,
                    opacity: allLoaded ? 1 : 0.25,
                    transition: "opacity 200ms ease",
                }}
            >
                {Array.from({ length: 3 }).map((_, dy) =>
                    Array.from({ length: 3 }).map((__, dx) => {
                        const tx = baseX + dx
                        const ty = baseY + dy
                        const maxTile = Math.pow(2, z) - 1
                        // Out-of-bounds tiles (poles) render blank; OSM
                        // wraps longitude server-side so we don't worry
                        // about x wrap.
                        if (ty < 0 || ty > maxTile) {
                            return (
                                <div
                                    key={`${dx}-${dy}`}
                                    className="absolute bg-muted"
                                    style={{
                                        left: dx * TILE_SIZE,
                                        top: dy * TILE_SIZE,
                                        width: TILE_SIZE,
                                        height: TILE_SIZE,
                                    }}
                                />
                            )
                        }
                        const wrappedX = ((tx % Math.pow(2, z)) + Math.pow(2, z)) % Math.pow(2, z)
                        return (
                            <img
                                key={`${dx}-${dy}`}
                                src={TILE_URL(z, wrappedX, ty)}
                                alt=""
                                width={TILE_SIZE}
                                height={TILE_SIZE}
                                loading="lazy"
                                onLoad={() => setTileLoadCount((n) => n + 1)}
                                onError={() => setFailed(true)}
                                className="absolute select-none"
                                style={{
                                    left: dx * TILE_SIZE,
                                    top: dy * TILE_SIZE,
                                }}
                                draggable={false}
                            />
                        )
                    })
                )}
            </div>

            {/* Soft inner shadow so tile edges blend with the card border. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 shadow-[inset_0_0_30px_rgba(0,0,0,0.10)]"
            />

            {/* Pin overlay */}
            {pins.length > 0 ? (
                <svg
                    aria-hidden
                    className="pointer-events-none absolute inset-0"
                    width={width}
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                    style={{ width: '100%', height: '100%' }}
                >
                    {pins.map((p, i) => {
                        const pos = pinPos(p)
                        if (!pos.visible) return null
                        return (
                            <g key={i} transform={`translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`}>
                                <circle r={6} fill="rgba(244, 63, 94, 0.25)" />
                                <circle r={4} fill="rgb(244, 63, 94)" stroke="white" strokeWidth={1.5} />
                            </g>
                        )
                    })}
                </svg>
            ) : null}

            {/* Attribution (OSM requires it on every static map view) */}
            <span className="pointer-events-none absolute bottom-1 right-1.5 rounded bg-white/85 px-1 py-0.5 text-[8.5px] font-medium text-slate-600 shadow-sm">
                © OpenStreetMap
            </span>
        </div>
    )
}
