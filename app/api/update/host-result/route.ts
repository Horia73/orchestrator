import { NextResponse } from 'next/server'

import { recordHostUpdateResult, verifyDockerHostUpdaterToken } from '@/lib/update/manager'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const auth = request.headers.get('authorization') || ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
    const headerToken = request.headers.get('x-orchestrator-update-token')
    const token = bearer || headerToken

    if (!verifyDockerHostUpdaterToken(token)) {
        return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
    }

    try {
        const body = await request.json() as {
            jobId?: unknown
            phase?: unknown
            error?: unknown
            waitReason?: unknown
        }

        if (typeof body.jobId !== 'string' || !body.jobId) {
            return NextResponse.json({ error: 'Missing update job id.' }, { status: 400 })
        }
        if (body.phase !== 'failed' && body.phase !== 'restarting' && body.phase !== 'completed') {
            return NextResponse.json({ error: 'Invalid update phase.' }, { status: 400 })
        }

        const job = recordHostUpdateResult({
            jobId: body.jobId,
            phase: body.phase,
            error: typeof body.error === 'string' ? body.error : undefined,
            waitReason: typeof body.waitReason === 'string' ? body.waitReason : undefined,
        })

        return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
        return NextResponse.json({
            error: err instanceof Error ? err.message : 'Failed to record host update result.',
        }, {
            status: 409,
            headers: { 'Cache-Control': 'no-store' },
        })
    }
}
