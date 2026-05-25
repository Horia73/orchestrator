import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { removeSuppressPattern, updateSuppressPatternExpiry } from '@/lib/monitor/store'

// Removing a suppress pattern from the UI is the user's safety valve when the
// model over-suppressed something. The model can also remove patterns via
// monitor_wake_feedback, but a direct UI action skips the wake roundtrip.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; patternId: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const { id, patternId } = await params
        const ok = removeSuppressPattern(id, patternId)
        if (!ok) return NextResponse.json({ error: 'Pattern not found' }, { status: 404 })
        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Failed to remove suppress pattern', error)
        return NextResponse.json({ error: 'Failed to remove pattern' }, { status: 500 })
    }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; patternId: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const { id, patternId } = await params
        const body = await request.json()
        const rawExpiresAt = (body as { expires_at?: unknown }).expires_at
        let expiresAt: number | null
        if (rawExpiresAt === null) {
            expiresAt = null
        } else if (
            typeof rawExpiresAt === 'number'
            && Number.isFinite(rawExpiresAt)
            && rawExpiresAt > Date.now()
        ) {
            expiresAt = Math.floor(rawExpiresAt)
        } else {
            return NextResponse.json(
                { error: 'expires_at must be null or a future timestamp.' },
                { status: 400 },
            )
        }

        const pattern = updateSuppressPatternExpiry(id, patternId, expiresAt)
        if (!pattern) return NextResponse.json({ error: 'Pattern not found' }, { status: 404 })
        return NextResponse.json({
            pattern: {
                id: pattern.id,
                expires_at: pattern.expiresAt,
            },
        })
    } catch (error) {
        if (error instanceof SyntaxError) {
            return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
        }
        console.error('Failed to update suppress pattern', error)
        return NextResponse.json({ error: 'Failed to update pattern' }, { status: 500 })
    }
}
