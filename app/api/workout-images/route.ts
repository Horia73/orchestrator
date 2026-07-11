import { NextResponse } from 'next/server'

import { SlidingWindowRateLimiter } from '@/lib/api/sliding-window-rate-limit'
import { searchWorkoutImages } from '@/lib/workout/image-search'
import { resolveExerciseImage } from '@/lib/workout/exercise-image-db'
import { resolveExerciseGif } from '@/lib/workout/exercise-gif-search'
import { readExerciseImage } from '@/lib/workout/storage'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ERROR_HEADERS = { 'Cache-Control': 'no-store' }
const SUCCESS_HEADERS = { 'Cache-Control': 'public, max-age=3600, s-maxage=86400' }

const RATE_WINDOW_MS = 60_000
const RATE_MAX_REQUESTS = 30
const rateLimiter = new SlidingWindowRateLimiter(RATE_WINDOW_MS, 500)

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
        const limit = clampInt(url.searchParams.get('limit'), 1, 1, 4)
        const name = (url.searchParams.get('name') ?? '').trim().slice(0, 160)
        const id = (url.searchParams.get('id') ?? '').trim().slice(0, 120)
        const muscles = splitList(url.searchParams.get('muscle'))
        const equipment = splitList(url.searchParams.get('equipment'))

        // Authoritative source: a model-verified image saved once for this
        // exercise id (SaveExerciseImage). The model picked it deliberately for
        // this exact movement/machine, so it always wins over the fuzzy chain
        // below — that fuzzy matching is exactly what produced wrong demos.
        if (id) {
            const saved = readExerciseImage(id)
            if (saved?.url) {
                return NextResponse.json(
                    { images: [savedImageResult(saved.url)] },
                    { headers: SUCCESS_HEADERS },
                )
            }
        }

        // Fallback source: ExerciseDB OSS animated GIFs. For a personal,
        // non-commercial workout card, seeing the movement is more useful
        // than a static setup photo. The local Free Exercise DB photo index
        // remains a deterministic fallback when the GIF API has no confident
        // match or is temporarily unavailable.
        if (name || id) {
            const gif = await resolveExerciseGif({ id, name, muscles, equipment })
            if (gif) {
                return NextResponse.json({ images: [gif] }, { headers: SUCCESS_HEADERS })
            }

            const hit = resolveExerciseImage({ id, name, muscles, equipment })
            if (hit) {
                return NextResponse.json({ images: [hit] }, { headers: SUCCESS_HEADERS })
            }
        }

        if (!query) {
            // No library match and nothing to search for → empty (not an error),
            // so the renderer simply hides the demo image.
            return NextResponse.json({ images: [] }, { headers: SUCCESS_HEADERS })
        }

        if (!withinRateLimit(extractClientKey(request))) {
            return NextResponse.json(
                { error: 'Rate limit exceeded. Try again in a minute.' },
                { status: 429, headers: ERROR_HEADERS },
            )
        }

        try {
            const images = await searchWorkoutImages(query, { limit })
            return NextResponse.json({ images }, { headers: SUCCESS_HEADERS })
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown upstream error'
            return NextResponse.json(
                { error: `Workout image search failed: ${message}` },
                { status: 502, headers: ERROR_HEADERS },
            )
        }
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

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    if (raw === null) return fallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

function splitList(raw: string | null): string[] {
    if (!raw) return []
    return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8)
}

function extractClientKey(request: Request): string {
    const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return (fwd || request.headers.get('x-real-ip') || 'local').slice(0, 80)
}

function withinRateLimit(key: string): boolean {
    return rateLimiter.check(key, RATE_MAX_REQUESTS).allowed
}
