"use client"

import * as React from "react"
import { useAppEvent } from "@/hooks/use-app-events"
import { LruCache } from "@/lib/cache/lru-cache"

// ---------------------------------------------------------------------------
// AppHost bridge — connects a sandboxed artifact iframe to the per-app JSON
// data store when the rendered artifact belongs to a registered app.
//
// The iframe side (APP_HOST_SCRIPT, injected into every html/react sandbox)
// exposes `window.AppHost` with promise-based getData/setData/ai/onChange over
// postMessage. The parent side (useAppBinding + useAppHostBridge) resolves
// which app the artifact belongs to, proxies get/set to /api/apps/[id]/data,
// and pushes live `changed` notifications into the iframe when the data doc
// changes server-side (agent tool calls, other open instances).
//
// The iframe has no `allow-same-origin` (opaque origin), so all parent →
// iframe messages use targetOrigin '*' — same as the existing resize channel.
// ---------------------------------------------------------------------------

export interface AppBinding {
    id: string
    slug: string
    title: string
}

/**
 * Injected as a classic script in <head> so `window.AppHost` exists before
 * any artifact script runs. Calls reject when the artifact is not a
 * registered app — artifact code is told to catch and fall back.
 */
export const APP_HOST_SCRIPT = `
<script>
(function () {
    var pending = {}
    var changeCallbacks = []
    var seq = 0
    window.addEventListener('message', function (e) {
        var data = e.data
        if (!data || typeof data !== 'object') return
        if (data.__orchAppHost === 'result') {
            var p = pending[data.requestId]
            if (!p) return
            delete pending[data.requestId]
            clearTimeout(p.timer)
            if (data.ok) p.resolve(data.data)
            else p.reject(new Error(data.error || 'AppHost request failed'))
        } else if (data.__orchAppHost === 'changed') {
            for (var i = 0; i < changeCallbacks.length; i++) {
                try { changeCallbacks[i](data.data) } catch (_) {}
            }
        }
    })
    function request(type, payload, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var requestId = 'r' + (++seq)
            var msg = { __orchAppHost: type, requestId: requestId }
            if (payload !== undefined) msg.data = payload
            var timer = setTimeout(function () {
                if (pending[requestId]) {
                    delete pending[requestId]
                    reject(new Error('AppHost request timed out'))
                }
            }, timeoutMs || 10000)
            pending[requestId] = { resolve: resolve, reject: reject, timer: timer }
            parent.postMessage(msg, '*')
        })
    }
    window.AppHost = {
        getData: function () { return request('get') },
        setData: function (data) { return request('set', data) },
        ai: function (options) {
            var input = options && typeof options === 'object' ? options : {}
            var files = []
            if (input.files && typeof input.files.length === 'number') {
                for (var i = 0; i < input.files.length; i++) files.push(input.files[i])
            }
            return request('ai', {
                prompt: typeof input.prompt === 'string' ? input.prompt : '',
                systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
                responseFormat: input.responseFormat === 'json' ? 'json' : 'text',
                files: files,
            }, 180000)
        },
        onChange: function (cb) {
            changeCallbacks.push(cb)
            return function () {
                var i = changeCallbacks.indexOf(cb)
                if (i >= 0) changeCallbacks.splice(i, 1)
            }
        },
    }
})();
</script>
`

// Module-scoped resolve cache: artifactId → binding (or null when the
// artifact is not app code). Cleared on apps.changed so an artifact emitted
// just before AppSave binds as soon as the registration lands.
const bindingCache = new LruCache<string, AppBinding | null>({ maxEntries: 500 })
const bindingInFlight = new Map<string, Promise<AppBinding | null>>()

function resolveBinding(artifactId: string): Promise<AppBinding | null> {
    const cached = bindingCache.get(artifactId)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = bindingInFlight.get(artifactId)
    if (inFlight) return inFlight
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    const promise = fetch(`/api/apps/resolve?artifactId=${encodeURIComponent(artifactId)}`, {
        signal: controller.signal,
    })
        .then(async (res) => {
            if (!res.ok) return null
            const json = await res.json() as { app: AppBinding | null }
            return json.app
        })
        .catch(() => null)
        .then((app) => {
            bindingCache.set(artifactId, app)
            return app
        })
        .finally(() => {
            window.clearTimeout(timeout)
            bindingInFlight.delete(artifactId)
        })
    bindingInFlight.set(artifactId, promise)
    return promise
}

function isResolvableArtifactId(artifactId: string | undefined): artifactId is string {
    return Boolean(artifactId) && !artifactId!.startsWith('streaming-')
}

/**
 * Which registered app (if any) does this artifact belong to?
 * `undefined` = still resolving, `null` = not an app.
 */
export function useAppBinding(artifactId?: string): AppBinding | null | undefined {
    const resolvable = isResolvableArtifactId(artifactId)
    const [binding, setBinding] = React.useState<AppBinding | null | undefined>(
        resolvable ? bindingCache.get(artifactId) : null,
    )

    const refresh = React.useCallback(() => {
        if (!isResolvableArtifactId(artifactId)) {
            setBinding(null)
            return
        }
        let cancelled = false
        void resolveBinding(artifactId).then((app) => {
            if (!cancelled) setBinding(app)
        })
        return () => { cancelled = true }
    }, [artifactId])

    React.useEffect(() => {
        setBinding(resolvable ? bindingCache.get(artifactId) : null)
        return refresh()
    }, [artifactId, refresh, resolvable])

    // Registration can land after this artifact rendered (emit → AppSave) and
    // repoints/deletes can change the chain — re-resolve on registry changes.
    useAppEvent(['apps.changed'], React.useCallback(() => {
        bindingCache.clear()
        refresh()
    }, [refresh]))

    return binding
}

