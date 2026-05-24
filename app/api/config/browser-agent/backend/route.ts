import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import {
    getRuntimeConfig,
    setBrowserAgentBackend,
    type BrowserAgentSettings,
} from '@/lib/config'

type BrowserAgentBackend = BrowserAgentSettings['backend']

function isBrowserAgentBackend(value: unknown): value is BrowserAgentBackend {
    return value === 'auto' || value === 'patchright' || value === 'official-display'
}

export async function PUT(request: Request) {
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

    const backend = (body as Record<string, unknown>).backend
    if (!isBrowserAgentBackend(backend)) {
        return NextResponse.json({ error: 'backend must be "auto", "patchright", or "official-display"' }, { status: 400 })
    }

    setBrowserAgentBackend(backend)
    const { shutdownBrowserSessionManager } = await import('@/lib/ai/providers/browser-session-manager')
    await shutdownBrowserSessionManager()

    return NextResponse.json({ success: true, config: getRuntimeConfig() })
}
