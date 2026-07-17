import {
    currentDurableAiWorkerTarget,
    durableAiWorkerId,
    listDurableAiWorkerTargets,
    type DurableAiWorkerTarget,
} from '@/lib/ai/worker-generations'

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
    return currentDurableAiWorkerTarget()?.url ?? null
}

export function shouldProxyToDurableAiWorker(): boolean {
    return !isDurableAiWorkerProcess() && currentDurableAiWorkerTarget() !== null
}

/** Standalone/dev installs own their background runtime in the web process.
 * Every split worker boots a standby leadership watcher; the generation
 * registry separately elects exactly one background owner. */
export function ownsDurableAiBackgroundWork(): boolean {
    return isDurableAiWorkerProcess() || durableAiWorkerUrl() === null
}

/** Proxy a new request to the fleet's current admission target. An explicit
 * target is used by owner-sensitive control routes and the multi-worker SSE
 * relay while an old generation drains. */
export async function proxyToDurableAiWorker(
    request: Request,
    pathOverride?: string,
    targetOverride?: DurableAiWorkerTarget,
): Promise<Response> {
    const target = targetOverride ?? currentDurableAiWorkerTarget()
    if (!target || isDurableAiWorkerProcess()) {
        return unavailableResponse('Durable AI worker is not configured for proxying.')
    }
    return proxyToTarget(request, target, pathOverride)
}

/** Route Stop/Steer to the generation that owns the active conversation. A
 * request for an inactive conversation falls back to current, preserving the
 * existing pending-stop and normal-send semantics without broadcasting a stop
 * that could accidentally abort a future turn on another generation. */
export async function proxyToConversationOwner(
    request: Request,
    conversationId: string,
): Promise<Response> {
    const owner = await resolveConversationOwner(request, conversationId)
    return proxyToDurableAiWorker(request, undefined, owner ?? undefined)
}

export async function proxyToAgentRunOwner(
    request: Request,
    conversationId: string,
): Promise<Response> {
    const owner = await resolveAgentRunOwner(request, conversationId)
    return proxyToDurableAiWorker(request, undefined, owner ?? undefined)
}

/** Aggregate process-local chat registries across current + draining workers. */
export async function durableAiFleetActiveChatResponse(request: Request): Promise<Response> {
    const targets = listDurableAiWorkerTargets()
    if (targets.length === 0) return unavailableResponse('Durable AI worker is not configured for proxying.')
    let source: URL
    try {
        source = new URL(request.url)
    } catch {
        return unavailableResponse('The incoming request URL is invalid.')
    }
    const conversationId = source.searchParams.get('conversationId')?.trim() || ''
    const results = await Promise.all(targets.map(async target => ({
        target,
        response: await proxyToTarget(request, target, `/api/chat/active${source.search}`),
    })))

    if (conversationId) {
        let currentPayload: Record<string, unknown> | null = null
        for (const result of results) {
            const payload = await jsonObject(result.response)
            if (result.target.id === currentDurableAiWorkerTarget()?.id) currentPayload = payload
            if (payload?.active === true) {
                return jsonResponse({ ...payload, workerId: result.target.id })
            }
        }
        return jsonResponse({ ...(currentPayload ?? { active: false, followUps: [] }), workerId: null })
    }

    const streams: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const result of results) {
        const payload = await jsonObject(result.response)
        const candidates = Array.isArray(payload?.streams) ? payload.streams : []
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object') continue
            const stream = candidate as Record<string, unknown>
            const key = `${String(stream.profileId ?? '')}:${String(stream.conversationId ?? '')}:${String(stream.messageId ?? '')}`
            if (seen.has(key)) continue
            seen.add(key)
            streams.push({ ...stream, workerId: result.target.id })
        }
    }
    streams.sort((left, right) => Number(left.startedAt ?? 0) - Number(right.startedAt ?? 0))
    return jsonResponse({
        active: streams.length > 0,
        streams,
        conversationIds: [...new Set(streams.map(stream => String(stream.conversationId ?? '')).filter(Boolean))],
    })
}

export async function proxyToBrowserSessionOwner(
    request: Request,
    sessionId: string | null,
): Promise<Response> {
    const owner = sessionId ? await resolveBrowserSessionOwner(request, sessionId) : null
    return proxyToDurableAiWorker(request, undefined, owner ?? undefined)
}

/** Apply a shared configuration mutation to every live generation. The current
 * worker's response is authoritative; draining-worker failures are tolerated
 * because their accepted run keeps its already-resolved configuration. */
export async function proxyToAllDurableAiWorkers(request: Request): Promise<Response> {
    const targets = listDurableAiWorkerTargets()
    if (targets.length === 0) return unavailableResponse('Durable AI worker is not configured for proxying.')
    const copies = targets.map(() => request.clone())
    const responses = await Promise.all(targets.map((target, index) =>
        proxyToTarget(copies[index], target),
    ))
    const currentId = currentDurableAiWorkerTarget()?.id
    return responses[targets.findIndex(target => target.id === currentId)] ?? responses[0]
}

/** Relay one durable-worker SSE connection into a caller-owned stream. */
export async function relayDurableAiWorkerEventStream(
    request: Request,
    onFrame: (frame: Uint8Array) => void,
    signal?: AbortSignal,
    targetOverride?: DurableAiWorkerTarget,
): Promise<boolean> {
    const upstream = await proxyToDurableAiWorker(request, '/api/sync', targetOverride)
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
            // Cancellation may close the reader before cleanup.
        }
    }
}

