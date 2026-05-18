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
    if (action !== 'take_control' && action !== 'release_control') {
        return NextResponse.json({ error: 'action must be take_control or release_control' }, { status: 400 })
    }

    const state = await getBrowserSessionManager().setHumanControl(action === 'take_control')
    return NextResponse.json(toClientState(request, state), {
        headers: { 'Cache-Control': 'no-store' },
    })
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
