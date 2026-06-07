import { observabilityEventEmitter, type ObservabilityEvent } from '@/lib/observability/events'
import { runWithAdminCookieProfile } from "@/lib/profiles/server"

/**
 * SSE endpoint for live-tailing the Logs tab. Emits a small event whenever a
 * request_log row is inserted or updated. The client refetches the affected
 * row (or the head of the list) on each event — keeping the wire format tiny.
 */
export async function GET() {
  return runWithAdminCookieProfile(async () => {
        const enc = new TextEncoder()
        let listener: ((e: ObservabilityEvent) => void) | null = null
        let heartbeat: ReturnType<typeof setInterval> | null = null

        const stream = new ReadableStream({
            start(controller) {
                const send = (data: unknown) => {
                    try {
                        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
                    } catch { /* closed */ }
                }

                send({ type: 'ready' })

                listener = (event: ObservabilityEvent) => send(event)
                observabilityEventEmitter.on('observability:update', listener)

                // Comment heartbeat so proxies don't time the connection out.
                heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(enc.encode(`: ping\n\n`))
                    } catch { /* closed */ }
                }, 25000)
            },
            cancel() {
                if (listener) observabilityEventEmitter.off('observability:update', listener)
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
  })
}
