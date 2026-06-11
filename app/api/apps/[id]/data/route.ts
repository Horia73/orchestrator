import { NextResponse } from 'next/server'

import { getApp, getAppData, setAppData, APP_DATA_MAX_BYTES } from '@/lib/apps/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/** GET /api/apps/:id/data — the app's JSON data document. Used by the AppHost iframe bridge. */
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
        const doc = getAppData(app.id)
        return NextResponse.json(doc)
  })
}

/** PUT /api/apps/:id/data — full replace from the running app (AppHost.setData). */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const { id } = await params
        const app = getApp(id)
        if (!app) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        let body: { data?: unknown }
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        if (body == null || !('data' in body)) {
            return NextResponse.json({ error: 'Body must be { data: … }' }, { status: 400 })
        }
        try {
            const result = setAppData(app.id, body.data, 'replace')
            return NextResponse.json({ updatedAt: result.updatedAt, bytes: result.bytes })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const status = message.includes('too large') ? 413 : 500
            return NextResponse.json({ error: message, cap: APP_DATA_MAX_BYTES }, { status })
        }
  })
}
