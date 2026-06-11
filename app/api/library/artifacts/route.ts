import { NextResponse } from 'next/server'

import { listLatestArtifactsExcludingTypes } from '@/lib/artifacts/store'
import { resolveAppForArtifact } from '@/lib/apps/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * GET /api/library/artifacts?limit=100
 *
 * Latest version of every conversation artifact that does NOT have its own
 * Library home (workouts/recipes/maps have dedicated tabs, weather cards are
 * transient, app-link cards are chat chrome). Returns metadata only — the
 * grid never needs the body, and html/react artifacts can be large.
 */

/** Types with a dedicated surface elsewhere — excluded from the generic tab. */
const EXCLUDED_TYPES = [
    'application/vnd.ant.workout',
    'application/vnd.ant.recipe',
    'application/vnd.ant.map',
    'application/vnd.ant.weather',
    'application/vnd.ant.app-link',
]

export interface LibraryArtifactRow {
    id: string
    identifier: string
    version: number
    type: string
    title: string
    language: string | null
    display: string | null
    conversationId: string
    conversationTitle: string | null
    createdAt: number
    sizeBytes: number
    /** Set when this artifact is the code of a registered app. */
    appSlug?: string
}

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))

        const rows = listLatestArtifactsExcludingTypes(EXCLUDED_TYPES, limit)
        const artifacts: LibraryArtifactRow[] = rows.map((r) => ({
            id: r.id,
            identifier: r.identifier,
            version: r.version,
            type: r.type,
            title: r.title,
            language: r.language,
            display: r.display,
            conversationId: r.conversationId,
            conversationTitle: r.conversationTitle,
            createdAt: r.createdAt,
            sizeBytes: Buffer.byteLength(r.content, 'utf8'),
            appSlug: resolveAppForArtifact(r.id)?.slug,
        }))

        return NextResponse.json({ artifacts, total: artifacts.length })
  })
}
