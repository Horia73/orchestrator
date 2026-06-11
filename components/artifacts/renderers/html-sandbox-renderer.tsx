"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { APP_HOST_SCRIPT, useAppBinding, useAppHostBridge } from "./app-host-bridge"

const BOUNDED_LOADING_HEIGHT = 720
const INITIAL_RESIZE_SETTLE_MS = 260
const MAX_INITIAL_RESIZE_WAIT_MS = 1200
const SANDBOX_HEIGHT_CACHE_PREFIX = "orch:sandbox-height:v1"
const SANDBOX_HEIGHT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Sandboxed HTML artifact.
 *
 * Renders the model's HTML in a sandboxed iframe with `srcdoc`. NO
 * `allow-same-origin` — scripts run (otherwise interactive HTML is useless)
 * but they can't reach our DOM, cookies, or localStorage. The iframe is its
 * own opaque origin.
 *
 * Granted capabilities and why:
 *   - allow-scripts:   model JS needs to run for any non-static demo
 *   - allow-modals:    so `alert()`, `confirm()`, `prompt()` work — without
 *                      this they're silently swallowed and users (correctly)
 *                      think the button is broken
 *   - allow-popups:    `window.open()` and target=_blank links open in a new
 *                      tab instead of silently failing
 *   - allow-popups-to-escape-sandbox: those new tabs aren't held to the
 *                      sandbox themselves — otherwise the user gets a broken
 *                      sandboxed Google when they click "open in new tab"
 *   - allow-forms:     forms can submit. Without this the model's "Login"
 *                      buttons inside a `<form>` look interactive but go
 *                      nowhere. (Submission targets the iframe's own origin
 *                      which 404s harmlessly; that's still better UX than a
 *                      silently-dead button.)
 *
 * Deliberately omitted: allow-same-origin, allow-top-navigation,
 * allow-storage-access-by-user-activation. The first would break the origin
 * isolation; the others let the artifact mess with the host page.
 *
 * We listen for the iframe to post a `{type: "resize", height}` message so
 * the embed grows to fit its content; if the artifact doesn't post we fall
 * back to a sensible default. The boot script we inject does the postMessage.
 */
/*
 * srcdoc documents inherit the embedding page's base URL. Without an
 * explicit base, a placeholder link like <a href="#"> resolves to the host
 * route (for this app, http://localhost:3000/#) and replaces the iframe with
 * the whole Next app running inside the sandbox. That app then crashes on
 * localStorage / same-origin fetches because sandboxed documents have an
 * opaque "null" origin. Point the base back at srcdoc so fragment and
 * relative navigation stays inside the artifact instead.
 */
const SANDBOX_BASE_TAG = '<base href="about:srcdoc">\n'

/*
 * Polyfill for localStorage / sessionStorage that runs BEFORE any artifact
 * script. In a sandboxed iframe without `allow-same-origin`, even *reading*
 * `window.localStorage` throws SecurityError. React DEV-mode and many third-
 * party libs touch localStorage as part of their DevTools-detection / state-
 * hydration code path, and every touch logs an uncaught SecurityError to the
 * console — distracting but cosmetic.
 *
 * We replace both storages with a no-op object so the access succeeds and
 * returns `null` (matching the empty-storage case). The shim is safe even
 * when the artifact wants real storage — it won't *get* real storage because
 * the sandbox forbids it, but at least the failure is silent.
 *
 * We deliberately keep the shim small and run it as a classic script (not a
 * module) so it executes synchronously before any of the artifact's deferred
 * or module scripts run.
 */
const STORAGE_SHIM_SCRIPT = `
<script>
(function () {
    var noop = {
        getItem: function () { return null },
        setItem: function () {},
        removeItem: function () {},
        clear: function () {},
        key: function () { return null },
        length: 0,
    }
    function shim(name) {
        try { void window[name].length } catch (_) {
            try {
                Object.defineProperty(window, name, { value: noop, writable: false, configurable: true })
            } catch (_) {}
        }
    }
    shim('localStorage')
    shim('sessionStorage')
})();
</script>
`

/*
 * The boot script that runs inside every sandboxed artifact.
 *
 * Its only job is to tell the parent how tall the artifact wants to be, so
 * the iframe can size to its content instead of getting a vertical scrollbar.
 *
 * Sizing is debounced because the most common artifact (React + Tailwind)
 * triggers a cascade of DOM mutations during load: babel compiles, React
 * mounts, then Tailwind Play observes the DOM and injects styles. Without a
 * debounce, every one of those mutations posts a size update to the parent
 * and the iframe visibly grows in jerky steps. With a debounce, we wait
 * for the dust to settle before reporting. Initial timer nudges
 * (50ms / 250ms / 1000ms) catch cases where the body never mutates after
 * the first render — e.g. a static HTML artifact.
 */
