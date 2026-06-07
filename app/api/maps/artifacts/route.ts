import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { listLatestArtifactsByType } from '@/lib/artifacts/store'
import { isSmartMapArtifact, saveSmartMapArtifact } from '@/lib/maps/saved-map-artifacts'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 250

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const url = new URL(request.url)
        const limit = clampLimit(url.searchParams.get('limit'))
        const rows = listLatestArtifactsByType('application/vnd.ant.map', limit)

        return NextResponse.json({
            maps: rows.map(row => ({
                id: row.id,
                conversationId: row.conversationId,
                conversationTitle: row.conversationTitle,
                identifier: row.identifier,
                version: row.version,
                title: row.title,
                display: row.display,
                createdAt: row.createdAt,
                deletable: isSmartMapArtifact(row),
            })),
        }, { headers: NO_STORE })
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const body = await request.json().catch(() => null) as Record<string, unknown> | null
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400, headers: NO_STORE })
        }

        const title = typeof body.title === 'string' ? body.title : ''
        const content = typeof body.content === 'string' ? body.content : ''
        const identifier = typeof body.identifier === 'string' ? body.identifier : null
        if (!title.trim()) {
            return NextResponse.json({ error: 'title is required.' }, { status: 400, headers: NO_STORE })
        }
        if (!content.trim()) {
            return NextResponse.json({ error: 'content is required.' }, { status: 400, headers: NO_STORE })
        }

        try {
            const row = saveSmartMapArtifact({ title, content, identifier })
            return NextResponse.json({
                map: {
                    id: row.id,
                    conversationId: row.conversationId,
                    conversationTitle: 'Smart Maps',
                    identifier: row.identifier,
                    version: row.version,
                    title: row.title,
                    display: row.display,
                    createdAt: row.createdAt,
                    deletable: true,
                },
            }, { headers: NO_STORE })
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to save map.' },
                { status: 400, headers: NO_STORE },
            )
        }
  })
}

function clampLimit(value: string | null): number {
    const raw = Number(value ?? DEFAULT_LIMIT)
    if (!Number.isFinite(raw)) return DEFAULT_LIMIT
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)))
}
