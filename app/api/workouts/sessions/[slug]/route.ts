import { NextResponse } from 'next/server'

import { readSessionLog } from '@/lib/workout/storage'
import { formatSessionMarkdown } from '@/lib/workout/save-session'

/**
 * GET /api/workouts/sessions/:slug
 *
 * Returns the full session log JSON + the rendered markdown. The page uses
 * the markdown for the inline drawer view; deep dives or analytics use the
 * full JSON.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ slug: string }> },
) {
    const { slug } = await params
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
        return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
    }
    const log = readSessionLog(slug)
    if (!log) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    return NextResponse.json({
        log,
        markdown: formatSessionMarkdown(log),
    })
}
