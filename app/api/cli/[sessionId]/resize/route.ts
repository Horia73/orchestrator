import { NextResponse } from 'next/server'

import { resizeSession } from '@/lib/cli/sessions'

/**
 * POST /api/cli/:sessionId/resize — inform the PTY of a new geometry.
 * Called by xterm.js after window resize / mount so TUIs lay out correctly.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const cols = (body as Record<string, unknown>)?.cols
    const rows = (body as Record<string, unknown>)?.rows
    if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) {
        return NextResponse.json({ error: 'Body must be { cols: number, rows: number }' }, { status: 400 })
    }

    const ok = resizeSession(sessionId, Math.floor(cols), Math.floor(rows))
    if (!ok) return NextResponse.json({ error: 'Session not active' }, { status: 410 })
    return NextResponse.json({ ok: true })
}
