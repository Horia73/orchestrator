import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getRuntimeConfig, setBrowserAgentProEnabled } from '@/lib/config'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Body must be an object' }, { status: 400 })
        }

        const proEnabled = (body as Record<string, unknown>).proEnabled
        if (typeof proEnabled !== 'boolean') {
            return NextResponse.json({ error: 'proEnabled must be a boolean' }, { status: 400 })
        }

        setBrowserAgentProEnabled(proEnabled)
        // The runtime config (escalation flag) is resolved when a browser session is
        // created, so drop live sessions to make the new mode take effect next task.
        const { shutdownBrowserSessionManager } = await import('@/lib/ai/providers/browser-session-manager')
        await shutdownBrowserSessionManager()

        return NextResponse.json({ success: true, config: getRuntimeConfig() })
  })
}
