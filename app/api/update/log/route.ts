import { getDockerHostUpdaterLogConfig } from '@/lib/update/manager'

// SSE responses must not be buffered or pre-rendered, and they have no
// meaningful cache key — keep the route fully dynamic.
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const SSE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
}

function plainResponse(message: string, status: number): Response {
    return new Response(message, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
}

/**
 * Proxies the docker-update-bridge `/update-log` SSE stream back to the
 * browser. Forwards `Last-Event-ID` so the bridge can resume from the byte
 * offset where the previous connection dropped. Aborts the upstream fetch
 * when the client disconnects so the bridge thread shuts down promptly.
 */
export async function GET(request: Request): Promise<Response> {
    const config = getDockerHostUpdaterLogConfig()
    if (!config) {
        return plainResponse('Docker host updater is not configured.', 404)
    }

    const upstreamHeaders: Record<string, string> = {
        Authorization: `Bearer ${config.token}`,
        Accept: 'text/event-stream',
    }
    const lastEventId = request.headers.get('last-event-id')
    if (lastEventId) upstreamHeaders['Last-Event-ID'] = lastEventId

    let upstream: Response
    try {
        upstream = await fetch(config.url, {
            headers: upstreamHeaders,
            cache: 'no-store',
            // Propagate client cancellation so the bridge stops streaming.
            signal: request.signal,
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error'
        return plainResponse(`Host updater unreachable: ${message}`, 502)
    }

    if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '')
        return plainResponse(
            `Host updater returned HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`,
            502
        )
    }

    return new Response(upstream.body, { status: 200, headers: SSE_HEADERS })
}
