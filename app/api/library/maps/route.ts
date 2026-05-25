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
            conversationId: r.conversationId,
            conversationTitle: r.conversationTitle,
            createdAt: r.createdAt,
        })
    }

    return NextResponse.json({ maps, total: maps.length })
}
