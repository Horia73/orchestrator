import { NextResponse } from 'next/server'
import { setFavorites } from '@/lib/config'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * PUT — replace the entire favorites list (used for reorder + bulk updates).
 * Body: { favorites: string[] } where each entry is "providerId:modelId".
 * Invalid entries (pointing to unknown models) are dropped silently.
 */
export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (!body || typeof body !== 'object' || !Array.isArray((body as { favorites?: unknown }).favorites)) {
            return NextResponse.json({ error: 'Body must be { favorites: string[] }' }, { status: 400 })
        }

        const favorites = (body as { favorites: unknown[] }).favorites
        if (!favorites.every(f => typeof f === 'string')) {
            return NextResponse.json({ error: 'favorites entries must be strings' }, { status: 400 })
        }

        const updated = setFavorites(favorites as string[])
        return NextResponse.json({ success: true, favorites: updated.favorites })
  })
}
