import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectGmail } from '@/lib/integrations/gmail'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const origin = resolveRequestOrigin(request)
            const body = await optionalJsonBody(request)
            const connectionId =
                typeof body.connectionId === 'string' ? body.connectionId : undefined
            await disconnectGmail(origin, connectionId)
            return NextResponse.json({ success: true })
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Could not disconnect Gmail' },
                { status: 500 }
            )
        }
  })
}

async function optionalJsonBody(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text().catch(() => '')
    if (!text.trim()) return {}
    try {
        const parsed = JSON.parse(text) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {}
    } catch {
        return {}
    }
}
