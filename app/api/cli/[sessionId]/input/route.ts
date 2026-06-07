import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { writeInput } from '@/lib/cli/sessions'
import { runWithRequestProfile } from "@/lib/profiles/server"

/** POST /api/cli/:sessionId/input — forward text into the subprocess stdin. */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { sessionId } = await params

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        const data = (body as Record<string, unknown>)?.data
        if (typeof data !== 'string') {
            return NextResponse.json({ error: 'Body must be { data: string }' }, { status: 400 })
        }

        const ok = writeInput(sessionId, data)
        if (!ok) {
            return NextResponse.json({ error: 'Session not active' }, { status: 410 })
        }
        return NextResponse.json({ ok: true })
  })
}
