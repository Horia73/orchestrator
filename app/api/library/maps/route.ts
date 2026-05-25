import { NextResponse } from 'next/server'

import { listLatestArtifactsByType } from '@/lib/artifacts/store'
import { MapArtifactSchema } from '@/lib/maps/schema'

/**
 * GET /api/library/maps?limit=100
 *
 * Lists the latest map artifacts across all user conversations with the
 * minimal metadata the grid needs: viewport center (for label / future
 * thumbnail), pin / route / day counts (so the card can say "12 pins · 3
 * days"), basemap, and conversation context.
 */
export interface LibraryMapRow {
    id: string
    identifier: string
    version: number
    title: string
    basemap: 'satellite' | 'satellite-streets'
    center: [number, number]  // [lng, lat]
    zoom?: number
    pinCount: number
    routeCount: number
    polygonCount: number
    dayCount: number
    /** Up to 8 pins for the preview overlay — capped so we don't ship a
     *  thousand coordinates for a heavy trip planner. The grid card only
     *  needs a few dots; the real map shows everything. */
    previewPins: Array<{ lng: number; lat: number; label?: string }>
    /** First pin label (or first day's first pin) — drives the fallback
     *  display title when the artifact title is empty / generic. */
    firstPinLabel?: string
    conversationId: string
    conversationTitle: string | null
    createdAt: number
}

export async function GET(request: Request) {
    const url = new URL(request.url)
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100))

    const rows = listLatestArtifactsByType('application/vnd.ant.map', limit)
    const maps: LibraryMapRow[] = []
    for (const r of rows) {
        let parsed: unknown
        try {
            parsed = JSON.parse(r.content)
        } catch {
            continue
        }
        const result = MapArtifactSchema.safeParse(parsed)
        if (!result.success) continue
        const m = result.data
        const dayPins = (m.days ?? []).reduce((s, d) => s + d.pins.length, 0)
        const dayRoutes = (m.days ?? []).reduce((s, d) => s + d.routes.length, 0)

        // Collect up to 8 pin coordinates (top-level + per-day) for the
        // preview overlay. Day pins come second so the user's "general"
        // pins anchor the view if present.
        type PinLike = { position?: [number, number]; label?: string }
        const previewPins: LibraryMapRow['previewPins'] = []
        const extractPin = (p: PinLike) => {
            const coord = p.position
            if (!coord || !Array.isArray(coord) || coord.length !== 2) return
            previewPins.push({
                lng: coord[0],
                lat: coord[1],
                label: p.label,
            })
        }
        for (const p of m.pins) {
            if (previewPins.length >= 8) break
            extractPin(p as unknown as PinLike)
        }
        for (const day of m.days ?? []) {
            for (const p of day.pins) {
                if (previewPins.length >= 8) break
                extractPin(p as unknown as PinLike)
            }
        }
        const firstPinLabel = previewPins.find((p) => p.label && p.label.trim().length > 0)?.label

        maps.push({
            id: r.id,
            identifier: r.identifier,
            version: r.version,
            title: r.title,
            basemap: m.basemap,
            center: m.viewport.center,
            zoom: m.viewport.zoom,
            pinCount: m.pins.length + dayPins,
            routeCount: m.routes.length + dayRoutes,
            polygonCount: m.polygons.length,
            dayCount: m.days?.length ?? 0,
            previewPins,
            firstPinLabel,
            conversationId: r.conversationId,
            conversationTitle: r.conversationTitle,
            createdAt: r.createdAt,
        })
    }

    return NextResponse.json({ maps, total: maps.length })
}
