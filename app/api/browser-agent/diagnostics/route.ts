import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import { runWithRequestProfile } from "@/lib/profiles/server"
import { proxyToDurableAiWorker, shouldProxyToDurableAiWorker } from '@/lib/ai/durable-worker'

/**
 * Read-only console/network diagnostics for a browser-agent session,
 * polled by the chat side panel while a browser run is visible.
 */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard
        if (shouldProxyToDurableAiWorker()) return proxyToDurableAiWorker(request)

        const sessionId = sessionIdFromRequest(request)
        const result = await getBrowserSessionManager().getSessionDiagnostics(sessionId)
        return NextResponse.json(result, {
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}

function sessionIdFromRequest(request: Request): string | null {
    try {
        return cleanSessionId(new URL(request.url).searchParams.get('sessionId'))
    } catch {
        return null
    }
}

function cleanSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 160) return null
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null
}
