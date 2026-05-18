import { getSession, subscribe, type SessionEvent } from '@/lib/cli/sessions'

/**
 * GET /api/cli/:sessionId/stream — SSE for stdout/stderr/exit events.
 *
 * Replays the rolling buffer first so reconnects after a refresh see the
 * full session history, then attaches as a live listener until the client
 * disconnects or the session exits.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params
    const session = getSession(sessionId)
    if (!session) {
        return new Response(JSON.stringify({ error: 'Unknown session' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const enc = new TextEncoder()
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let closed = false

    const stream = new ReadableStream({
        start(controller) {
            const send = (event: SessionEvent) => {
                if (closed) return
                try {
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
                } catch {
                    closed = true
                }
            }

            const sub = subscribe(sessionId, send)
            if (!sub) {
                controller.close()
                return
            }
            unsubscribe = sub.unsubscribe

            // Replay history.
            for (const ev of sub.history) send(ev)

            // If the session already exited, close after the final event flushes.
            if (session.exited) {
                setTimeout(() => { try { controller.close() } catch { /* closed */ } }, 50)
                return
            }

            // Comment heartbeat so proxies don't time the connection out.
            heartbeat = setInterval(() => {
                if (closed) return
                try {
                    controller.enqueue(enc.encode(`: ping\n\n`))
                } catch {
                    closed = true
                }
            }, 25_000)
        },
        cancel() {
            closed = true
            if (unsubscribe) unsubscribe()
            if (heartbeat) clearInterval(heartbeat)
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    })
}