const BOOT_SCRIPT = `
<script>
(function () {
    var pendingTimer = null
    function measureAndPost() {
        try {
            var h = Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.offsetHeight
            );
            parent.postMessage({ __orchSandbox: 'resize', height: h }, '*');
        } catch (_) {}
    }
    function scheduleReport() {
        if (pendingTimer !== null) clearTimeout(pendingTimer)
        pendingTimer = setTimeout(function () {
            pendingTimer = null
            measureAndPost()
        }, 160)
    }
    window.addEventListener('load', scheduleReport);
    window.addEventListener('resize', scheduleReport);
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(scheduleReport).observe(document.body || document.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: true,
        });
    }
    // Initial nudges — most artifacts settle by 250ms; the 1s catches slow
    // Tailwind/babel boot on cold cache.
    setTimeout(scheduleReport, 50);
    setTimeout(scheduleReport, 250);
    setTimeout(scheduleReport, 1000);
})();
</script>
`

/**
 * How the sandbox sizes itself.
 *  - 'bounded'   — default. Capped at `maxHeight` (720) so a giant artifact
 *                  doesn't take over the chat scroll. Used inline in messages.
 *  - 'unbounded' — no cap; height grows with content. The parent (typically a
 *                  scrollable side panel) handles overflow. Loader fills the
 *                  parent height so a tall panel doesn't show a tiny spinner
 *                  stuck at the top.
 */
export type SandboxMode = 'bounded' | 'unbounded'

interface StoredSandboxHeight {
    height: number
    at: number
}

function clampSandboxHeight(height: number, minHeight: number, maxHeight: number): number {
    if (!Number.isFinite(height)) return minHeight
    return Math.min(maxHeight, Math.max(minHeight, Math.ceil(height)))
}

function hashStorageKey(value: string): string {
    let hash = 5381
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
    }
    return (hash >>> 0).toString(36)
}

function widthBucketFor(node: HTMLElement | null): string {
    if (typeof window === "undefined") return "ssr"
    const width = node?.getBoundingClientRect().width || window.innerWidth
    return Math.max(1, Math.round(width / 64)).toString(36)
}

function sandboxHeightCacheKey(baseKey: string | null, node: HTMLElement | null): string | null {
    if (!baseKey) return null
    return `${baseKey}:w${widthBucketFor(node)}`
}

function readCachedSandboxHeight(key: string | null, minHeight: number, maxHeight: number): number | null {
    if (typeof window === "undefined" || !key) return null
    try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredSandboxHeight | number
        const height = typeof parsed === "number" ? parsed : parsed.height
        const at = typeof parsed === "number" ? Date.now() : parsed.at
        if (!Number.isFinite(height) || !Number.isFinite(at)) return null
        if (Date.now() - at > SANDBOX_HEIGHT_CACHE_TTL_MS) {
            window.localStorage.removeItem(key)
            return null
        }
        return clampSandboxHeight(height, minHeight, maxHeight)
    } catch {
        return null
    }
}

function writeCachedSandboxHeight(key: string | null, height: number, minHeight: number, maxHeight: number): void {
    if (typeof window === "undefined" || !key) return
    try {
        const next: StoredSandboxHeight = {
            height: clampSandboxHeight(height, minHeight, maxHeight),
            at: Date.now(),
        }
        window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
        // Storage can be disabled or full; sizing still works without caching.
    }
}

function reservedBoundedHeight(minHeight: number, maxHeight: number, cacheKey: string | null): number {
    const cached = readCachedSandboxHeight(cacheKey, minHeight, maxHeight)
    if (cached !== null) return cached
    const viewportBased = typeof window === "undefined"
        ? BOUNDED_LOADING_HEIGHT
        : Math.max(360, window.innerHeight - 120)
    return clampSandboxHeight(Math.min(BOUNDED_LOADING_HEIGHT, viewportBased), minHeight, maxHeight)
}

