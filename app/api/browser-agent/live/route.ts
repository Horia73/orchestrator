import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import type { BrowserLiveViewClientState } from '@/lib/ai/providers/browser-session-manager'
import { getEnvValue } from '@/lib/config'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const sessionId = sessionIdFromRequest(request)
        const state = await getBrowserSessionManager().getLiveViewState(sessionId)
        return NextResponse.json(toClientState(request, state), {
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const action = (body as Record<string, unknown>)?.action
        const sessionId = sessionIdFromBody(body)
        const manager = getBrowserSessionManager()

        if (action === 'take_control' || action === 'release_control') {
            const state = await manager.setHumanControl(action === 'take_control', sessionId)
            return NextResponse.json(toClientState(request, state), {
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        if (action === 'paste_text') {
            const text = (body as Record<string, unknown>)?.text
            if (typeof text !== 'string') {
                return NextResponse.json({ error: 'text must be a string' }, { status: 400 })
            }
            if (text.length > 200_000) {
                return NextResponse.json({ error: 'text is too large' }, { status: 413 })
            }
            const state = await manager.pasteText(text, sessionId)
            return NextResponse.json(toClientState(request, state), {
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        if (action === 'press_key') {
            const key = (body as Record<string, unknown>)?.key
            if (!isSafeBrowserKey(key)) {
                return NextResponse.json({ error: 'key is invalid' }, { status: 400 })
            }
            const state = await manager.pressKey(key, sessionId)
            return NextResponse.json(toClientState(request, state), {
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        if (action === 'copy_from_browser') {
            const key = (body as Record<string, unknown>)?.key
            if (key !== undefined && !isSafeBrowserKey(key)) {
                return NextResponse.json({ error: 'key is invalid' }, { status: 400 })
            }
            const result = await manager.copyFromBrowser(typeof key === 'string' ? key : undefined, sessionId)
            if (result.text && result.text.length > 200_000) {
                return NextResponse.json({ error: 'browser clipboard text is too large' }, { status: 413 })
            }
            return NextResponse.json({
                clipboardText: result.text,
                state: toClientState(request, result.state),
            }, {
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        return NextResponse.json({ error: 'unsupported browser live action' }, { status: 400 })
  })
}

function isSafeBrowserKey(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80) return false
    return /^[A-Za-z0-9+_.=\-/,;'\[\]\\` ]+$/.test(value)
}

function sessionIdFromRequest(request: Request): string | null {
    try {
        return cleanSessionId(new URL(request.url).searchParams.get('sessionId'))
    } catch {
        return null
    }
}

function sessionIdFromBody(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null
    return cleanSessionId((body as Record<string, unknown>).sessionId)
}

function cleanSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 160) return null
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null
}

function toClientState(request: Request, state: BrowserLiveViewClientState) {
    return {
        enabled: state.enabled,
        available: state.available,
        ready: state.ready,
        mode: state.mode,
        platform: state.platform,
        display: state.display,
        width: state.width,
        height: state.height,
        wsUrl: buildWsUrl(request, state),
        reason: state.reason,
        selectedSessionId: state.selectedSessionId,
        controlMode: state.controlMode,
        running: state.running,
        paused: state.paused,
        sessions: state.sessions,
    }
}

function buildWsUrl(request: Request, state: BrowserLiveViewClientState): string | null {
    if (!state.ready || !state.wsToken || !state.wsPort) return null

    const publicUrl = getEnvValue('BROWSER_AGENT_VNC_WS_PUBLIC_URL')?.trim()
    if (publicUrl) {
        return publicUrl.includes('{token}')
            ? publicUrl.replaceAll('{token}', encodeURIComponent(state.wsToken))
            : `${publicUrl.replace(/\/$/, '')}/${encodeURIComponent(state.wsToken)}`
    }

    let requestUrl: URL
    try {
        requestUrl = new URL(request.url)
    } catch {
        return null
    }

    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const protocol = forwardedProto || requestUrl.protocol.replace(':', '')
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws'
    const hostHeader = request.headers.get('host') || requestUrl.host
    const hostname = hostHeader.split(':')[0]
    return `${wsProtocol}://${hostname}:${state.wsPort}/${encodeURIComponent(state.wsToken)}`
}
