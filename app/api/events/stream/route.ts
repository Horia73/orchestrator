import { appEventEmitter, type AppEvent } from '@/lib/events'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return runWithRequestProfile(req, async (current) => {
        const profileId = current.profile.id
        const encoder = new TextEncoder()
        let listener: ((event: AppEvent) => void) | null = null
        let heartbeat: ReturnType<typeof setInterval> | null = null
        let closed = false

        const cleanup = () => {
            if (closed) return
            closed = true
            if (listener) appEventEmitter.off('app:update', listener)
            if (heartbeat) clearInterval(heartbeat)
            req.signal.removeEventListener('abort', cleanup)
        }

        const stream = new ReadableStream({
            start(controller) {
                const send = (chunk: string) => {
                    if (closed) return
                    try {
                        controller.enqueue(encoder.encode(chunk))
                    } catch {
                        cleanup()
                    }
                }

                send(': connected\n\n')
                listener = (event: AppEvent) => {
                    if (event.profileId && event.profileId !== profileId) return
                    send(`data: ${JSON.stringify(event)}\n\n`)
                }
                appEventEmitter.on('app:update', listener)

                heartbeat = setInterval(() => send(': ping\n\n'), 25000)
                req.signal.addEventListener('abort', cleanup, { once: true })
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