/** Keep one relay leg per registered generation and refresh the set while the
 * browser EventSource stays connected. This is what lets an old completion
 * and a brand-new turn update the UI concurrently across a cutover. */
export async function relayDurableAiWorkerFleetEventStreams(
    request: Request,
    onFrame: (frame: Uint8Array) => void,
    signal: AbortSignal,
): Promise<void> {
    const legs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
    try {
        while (!signal.aborted) {
            const targets = listDurableAiWorkerTargets()
            const wanted = new Set(targets.map(target => target.id))
            for (const [id, leg] of legs) {
                if (wanted.has(id)) continue
                leg.controller.abort()
                legs.delete(id)
            }
            for (const target of targets) {
                if (legs.has(target.id)) continue
                const controller = new AbortController()
                const abort = () => controller.abort()
                signal.addEventListener('abort', abort, { once: true })
                const promise = (async () => {
                    try {
                        while (!controller.signal.aborted && !signal.aborted) {
                            await relayDurableAiWorkerEventStream(request, onFrame, controller.signal, target)
                            if (controller.signal.aborted || signal.aborted) return
                            await delay(500, controller.signal)
                        }
                    } finally {
                        signal.removeEventListener('abort', abort)
                    }
                })()
                legs.set(target.id, { controller, promise })
            }
            await delay(500, signal)
        }
    } finally {
        for (const leg of legs.values()) leg.controller.abort()
        await Promise.allSettled([...legs.values()].map(leg => leg.promise))
    }
}

export { durableAiWorkerId }

async function resolveConversationOwner(
    request: Request,
    conversationId: string,
): Promise<DurableAiWorkerTarget | null> {
    const query = `/api/chat/active?conversationId=${encodeURIComponent(conversationId)}`
    const targets = listDurableAiWorkerTargets()
    const results = await Promise.all(targets.map(async target => {
        const response = await proxyToTarget(request, target, query, 'GET')
        return { target, payload: await jsonObject(response) }
    }))
    return results.find(result => result.payload?.active === true)?.target ?? null
}

async function resolveAgentRunOwner(
    request: Request,
    conversationId: string,
): Promise<DurableAiWorkerTarget | null> {
    const targets = listDurableAiWorkerTargets()
    const results = await Promise.all(targets.map(async target => {
        const response = await proxyToTarget(
            request,
            target,
            '/api/internal/ai-worker/control',
            'GET',
        )
        return { target, payload: await jsonObject(response) }
    }))
    return results.find(({ payload }) =>
        Array.isArray(payload?.agentRuns) && payload.agentRuns.some(run =>
            run && typeof run === 'object'
            && (run as Record<string, unknown>).conversationId === conversationId,
        ),
    )?.target ?? null
}

async function resolveBrowserSessionOwner(
    request: Request,
    sessionId: string,
): Promise<DurableAiWorkerTarget | null> {
    const query = `/api/browser-agent/live?sessionId=${encodeURIComponent(sessionId)}`
    const targets = listDurableAiWorkerTargets()
    const results = await Promise.all(targets.map(async target => {
        const response = await proxyToTarget(request, target, query, 'GET')
        return { target, payload: await jsonObject(response) }
    }))
    return results.find(({ payload }) => {
        if (!payload) return false
        if (payload.selectedSessionId === sessionId) return true
        return Array.isArray(payload.sessions) && payload.sessions.some(session =>
            session && typeof session === 'object' && (session as Record<string, unknown>).id === sessionId,
        )
    })?.target ?? null
}

async function proxyToTarget(
    request: Request,
    worker: DurableAiWorkerTarget,
    pathOverride?: string,
    methodOverride?: string,
): Promise<Response> {
    let sourceUrl: URL
    try {
        sourceUrl = new URL(request.url)
    } catch {
        return unavailableResponse('The incoming request URL is invalid.')
    }

    const path = pathOverride ?? `${sourceUrl.pathname}${sourceUrl.search}`
    const target = new URL(path, `${worker.url}/`)
    const headers = new Headers(request.headers)
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)

    const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
        || firstHeaderValue(request.headers.get('host'))
        || sourceUrl.host
    const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'))
        || sourceUrl.protocol.replace(':', '')
    headers.set('host', forwardedHost)
    headers.set('x-forwarded-host', forwardedHost)
    headers.set('x-forwarded-proto', forwardedProto)
    headers.set('x-orchestrator-ai-worker-proxy', '1')
    headers.set('x-orchestrator-ai-worker-generation', worker.id)
    const serviceToken = (
        process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
        || ''
    ).trim()
    if (serviceToken) headers.set('x-orchestrator-ai-worker-token', serviceToken)
    if (serviceToken) headers.set('x-orchestrator-host-bridge-token', serviceToken)

    const method = (methodOverride ?? request.method).toUpperCase()
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
        responseHeaders.set('X-Orchestrator-AI-Worker', worker.id)
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'connection failed'
        return unavailableResponse(`Durable AI worker ${worker.id} is unavailable: ${reason}`)
    }
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | null> {
    try {
        const parsed = await response.json()
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
        return null
    }
}

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
    })
}

function firstHeaderValue(value: string | null): string | null {
    return value?.split(',')[0]?.trim() || null
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
        const finish = () => {
            signal.removeEventListener('abort', abort)
            resolve()
        }
        const timer = setTimeout(finish, ms)
        const abort = () => {
            clearTimeout(timer)
            finish()
        }
        signal.addEventListener('abort', abort, { once: true })
    })
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
