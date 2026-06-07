import { NextResponse } from 'next/server'

import { closeSession, describeSession } from '@/lib/cli/sessions'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
  return runWithRequestProfile(_request, async () => {
        const { sessionId } = await params
        const session = describeSession(sessionId)
        if (!session) return NextResponse.json({ error: 'Unknown session' }, { status: 404 })
        return NextResponse.json(session)
  })
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
  return runWithRequestProfile(_request, async () => {
        const { sessionId } = await params
        const ok = closeSession(sessionId, 'user')
        if (!ok) return NextResponse.json({ error: 'Unknown session' }, { status: 404 })
        return NextResponse.json({ ok: true })
  })
}
