import { chatEventEmitter, ChatEvent } from '@/lib/events'
import {
    relayDurableAiWorkerEventStream,
    shouldProxyToDurableAiWorker,
} from '@/lib/ai/durable-worker'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return runWithRequestProfile(req, async (current) => {
        const profileId = current.profile.id
        const encoder = new TextEncoder()
        let listener: ((event: ChatEvent) => void) | null = null
        let pingInterval: ReturnType<typeof setInterval> | null = null
        const workerRelayController = new AbortController()
        let closed = false

        const cleanup = () => {
            if (closed) return
            closed = true
            workerRelayController.abort()
            if (listener) chatEventEmitter.off('chat:update', listener)
            if (pingInterval) clearInterval(pingInterval)
            req.signal.removeEventListener('abort', cleanup)
        }

        const stream = new ReadableStream({
            start(controller) {
                const send = (chunk: string | Uint8Array) => {
                    if (closed) return
                    try {
                        controller.enqueue(
                            typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
                        )
                    } catch {
                        cleanup()
                    }
                }

                // Send initial connection successful ping
                send(': connected\n\n')
                if (closed) return

                // Define the listener
                listener = (event: ChatEvent) => {
                    if (event.profileId && event.profileId !== profileId) return
                    send(`data: ${JSON.stringify(event)}\n\n`)
                }

                // Attach listener to global emitter
                chatEventEmitter.on('chat:update', listener)

                // Send a ping every 30 seconds to keep the connection alive
                pingInterval = setInterval(() => send(': ping\n\n'), 30000)

                if (shouldProxyToDurableAiWorker()) {
                    // The durable worker has its own process-local event
                    // emitter. Merge its SSE into this browser connection so
                    // terminal assistant rows still mark inactive/background
                    // conversations unread. Retry here because EventSource is
                    // connected successfully to web and therefore cannot know
                    // that only the internal worker leg was rotated.
                    void (async () => {
                        while (!closed) {
                            await relayDurableAiWorkerEventStream(
                                req,
                                send,
                                workerRelayController.signal,
                            )
                            if (closed) return
                            await new Promise(resolve => setTimeout(resolve, 1000))
                        }
                    })()
                }

                // Handle client disconnect gracefully by checking req.signal
                req.signal.addEventListener('abort', cleanup, { once: true })
                if (req.signal.aborted) cleanup()
            },
            cancel() {
                cleanup()
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
