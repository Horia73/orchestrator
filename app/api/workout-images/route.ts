import { NextResponse } from 'next/server'

import { readExerciseImage } from '@/lib/workout/storage'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SUCCESS_HEADERS = { 'Cache-Control': 'public, max-age=3600, s-maxage=86400' }

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const id = (url.searchParams.get('id') ?? '').trim().slice(0, 120)

        // Display is intentionally limited to the model-verified, persistent
        // image library. Candidate discovery belongs to SearchExerciseImages +
        // SaveExerciseImage, where the model can deliberately inspect/match the
        // exact movement once. A missing image is safer than a blind fuzzy guess.
        if (id) {
            const saved = readExerciseImage(id)
            if (saved?.url) {
                return NextResponse.json(
                    { images: [savedImageResult(saved.url)] },
                    { headers: SUCCESS_HEADERS },
                )
            }
        }

        return NextResponse.json({ images: [] }, { headers: SUCCESS_HEADERS })
  })
}

function savedImageResult(url: string) {
    const isGif = /\.gif(?:[?#]|$)/i.test(url)
    return {
        url,
        sourceUrl: url,
        attribution: 'Verified',
        // Aspect ratio is unknown for a saved URL; the renderer only uses this
        // to reserve space and avoid layout shift.
        width: isGif ? 1 : 4,
        height: isGif ? 1 : 3,
        mime: isGif ? 'image/gif' : 'image/jpeg',
    }
}
