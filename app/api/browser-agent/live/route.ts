import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import type { BrowserLiveViewClientState } from '@/lib/ai/providers/browser-session-manager'

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const state = await getBrowserSessionManager().getLiveViewState()
    return NextResponse.json(toClientState(request, state), {
        headers: { 'Cache-Control': 'no-store' },
    })
}

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const action = (body as Record<string, unknown>)?.action
    const manager = getBrowserSessionManager()

    if (action === 'take_control' || action === 'release_control') {
        const state = await manager.setHumanControl(action === 'take_control')
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
        const state = await manager.pasteText(text)
        return NextResponse.json(toClientState(request, state), {
            headers: { 'Cache-Control': 'no-store' },
        })
    }

    if (action === 'press_key') {
        const key = (body as Record<string, unknown>)?.key
        if (!isSafeBrowserKey(key)) {
            return NextResponse.json({ error: 'key is invalid' }, { status: 400 })
        }
        const state = await manager.pressKey(key)
        return NextResponse.json(toClientState(request, state), {
            headers: { 'Cache-Control': 'no-store' },
        })
    }

    return NextResponse.json({ error: 'unsupported browser live action' }, { status: 400 })
}

function isSafeBrowserKey(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80) return false
    return /^[A-Za-z0-9+_.=\-/,;'\[\]\\` ]+$/.test(value)
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
        controlMode: state.controlMode,
        running: state.running,
        paused: state.paused,
        sessions: state.sessions,
    }
}

function buildWsUrl(request: Request, state: BrowserLiveViewClientState): string | null {
    if (!state.ready || !state.wsToken || !state.wsPort) return null

    const publicUrl = process.env.BROWSER_AGENT_VNC_WS_PUBLIC_URL?.trim()
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
