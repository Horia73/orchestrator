const AI_WORKER_URL_ENV = 'ORCHESTRATOR_AI_WORKER_URL'
const AI_WORKER_PROCESS_ENV = 'ORCHESTRATOR_AI_WORKER_PROCESS'

const HOP_BY_HOP_HEADERS = [
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]

export function isDurableAiWorkerProcess(): boolean {
    return process.env[AI_WORKER_PROCESS_ENV] === '1'
}

export function durableAiWorkerUrl(): string | null {
    const raw = process.env[AI_WORKER_URL_ENV]?.trim()
    if (!raw) return null
    try {
        const url = new URL(raw)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        return url.toString().replace(/\/$/, '')
    } catch {
        return null
    }
}

export function shouldProxyToDurableAiWorker(): boolean {
    return !isDurableAiWorkerProcess() && durableAiWorkerUrl() !== null
}

/** The durable worker is the single owner of schedulers and other background
 * machinery in split-process installs. Standalone/dev installs retain the
 * historical single-process behavior. */
export function ownsDurableAiBackgroundWork(): boolean {
    return isDurableAiWorkerProcess() || durableAiWorkerUrl() === null
}

/** Proxy an authenticated app request to the durable worker. The upstream
 * fetch is intentionally NOT tied to request.signal: losing the browser/main
 * web connection must not cancel a turn that the worker already accepted. */
export async function proxyToDurableAiWorker(
    request: Request,
    pathOverride?: string,
): Promise<Response> {
    const base = durableAiWorkerUrl()
    if (!base || isDurableAiWorkerProcess()) {
        return unavailableResponse('Durable AI worker is not configured for proxying.')
    }

    let sourceUrl: URL
    try {
        sourceUrl = new URL(request.url)
    } catch {
        return unavailableResponse('The incoming request URL is invalid.')
    }

    const path = pathOverride ?? `${sourceUrl.pathname}${sourceUrl.search}`
    const target = new URL(path, `${base}/`)
    const headers = new Headers(request.headers)
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)

    // Preserve the browser-visible origin. Sensitive-route guards on the
    // worker must validate the original same-origin request, not the private
    // Docker service hostname used for this hop.
    const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
        || firstHeaderValue(request.headers.get('host'))
        || sourceUrl.host
    const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'))
        || sourceUrl.protocol.replace(':', '')
    headers.set('host', forwardedHost)
    headers.set('x-forwarded-host', forwardedHost)
    headers.set('x-forwarded-proto', forwardedProto)
    headers.set('x-orchestrator-ai-worker-proxy', '1')
    const serviceToken = (
        process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
        || ''
    ).trim()
    if (serviceToken) headers.set('x-orchestrator-ai-worker-token', serviceToken)

    const method = request.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : await request.arrayBuffer()

    try {
        const upstream = await fetch(target, {
            method,
            headers,
            body,
            redirect: 'manual',
            cache: 'no-store',
        })
        const responseHeaders = new Headers(upstream.headers)
        for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name)
        responseHeaders.set('Cache-Control', 'no-store')
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'connection failed'
        return unavailableResponse(`Durable AI worker is unavailable: ${reason}`)
    }
}

/** Relay one durable-worker SSE connection into a caller-owned stream.
 *
 * The browser's /api/sync connection terminates on the web process, while AI
 * completion events originate in the split durable worker. Keeping this
 * relay separate from the generic request proxy lets the sync route merge
 * both processes' event emitters without giving up web-local events such as
 * conversation read/title/archive changes.
 */
export async function relayDurableAiWorkerEventStream(
    request: Request,
    onFrame: (frame: Uint8Array) => void,
    signal?: AbortSignal,
): Promise<boolean> {
    const upstream = await proxyToDurableAiWorker(request, '/api/sync')
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!upstream.ok || !upstream.body || !contentType.includes('text/event-stream')) {
        await upstream.body?.cancel().catch(() => {})
        return false
    }

    if (signal?.aborted) {
        await upstream.body.cancel().catch(() => {})
        return true
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let pending = ''
    const flushFrames = () => {
        while (pending) {
            const boundary = /\r?\n\r?\n/.exec(pending)
            if (!boundary || boundary.index === undefined) return
            const end = boundary.index + boundary[0].length
            onFrame(encoder.encode(pending.slice(0, end)))
            pending = pending.slice(end)
        }
    }
    const cancel = () => {
        void reader.cancel().catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })

    try {
        while (!signal?.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (value?.length) {
                pending += decoder.decode(value, { stream: true })
                // Emit only complete SSE frames. Otherwise a web-local event
                // could be enqueued between two network chunks of one worker
                // event and corrupt the browser's EventSource stream.
                flushFrames()
            }
        }
        pending += decoder.decode()
        flushFrames()
        return true
    } catch {
        return false
    } finally {
        signal?.removeEventListener('abort', cancel)
        try {
            reader.releaseLock()
        } catch {
            // A cancellation can release/close the reader before cleanup.
        }
    }
}

function firstHeaderValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

function unavailableResponse(message: string): Response {
    return new Response(
        JSON.stringify({
            error: message,
            chatMessage: 'The AI worker is restarting. Your request was not discarded; please retry in a few seconds.',
            code: 'ai_worker_unavailable',
        }),
        {
            status: 503,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Retry-After': '3',
            },
        },
    )
}
