import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { removeSuppressPattern } from '@/lib/monitor/store'

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
