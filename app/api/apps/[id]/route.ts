import { NextResponse } from 'next/server'

import { deleteApp, getApp } from '@/lib/apps/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/** GET /api/apps/:id — one registered app by registry id or slug. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const { id } = await params
        const app = getApp(id)
        if (!app) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        return NextResponse.json({ app })
  })
}

/** DELETE /api/apps/:id — unregister the app. Its code artifact stays in the conversation. */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const { id } = await params
        const deleted = deleteApp(id)
        if (!deleted) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true })
  })
}