interface BridgeRequest {
    type: 'get' | 'set' | 'ai'
    requestId: string
    data?: unknown
}

interface AppAiBridgePayload {
    prompt?: unknown
    systemPrompt?: unknown
    responseFormat?: unknown
    files?: unknown
}

/**
 * Parent half of the bridge: answers the iframe's get/set/ai requests against
 * the profile-scoped app APIs and pushes `changed` when the doc updates server-side.
 * Requests arriving while the binding is still resolving are queued.
 */
export function useAppHostBridge(
    iframeRef: React.RefObject<HTMLIFrameElement | null>,
    binding: AppBinding | null | undefined,
) {
    const bindingRef = React.useRef(binding)
    const queueRef = React.useRef<BridgeRequest[]>([])
    const docRef = React.useRef<{ appId: string; data: unknown } | null>(null)

    const reply = React.useCallback((requestId: string, ok: boolean, payload?: { data?: unknown; error?: string }) => {
        iframeRef.current?.contentWindow?.postMessage(
            { __orchAppHost: 'result', requestId, ok, ...payload },
            '*',
        )
    }, [iframeRef])

    const fetchDoc = React.useCallback(async (appId: string): Promise<unknown> => {
        const cached = docRef.current
        if (cached && cached.appId === appId) return cached.data
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/data`)
        if (!res.ok) throw new Error(`Failed to load app data (${res.status})`)
        const json = await res.json() as { data: unknown }
        docRef.current = { appId, data: json.data }
        return json.data
    }, [])

    const handleRequest = React.useCallback(async (request: BridgeRequest) => {
        const bound = bindingRef.current
        if (!bound) {
            reply(request.requestId, false, { error: 'Not a registered app — data persistence is unavailable here.' })
            return
        }
        try {
            if (request.type === 'get') {
                const data = await fetchDoc(bound.id)
                reply(request.requestId, true, { data })
            } else if (request.type === 'set') {
                const res = await fetch(`/api/apps/${encodeURIComponent(bound.id)}/data`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: request.data }),
                })
                if (!res.ok) {
                    const body = await res.json().catch(() => null) as { error?: string } | null
                    throw new Error(body?.error || `Failed to save app data (${res.status})`)
                }
                docRef.current = { appId: bound.id, data: request.data }
                reply(request.requestId, true, {})
            } else {
                const payload = request.data && typeof request.data === 'object'
                    ? request.data as AppAiBridgePayload
                    : {}
                const form = new FormData()
                form.set('prompt', typeof payload.prompt === 'string' ? payload.prompt : '')
                form.set('system_prompt', typeof payload.systemPrompt === 'string' ? payload.systemPrompt : '')
                form.set('response_format', payload.responseFormat === 'json' ? 'json' : 'text')
                const files = Array.isArray(payload.files) ? payload.files : []
                for (const file of files) {
                    if (file instanceof File) form.append('files', file, file.name)
                }
                const res = await fetch(`/api/apps/${encodeURIComponent(bound.id)}/ai`, {
                    method: 'POST',
                    body: form,
                })
                const body = await res.json().catch(() => null) as { error?: string } | null
                if (!res.ok) throw new Error(body?.error || `App AI request failed (${res.status})`)
                reply(request.requestId, true, { data: body })
            }
        } catch (error) {
            reply(request.requestId, false, { error: error instanceof Error ? error.message : String(error) })
        }
    }, [fetchDoc, reply])

    // Track binding state; when it settles, flush whatever the iframe asked
    // for while we were resolving, and prefetch the doc so getData is instant.
    React.useEffect(() => {
        bindingRef.current = binding
        if (binding === undefined) return
        if (binding && (!docRef.current || docRef.current.appId !== binding.id)) {
            docRef.current = null
            void fetchDoc(binding.id).catch(() => { /* surfaced per-request */ })
        }
        const queued = queueRef.current
        queueRef.current = []
        for (const request of queued) void handleRequest(request)
    }, [binding, fetchDoc, handleRequest])

    React.useEffect(() => {
        function onMessage(e: MessageEvent) {
            if (e.source !== iframeRef.current?.contentWindow) return
            const data = e.data as { __orchAppHost?: string; requestId?: string; data?: unknown } | undefined
            if (!data || !['get', 'set', 'ai'].includes(data.__orchAppHost ?? '')) return
            if (typeof data.requestId !== 'string') return
            const request: BridgeRequest = { type: data.__orchAppHost as BridgeRequest['type'], requestId: data.requestId, data: data.data }
            if (bindingRef.current === undefined) {
                queueRef.current.push(request)
            } else {
                void handleRequest(request)
            }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
    }, [handleRequest, iframeRef])

    // Live updates: agent tool calls and other open instances emit
    // app_data.changed; refetch and push into the iframe.
    useAppEvent(['app_data.changed'], React.useCallback((event) => {
        const bound = bindingRef.current
        if (!bound || !('appId' in event) || event.appId !== bound.id) return
        docRef.current = null
        void fetchDoc(bound.id)
            .then((data) => {
                iframeRef.current?.contentWindow?.postMessage({ __orchAppHost: 'changed', data }, '*')
            })
            .catch(() => { /* next getData will retry */ })
    }, [fetchDoc, iframeRef]))
}