export function HtmlSandboxRenderer({
    source,
    title,
    className,
    mode = 'bounded',
    minHeight,
    maxHeight,
    artifactId,
}: {
    source: string
    title: string
    className?: string
    mode?: SandboxMode
    /** Defaults to 240 (bounded final minimum) / 320 (unbounded loading area). */
    minHeight?: number
    /** Defaults to 720 (bounded); ignored in unbounded mode. */
    maxHeight?: number
    /** Stable artifact UUID — enables the AppHost data bridge for registered apps. */
    artifactId?: string
}) {
    const effectiveMinHeight = minHeight ?? (mode === 'unbounded' ? 320 : 240)
    const effectiveMaxHeight = mode === 'unbounded'
        ? Number.MAX_SAFE_INTEGER
        : (maxHeight ?? 720)
    const loadingHeight = mode === 'unbounded'
        ? effectiveMinHeight
        : clampSandboxHeight(BOUNDED_LOADING_HEIGHT, effectiveMinHeight, effectiveMaxHeight)
    const cacheBaseKey = React.useMemo(
        () => mode === 'bounded'
            ? `${SANDBOX_HEIGHT_CACHE_PREFIX}:${hashStorageKey(`${title}\n${source}`)}`
            : null,
        [mode, source, title]
    )

    const [height, setHeight] = React.useState<number>(loadingHeight)
    // Hide the iframe (and show a centered loader) until the first stable
    // size report lands. Runtime artifacts often resize several times while
    // React/Tailwind/CDN modules settle; keeping the measured iframe hidden
    // until the resize stream is quiet avoids visible grow-in steps.
    const [ready, setReady] = React.useState(false)
    const readyRef = React.useRef(false)
    const containerRef = React.useRef<HTMLDivElement>(null)
    const iframeRef = React.useRef<HTMLIFrameElement>(null)
    const latestMeasuredHeightRef = React.useRef<number | null>(null)
    const initialSettleTimerRef = React.useRef<number | null>(null)
    const maxInitialWaitTimerRef = React.useRef<number | null>(null)
    const cacheKeyRef = React.useRef<string | null>(null)

    // AppHost data bridge — inert (requests rejected) unless this artifact is
    // the code of a registered app.
    const appBinding = useAppBinding(artifactId)
    useAppHostBridge(iframeRef, appBinding)

    const clearInitialResizeTimers = React.useCallback(() => {
        if (typeof window === "undefined") return
        if (initialSettleTimerRef.current !== null) {
            window.clearTimeout(initialSettleTimerRef.current)
            initialSettleTimerRef.current = null
        }
        if (maxInitialWaitTimerRef.current !== null) {
            window.clearTimeout(maxInitialWaitTimerRef.current)
            maxInitialWaitTimerRef.current = null
        }
    }, [])

    React.useEffect(() => {
        readyRef.current = ready
    }, [ready])

    // Inject the storage shim at the very start of <head> (so it runs before
    // anything the artifact does) after a sandbox-safe <base>, then inject
    // the resize boot script just before </body>. Both injections fall back
    // to wrapping the raw source if the expected tags are missing.
    const srcDoc = React.useMemo(() => {
        let html = source
        const headPrefix = SANDBOX_BASE_TAG + STORAGE_SHIM_SCRIPT + APP_HOST_SCRIPT
        const lowerInitial = html.toLowerCase()
        const headOpen = lowerInitial.indexOf('<head>')
        if (headOpen >= 0) {
            const insertAt = headOpen + '<head>'.length
            html = html.slice(0, insertAt) + headPrefix + html.slice(insertAt)
        } else {
            const htmlOpen = html.match(/<html\b[^>]*>/i)
            if (htmlOpen && htmlOpen.index !== undefined) {
                const insertAt = htmlOpen.index + htmlOpen[0].length
                html = html.slice(0, insertAt) + `<head>${headPrefix}</head>` + html.slice(insertAt)
            } else {
                const doctype = html.match(/^\s*<!doctype[^>]*>/i)
                if (doctype) {
                    const insertAt = doctype[0].length
                    html = html.slice(0, insertAt) + `<head>${headPrefix}</head>` + html.slice(insertAt)
                } else {
                    html = `<head>${headPrefix}</head>` + html
                }
            }
        }

        const lower = html.toLowerCase()
        const closeIdx = lower.lastIndexOf('</body>')
        if (closeIdx >= 0) {
            return html.slice(0, closeIdx) + BOOT_SCRIPT + html.slice(closeIdx)
        }
        const htmlClose = lower.lastIndexOf('</html>')
        if (htmlClose >= 0) {
            return html.slice(0, htmlClose) + BOOT_SCRIPT + html.slice(htmlClose)
        }
        return html + BOOT_SCRIPT
    }, [source])

    // Re-arm the load fade-in whenever the source changes (new version of an
    // artifact, switching artifacts) and reserve a likely final height up
    // front. The cache is keyed by artifact source + rendered width bucket so
    // returning to the same artifact doesn't start from a tiny spinner.
    useIsomorphicLayoutEffect(() => {
        clearInitialResizeTimers()
        latestMeasuredHeightRef.current = null
        readyRef.current = false
        setReady(false)

        const nextCacheKey = sandboxHeightCacheKey(cacheBaseKey, containerRef.current)
        cacheKeyRef.current = nextCacheKey
        const nextHeight = mode === 'unbounded'
            ? effectiveMinHeight
            : reservedBoundedHeight(effectiveMinHeight, effectiveMaxHeight, nextCacheKey)
        setHeight(nextHeight)
    }, [cacheBaseKey, clearInitialResizeTimers, effectiveMaxHeight, effectiveMinHeight, mode, srcDoc])

    React.useEffect(() => {
        if (mode !== 'bounded' || !cacheBaseKey) {
            cacheKeyRef.current = null
            return
        }
        const node = containerRef.current
        const updateCacheKey = () => {
            cacheKeyRef.current = sandboxHeightCacheKey(cacheBaseKey, containerRef.current)
        }
        updateCacheKey()
        if (!node || typeof ResizeObserver === "undefined") return
        const observer = new ResizeObserver(updateCacheKey)
        observer.observe(node)
        return () => observer.disconnect()
    }, [cacheBaseKey, mode])

    React.useEffect(() => {
        function commitMeasuredHeight(markReady: boolean) {
            const next = latestMeasuredHeightRef.current
            if (next === null) return
            setHeight(prev => (Math.abs(prev - next) < 2 ? prev : next))
            writeCachedSandboxHeight(cacheKeyRef.current, next, effectiveMinHeight, effectiveMaxHeight)
            if (markReady) {
                readyRef.current = true
                setReady(true)
            }
        }

        function scheduleInitialCommit() {
            if (initialSettleTimerRef.current !== null) {
                window.clearTimeout(initialSettleTimerRef.current)
            }
            initialSettleTimerRef.current = window.setTimeout(() => {
                initialSettleTimerRef.current = null
                if (maxInitialWaitTimerRef.current !== null) {
                    window.clearTimeout(maxInitialWaitTimerRef.current)
                    maxInitialWaitTimerRef.current = null
                }
                commitMeasuredHeight(true)
            }, INITIAL_RESIZE_SETTLE_MS)

            if (maxInitialWaitTimerRef.current === null) {
                maxInitialWaitTimerRef.current = window.setTimeout(() => {
                    if (initialSettleTimerRef.current !== null) {
                        window.clearTimeout(initialSettleTimerRef.current)
                        initialSettleTimerRef.current = null
                    }
                    maxInitialWaitTimerRef.current = null
                    commitMeasuredHeight(true)
                }, MAX_INITIAL_RESIZE_WAIT_MS)
            }
        }

        function onMessage(e: MessageEvent) {
            // Only accept messages from our own iframe to avoid cross-talk
            // when multiple sandboxes are mounted.
            if (e.source !== iframeRef.current?.contentWindow) return
            const data = e.data as { __orchSandbox?: string; height?: number } | undefined
            if (!data || data.__orchSandbox !== 'resize') return
            if (typeof data.height === 'number' && Number.isFinite(data.height)) {
                latestMeasuredHeightRef.current = clampSandboxHeight(data.height + 4, effectiveMinHeight, effectiveMaxHeight)
                if (readyRef.current) {
                    commitMeasuredHeight(false)
                } else {
                    scheduleInitialCommit()
                }
            }
        }
        window.addEventListener('message', onMessage)
        return () => {
            window.removeEventListener('message', onMessage)
            clearInitialResizeTimers()
        }
    }, [clearInitialResizeTimers, effectiveMaxHeight, effectiveMinHeight])

    // The container's height drives the iframe size. While loading, bounded
    // embeds reserve likely preview space; unbounded embeds fill the parent so
    // the loader is centered in the whole panel. Once ready the height matches
    // the iframe's reported content size.
    const containerStyle: React.CSSProperties = ready
        ? { height: `${height}px` }
        : mode === 'unbounded'
            ? { height: '100%', minHeight: `${effectiveMinHeight}px` }
            : { height: `${height}px` }
    const panelChrome = mode === 'unbounded'

    return (
        <div ref={containerRef} className={cn("relative w-full overflow-hidden", className)} style={containerStyle}>
            <iframe
                ref={iframeRef}
                title={title}
                sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-forms"
                srcDoc={srcDoc}
                className={cn(
                    "block h-full w-full transition-opacity duration-200",
                    panelChrome
                        ? "rounded-lg border border-border/60 bg-white"
                        : "rounded-md border-0 bg-transparent",
                    ready ? "opacity-100" : "opacity-0"
                )}
            />
            {!ready && (
                <div
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5",
                        panelChrome
                            ? "rounded-lg border border-border/60 bg-muted/30 backdrop-blur-[1px]"
                            : "rounded-md bg-transparent"
                    )}
                >
                    <Loader2 className="size-6 animate-spin text-muted-foreground/70" />
                    <span className="text-[12px] font-medium text-muted-foreground/70">Loading artifact…</span>
                </div>
            )}
        </div>
    )
}
