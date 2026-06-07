import { NextResponse } from 'next/server'

import { searchWorkoutImages } from '@/lib/workout/image-search'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
        if (!query) {
            return NextResponse.json({ error: 'Missing query parameter `q`.' }, { status: 400 })
        }
        const [image] = await searchWorkoutImages(query, { limit: 1 })
        if (!image) {
            return NextResponse.json({ error: 'No image found.' }, { status: 404 })
        }
        return NextResponse.redirect(image.url, {
            headers: {
                'Cache-Control': 'public, max-age=3600, s-maxage=86400',
                'X-Workout-Image-Source': image.sourceUrl,
            },
        })
  })
}
