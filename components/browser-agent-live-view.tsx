"use client"

import * as React from "react"
import { ClipboardCopy, ClipboardPaste, Globe, Loader2, Maximize2, Minimize2, Monitor, WifiOff } from "lucide-react"

import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

type LiveMode = "disabled" | "mac-headful" | "linux-vnc"
type BrowserShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">

interface BrowserAgentCursorState {
    x: number
    y: number
    kind: "move" | "click" | "drag" | "hold" | "scroll"
    at: number
}

interface BrowserAgentLiveState {
    enabled: boolean
    available: boolean
    ready: boolean
    mode: LiveMode
    platform: NodeJS.Platform
    display?: string
    width?: number
    height?: number
    wsUrl?: string | null
    reason?: string
    selectedSessionId?: string | null
    cursor?: BrowserAgentCursorState | null
    running: boolean
    paused: boolean
    sessions: Array<{
        id: string
        status: string
        running: boolean
        paused: boolean
        currentUrl: string
    }>
}

interface BrowserAgentLiveViewProps {
    active?: boolean
    /** Labels root delegate_async browser delegations in the inline live card. */
    async?: boolean
    /** Required so this card can never fall back to another conversation's browser. */
    sessionId: string
    onOpenDetails?: () => void
    /**
     * "inline" (default) renders in the message thread with a hard height cap.
     * "panel" renders in the desktop side panel: width-driven 16:9 (or the
     * stream's real aspect), no 360px cap, so the browser fills the panel.
     */
    variant?: "inline" | "panel"
}

interface BrowserClipboardResponse {
    clipboardText: string | null
    state: BrowserAgentLiveState
}

const BROWSER_VIEWPORT_CLASS =
    "browser-agent-live-viewport overflow-hidden rounded-xl border border-white/70 bg-white/55 shadow-[0_14px_36px_rgba(30,25,20,0.14),0_2px_6px_rgba(30,25,20,0.08)] ring-1 ring-black/[0.06] backdrop-blur-[6px] dark:border-white/15 dark:bg-white/[0.08] dark:ring-white/[0.06]"

export function BrowserAgentLiveView({ active = false, async: isAsync = false, sessionId, onOpenDetails, variant = "inline" }: BrowserAgentLiveViewProps) {
    const isPanel = variant === "panel"
    const liveViewRef = React.useRef<HTMLDivElement>(null)
    const fitAreaRef = React.useRef<HTMLDivElement>(null)
    const viewportRef = React.useRef<HTMLDivElement>(null)
    const targetRef = React.useRef<HTMLDivElement>(null)
    const hiddenPasteRef = React.useRef<HTMLTextAreaElement>(null)
    const rfbRef = React.useRef<import("@novnc/novnc").default | null>(null)
    const stateRef = React.useRef<BrowserAgentLiveState | null>(null)
    const inputBusyRef = React.useRef(false)
    const manualPasteCaptureRef = React.useRef(false)
    const lastBrowserClipboardSyncRef = React.useRef<{ text: string; at: number } | null>(null)
    const inputMessageTimerRef = React.useRef<number | null>(null)
    const [state, setState] = React.useState<BrowserAgentLiveState | null>(null)
    const [connection, setConnection] = React.useState<"idle" | "connecting" | "connected" | "disconnected" | "error">("idle")
    const [inputBusy, setInputBusy] = React.useState(false)
    const [inputMessage, setInputMessage] = React.useState<string | null>(null)
    const [fullscreen, setFullscreen] = React.useState(false)

    const focusRfb = React.useCallback(() => {
        requestAnimationFrame(() => {
            const rfb = rfbRef.current
            if (rfb) {
                rfb.focus({ preventScroll: true })
                return
            }
            liveViewRef.current?.focus({ preventScroll: true })
        })
    }, [])

    React.useEffect(() => {
        stateRef.current = state
    }, [state])

    React.useEffect(() => {
        inputBusyRef.current = inputBusy
    }, [inputBusy])

    React.useEffect(() => {
        return () => {
            if (inputMessageTimerRef.current) {
                window.clearTimeout(inputMessageTimerRef.current)
            }
        }
    }, [])

    const showInputMessage = React.useCallback((message: string) => {
        setInputMessage(message)
        if (inputMessageTimerRef.current) {
            window.clearTimeout(inputMessageTimerRef.current)
        }
        inputMessageTimerRef.current = window.setTimeout(() => {
            setInputMessage(null)
            inputMessageTimerRef.current = null
        }, 5_000)
    }, [])

    const requestManualPasteCapture = React.useCallback((message: string) => {
        manualPasteCaptureRef.current = true
        showInputMessage(message)
        requestAnimationFrame(() => {
            const target = hiddenPasteRef.current
            if (!target) return
            target.value = ""
            target.focus({ preventScroll: true })
            target.select()
        })
    }, [showInputMessage])

    const syncBrowserClipboardText = React.useCallback(async (text: string, options: { silentDuplicate?: boolean } = {}) => {
        if (!text) {
            showInputMessage("Browser clipboard is empty.")
            focusRfb()
            return false
        }

        const now = Date.now()
        const last = lastBrowserClipboardSyncRef.current
        if (options.silentDuplicate && last?.text === text && now - last.at < 1_500) {
            return true
        }

        const copied = await copyTextToClipboard(text)
        if (copied) {
            lastBrowserClipboardSyncRef.current = { text, at: Date.now() }
            showInputMessage(`Copied ${formatCharacterCount(text.length)} from browser.`)
        } else {
            showInputMessage("Browser clipboard was read, but local clipboard access was blocked.")
        }
        focusRfb()
        return copied
    }, [focusRfb, showInputMessage])

    const refresh = React.useCallback(async () => {
        const url = `/api/browser-agent/live?sessionId=${encodeURIComponent(sessionId)}`
        const res = await fetch(url, { cache: "no-store" })
        if (!res.ok) throw new Error(`Live view status failed: ${res.status}`)
        setState(await res.json() as BrowserAgentLiveState)
    }, [sessionId])

    React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
            try {
                await refresh()
            } catch {
                if (!cancelled) setConnection(prev => prev === "connected" ? "disconnected" : "error")
            }
        }
        void tick()
        const interval = window.setInterval(tick, active ? 2_000 : 5_000)
        return () => {
            cancelled = true
            window.clearInterval(interval)
        }
    }, [active, refresh])

    React.useEffect(() => {
        const target = targetRef.current
        const wsUrl = state?.wsUrl
        if (!target || !wsUrl || state?.mode !== "linux-vnc") return

        let disposed = false
        let started = false
        let activeRfb: import("@novnc/novnc").default | null = null
        let resizeFrame: number | null = null
        setConnection("connecting")
        target.replaceChildren()

        // The user's pointer stays their own cursor: hover moves are swallowed
        // before noVNC's canvas listener sees them, so only clicks, drags and
        // the wheel reach the remote browser. The agent's pointer is rendered
        // separately as the arrow overlay below.
        const suppressHoverMove = (event: MouseEvent) => {
            if (event.buttons === 0) event.stopPropagation()
        }
        target.addEventListener("mousemove", suppressHoverMove, true)

        // The side panel animates from zero width. Creating noVNC during that
        // transition can leave its flex canvas scaled and centred against the
        // old box, producing the large white gutter seen until a later resize.
        // Wait for a real box and explicitly re-apply scaleViewport whenever
        // this element changes size (not only when the window resizes).
        const rescaleViewport = () => {
            if (!activeRfb || disposed) return
            if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
            resizeFrame = window.requestAnimationFrame(() => {
                resizeFrame = null
                if (!activeRfb || disposed) return
                // The setter recalculates the display scale even when already
                // true, which is the supported public noVNC recalibration path.
                activeRfb.scaleViewport = true
            })
        }

        const connect = () => {
            if (started || disposed) return
            const rect = target.getBoundingClientRect()
            if (rect.width < 160 || rect.height < 90) return
            started = true

            import("@novnc/novnc")
                .then(({ default: RFB }) => {
                    if (disposed) return
                    const rfb = new RFB(target, wsUrl)
                    activeRfb = rfb
                    rfb.scaleViewport = true
                    rfb.resizeSession = false
                    rfb.background = "rgba(255, 255, 255, 0.72)"
                    rfb.qualityLevel = 8
                    rfb.compressionLevel = 2
                    rfb.showDotCursor = false
                    rfb.viewOnly = false
                    const handleClipboard = (event: Event) => {
                        const text = (event as CustomEvent<{ text?: unknown }>).detail?.text
                        if (typeof text !== "string") return
                        void syncBrowserClipboardText(text, { silentDuplicate: true })
                    }
                    rfb.addEventListener("connect", () => setConnection("connected"))
                    rfb.addEventListener("disconnect", () => setConnection("disconnected"))
                    rfb.addEventListener("securityfailure", () => setConnection("error"))
                    rfb.addEventListener("clipboard", handleClipboard)
                    rfbRef.current = rfb
                    rescaleViewport()
                })
                .catch(() => {
                    if (!disposed) setConnection("error")
                })
        }

        const resizeObserver = new ResizeObserver(() => {
            connect()
            rescaleViewport()
        })
        resizeObserver.observe(target)
        connect()

        return () => {
            disposed = true
            resizeObserver.disconnect()
            if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
            target.removeEventListener("mousemove", suppressHoverMove, true)
            activeRfb?.disconnect()
            if (rfbRef.current === activeRfb) rfbRef.current = null
        }
    }, [state?.mode, state?.wsUrl, syncBrowserClipboardText])

    React.useEffect(() => {
        const updateFullscreen = () => {
            const root = liveViewRef.current
            setFullscreen(Boolean(root && document.fullscreenElement === root))
        }
        updateFullscreen()
        document.addEventListener("fullscreenchange", updateFullscreen)
        return () => document.removeEventListener("fullscreenchange", updateFullscreen)
    }, [])

    const postLiveAction = React.useCallback(async (body: Record<string, unknown>) => {
        const res = await fetch("/api/browser-agent/live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, sessionId }),
        })
        if (!res.ok) {
            const message = await res.text().catch(() => "")
            throw new Error(message || `Browser live action failed: ${res.status}`)
        }
        const nextState = await res.json() as BrowserAgentLiveState
        setState(nextState)
        return nextState
    }, [sessionId])

    const copyFromBrowser = React.useCallback(async (key?: string): Promise<boolean> => {
        setInputBusy(true)
        try {
            const res = await fetch("/api/browser-agent/live", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "copy_from_browser", key, sessionId }),
            })
            if (!res.ok) {
                const message = await res.text().catch(() => "")
                throw new Error(message || `Browser copy failed: ${res.status}`)
            }
            const payload = await res.json() as BrowserClipboardResponse
            setState(payload.state)
            return syncBrowserClipboardText(payload.clipboardText || "")
        } catch (error) {
            showInputMessage(`Copy failed: ${formatInputError(error)}`)
            focusRfb()
            return false
        } finally {
            setInputBusy(false)
        }
    }, [focusRfb, sessionId, showInputMessage, syncBrowserClipboardText])

    const toggleFullscreen = async () => {
        try {
            const root = liveViewRef.current
            if (!root) return
            if (document.fullscreenElement === root) {
                await document.exitFullscreen()
                return
            }
            await root.requestFullscreen()
        } catch {
            // Fullscreen is best-effort and may be blocked by the host shell.
        }
    }

    const pasteText = React.useCallback(async (text: string): Promise<boolean> => {
        if (!text) {
            showInputMessage("Clipboard is empty.")
            focusRfb()
            return false
        }
        setInputBusy(true)
        try {
            await postLiveAction({ action: "paste_text", text })
            focusRfb()
            return true
        } catch (error) {
            showInputMessage(`Paste failed: ${formatInputError(error)}`)
            focusRfb()
            return false
        } finally {
            setInputBusy(false)
        }
    }, [focusRfb, postLiveAction, showInputMessage])

    const pasteFromClipboard = React.useCallback(async () => {
        const readText = navigator.clipboard?.readText?.bind(navigator.clipboard)
        if (!readText || !window.isSecureContext) {
            requestManualPasteCapture("Clipboard access is blocked. Press paste shortcut now.")
            return
        }
        try {
            const text = await readText()
            await pasteText(text || "")
        } catch {
            requestManualPasteCapture("Clipboard permission was denied. Press paste shortcut now.")
        }
    }, [pasteText, requestManualPasteCapture])

    const sendKey = React.useCallback(async (key: string) => {
        setInputBusy(true)
        try {
            await postLiveAction({ action: "press_key", key })
        } finally {
            setInputBusy(false)
        }
    }, [postLiveAction])

    const handleBrowserShortcut = React.useCallback((key: string) => {
        if (key === "Control+V" || key === "Meta+V") {
            const readText = navigator.clipboard?.readText?.bind(navigator.clipboard)
            if (!readText || !window.isSecureContext) {
                requestManualPasteCapture("Clipboard access is blocked. Press paste shortcut again.")
                return
            }
            void readText()
                .then((text) => {
                    void pasteText(text || "")
                })
                .catch(() => requestManualPasteCapture("Clipboard permission was denied. Press paste shortcut again."))
            return
        }
        if (key === "Control+C" || key === "Meta+C") {
            void copyFromBrowser(key)
            return
        }
        void sendKey(key)
    }, [copyFromBrowser, pasteText, requestManualPasteCapture, sendKey])

    const browserInputContainsTarget = React.useCallback((target: EventTarget | null) => {
        const root = liveViewRef.current
        if (!root) return false
        if (target instanceof Node && root.contains(target)) return true
        const active = document.activeElement
        return active instanceof Node && root.contains(active)
    }, [])

    React.useEffect(() => {
        const handleNativeKeyDownCapture = (event: KeyboardEvent) => {
            const currentState = stateRef.current
            if (!currentState || inputBusyRef.current) return
            if (!browserInputContainsTarget(event.target)) return
            const key = browserShortcutFromEvent(event, currentState.platform)
            if (!key) return
            const isPasteShortcut = key === "Control+V" || key === "Meta+V"
            if (isPasteShortcut && manualPasteCaptureRef.current && event.target === hiddenPasteRef.current) {
                event.stopPropagation()
                event.stopImmediatePropagation()
                return
            }

            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            if (isPasteShortcut && (!navigator.clipboard?.readText || !window.isSecureContext)) {
                requestManualPasteCapture("Clipboard access is blocked. Press paste shortcut again.")
                return
            }
            handleBrowserShortcut(key)
        }

        const handleNativePasteCapture = (event: ClipboardEvent) => {
            if (!stateRef.current) return
            if (!browserInputContainsTarget(event.target)) return
            const isManualPasteTarget = manualPasteCaptureRef.current && event.target === hiddenPasteRef.current
            const text = event.clipboardData?.getData("text/plain")
            if (!text && !isManualPasteTarget) return

            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            manualPasteCaptureRef.current = false
            if (hiddenPasteRef.current) hiddenPasteRef.current.value = ""
            void pasteText(text || "")
        }

        document.addEventListener("keydown", handleNativeKeyDownCapture, true)
        document.addEventListener("paste", handleNativePasteCapture, true)
        return () => {
            document.removeEventListener("keydown", handleNativeKeyDownCapture, true)
            document.removeEventListener("paste", handleNativePasteCapture, true)
        }
    }, [browserInputContainsTarget, handleBrowserShortcut, pasteText, requestManualPasteCapture])

    const handleViewportPointerDown = React.useCallback(() => {
        focusRfb()
    }, [focusRfb])

    const handleLiveViewFocus = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return
        focusRfb()
    }, [focusRfb])

    const viewportWidth = state?.width && state.width > 0 ? state.width : 16
    const viewportHeight = state?.height && state.height > 0 ? state.height : 9
    // Panel mode sizes the viewport box itself as a contain-fit of the stream
    // inside the flexible area, so resizing the panel always keeps the whole
    // browser visible (shrinking it instead of cropping or overflowing).
    const panelFit = useContainFit(fitAreaRef, viewportWidth, viewportHeight)

    if (!state) {
        return (
            <div className="grid h-[180px] place-items-center rounded-md border border-border/70 bg-muted/20 text-[12px] text-muted-foreground">
                <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Connecting live view</span>
            </div>
        )
    }

    if (state.mode === "mac-headful" && (state.available || state.ready)) {
        const content = (
            <>
                <Monitor className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">Patchright is running in a local headful browser window on this Mac.</span>
                {isAsync && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-700 dark:text-violet-300">async</span>}
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">headful</span>
            </>
        )
        if (onOpenDetails) {
            return (
                <button
                    type="button"
                    onClick={onOpenDetails}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label="Open browser agent details"
                    title="Open browser agent details"
                >
                    {content}
                </button>
            )
        }
        return (
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
                {content}
            </div>
        )
    }

    if (!state.ready || !state.wsUrl) {
        const content = (
            <>
                <WifiOff className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">{state.reason || "Live browser view is not available."}</span>
                {isAsync && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-700 dark:text-violet-300">async</span>}
            </>
        )
        if (onOpenDetails) {
            return (
                <button
                    type="button"
                    onClick={onOpenDetails}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label="Open browser agent details"
                    title="Open browser agent details"
                >
                    {content}
                </button>
            )
        }
        return (
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
                {content}
            </div>
        )
    }

    const hasRealDimensions = Boolean(state.width && state.width > 0 && state.height && state.height > 0)
    const selectedSession = state.sessions.find((session) => session.id === sessionId)
    const currentUrl = selectedSession?.currentUrl ?? ""
    const statusLabel = state.paused
        ? "paused"
        : connection === "connected"
            ? "connected"
            : connection

    return (
        <div
            ref={liveViewRef}
            className={cn(
                "browser-agent-live-view min-w-0 bg-background outline-none [&:fullscreen]:h-screen [&:fullscreen]:p-3",
                isPanel
                    ? "flex h-full w-full min-h-0 flex-col gap-2"
                    : "grid gap-2 [&:fullscreen]:grid-rows-[auto_1fr]"
            )}
            tabIndex={0}
            onFocus={handleLiveViewFocus}
        >
            <textarea
                ref={hiddenPasteRef}
                aria-label="Browser clipboard paste target"
                className="sr-only"
                tabIndex={-1}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {onOpenDetails ? (
                    <button
                        type="button"
                        onClick={onOpenDetails}
                        className="group inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="Open browser agent logs"
                        title="Open browser agent logs"
                    >
                        <Monitor className="size-3.5 shrink-0" />
                        <span className="truncate font-medium text-foreground/80 transition-colors group-hover:text-foreground">Browser agent</span>
                        {isAsync && <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">async</span>}
                        <span className="truncate">{statusLabel}</span>
                    </button>
                ) : (
                    <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[12px] text-muted-foreground">
                        <Monitor className="size-3.5 shrink-0" />
                        <span className="truncate font-medium text-foreground/80">Browser agent</span>
                        {isAsync && <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">async</span>}
                        <span className="truncate">{statusLabel}</span>
                    </span>
                )}
                <button
                    type="button"
                    disabled={inputBusy}
                    onClick={() => copyFromBrowser()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
                    aria-label="Copy browser clipboard locally"
                    title="Copy browser clipboard locally"
                >
                    {inputBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardCopy className="size-3.5" />}
                    Copy
                </button>
                <button
                    type="button"
                    disabled={inputBusy}
                    onClick={pasteFromClipboard}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
                    aria-label="Paste clipboard into browser"
                    title="Paste clipboard into browser"
                >
                    {inputBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardPaste className="size-3.5" />}
                    Paste
                </button>
                <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={fullscreen ? "Exit browser full screen" : "Open browser full screen"}
                >
                    {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                    {fullscreen ? "Exit full screen" : "Full screen"}
                </button>
                {inputMessage && (
                    <span className="min-w-0 flex-[1_1_100%] rounded-md border border-border/70 bg-muted/25 px-2.5 py-1.5 text-[12px] text-muted-foreground">
                        {inputMessage}
                    </span>
                )}
            </div>
            {isPanel && (
                <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/25 px-2.5 py-1.5">
                    <Globe className="size-3 shrink-0 text-muted-foreground/80" aria-hidden="true" />
                    <span
                        className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
                        title={currentUrl || undefined}
                    >
                        {currentUrl || "about:blank"}
                    </span>
                </div>
            )}
            {isPanel ? (
                <div ref={fitAreaRef} className="relative min-h-0 min-w-0 flex-1">
                    <div
                        ref={viewportRef}
                        className={cn(BROWSER_VIEWPORT_CLASS, "absolute")}
                        style={panelFit
                            ? { left: panelFit.left, top: panelFit.top, width: panelFit.width, height: panelFit.height }
                            : { inset: 0 }}
                        aria-label={`${connection} browser live view`}
                        onPointerDown={handleViewportPointerDown}
                    >
                        <div ref={targetRef} className="size-full bg-white" />
                        {hasRealDimensions && state.cursor && connection === "connected" && (
                            <BrowserAgentCursorOverlay
                                cursor={state.cursor}
                                containerRef={viewportRef}
                                frameWidth={viewportWidth}
                                frameHeight={viewportHeight}
                            />
                        )}
                    </div>
                </div>
            ) : (
                <div
                    ref={viewportRef}
                    className={cn(BROWSER_VIEWPORT_CLASS, "relative min-h-0 w-full")}
                    style={{
                        aspectRatio: fullscreen ? "auto" : `${viewportWidth} / ${viewportHeight}`,
                        height: fullscreen ? "100%" : undefined,
                        maxHeight: fullscreen ? "none" : "min(360px, calc(100vh - 320px))",
                        minHeight: fullscreen ? 0 : "220px",
                    }}
                    aria-label={`${connection} browser live view`}
                    onPointerDown={handleViewportPointerDown}
                >
                    <div ref={targetRef} className="size-full bg-white" />
                    {hasRealDimensions && state.cursor && connection === "connected" && (
                        <BrowserAgentCursorOverlay
                            cursor={state.cursor}
                            containerRef={viewportRef}
                            frameWidth={viewportWidth}
                            frameHeight={viewportHeight}
                        />
                    )}
                </div>
            )}
        </div>
    )
}

/**
 * The agent's own pointer, rendered as a Codex-style arrow that glides between
 * the agent's pointer actions. It is deliberately independent from the user's
 * mouse: hovering the live view never moves it.
 */
function BrowserAgentCursorOverlay({
    cursor,
    containerRef,
    frameWidth,
    frameHeight,
}: {
    cursor: BrowserAgentCursorState
    containerRef: React.RefObject<HTMLDivElement | null>
    frameWidth: number
    frameHeight: number
}) {
    const fit = useContainFit(containerRef, frameWidth, frameHeight)
    if (!fit) return null

    const clampedX = Math.max(0, Math.min(cursor.x, frameWidth))
    const clampedY = Math.max(0, Math.min(cursor.y, frameHeight))
    const left = fit.left + (clampedX / frameWidth) * fit.width
    const top = fit.top + (clampedY / frameHeight) * fit.height
    // Match the cursor to the displayed framebuffer scale. Keeping the SVG at
    // a fixed CSS size made it loom over controls in a narrow side panel.
    const cursorScale = Math.max(0.55, Math.min(1, fit.width / frameWidth))

    return (
        <div
            className="browser-agent-cursor"
            style={{ left, top, transform: `scale(${cursorScale})`, transformOrigin: "0 0" }}
            aria-hidden="true"
        >
            {cursor.kind === "click" && <span key={cursor.at} className="browser-agent-cursor-pulse" />}
            <svg width="19" height="22" viewBox="0 0 12.5 19.5" style={{ overflow: "visible" }}>
                <path
                    d="M0 0 L0 16.9 L4.4 13.1 L7.1 19.5 L9.5 18.4 L6.9 12.1 L12.5 12.1 Z"
                    fill="#111114"
                    stroke="#ffffff"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                />
            </svg>
        </div>
    )
}

/**
 * Computes the box the noVNC canvas actually occupies inside the viewport
 * container ("contain" fit, centered) so overlay coordinates stay accurate
 * when the container aspect diverges from the framebuffer (e.g. fullscreen).
 */
function useContainFit(
    containerRef: React.RefObject<HTMLDivElement | null>,
    frameWidth: number,
    frameHeight: number,
): { left: number; top: number; width: number; height: number } | null {
    const [fit, setFit] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null)

    React.useEffect(() => {
        const container = containerRef.current
        if (!container || frameWidth <= 0 || frameHeight <= 0) {
            setFit(null)
            return
        }

        const compute = () => {
            const rect = container.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) {
                setFit(null)
                return
            }
            const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight)
            const width = frameWidth * scale
            const height = frameHeight * scale
            setFit({
                left: (rect.width - width) / 2,
                top: (rect.height - height) / 2,
                width,
                height,
            })
        }

        compute()
        const observer = new ResizeObserver(compute)
        observer.observe(container)
        return () => observer.disconnect()
    }, [containerRef, frameWidth, frameHeight])

    return fit
}

function browserShortcutFromEvent(event: BrowserShortcutEvent, platform: NodeJS.Platform): string | null {
    if (!event.ctrlKey && !event.metaKey) return null
    if (event.key === "Control" || event.key === "Meta" || event.key === "Shift" || event.key === "Alt") return null

    const key = normalizeShortcutKey(event.key)
    if (!key) return null

    const parts: string[] = []
    if (event.ctrlKey || event.metaKey) {
        parts.push(platform === "darwin" && event.metaKey ? "Meta" : "Control")
    }
    if (event.altKey) parts.push("Alt")
    if (event.shiftKey) parts.push("Shift")
    parts.push(key)
    return parts.join("+")
}

function formatInputError(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error || "unknown error")
}

function formatCharacterCount(count: number): string {
    return `${count.toLocaleString()} character${count === 1 ? "" : "s"}`
}

function normalizeShortcutKey(key: string): string | null {
    if (key.length === 1) {
        if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase()
        const punctuation: Record<string, string> = {
            "-": "Minus",
            "=": "Equal",
            ",": "Comma",
            ".": "Period",
            "/": "Slash",
            "\\": "Backslash",
            ";": "Semicolon",
            "'": "Quote",
            "`": "Backquote",
            "[": "BracketLeft",
            "]": "BracketRight",
        }
        return punctuation[key] ?? null
    }
    const named: Record<string, string> = {
        " ": "Space",
        Escape: "Escape",
        Enter: "Enter",
        Tab: "Tab",
        Backspace: "Backspace",
        Delete: "Delete",
        ArrowLeft: "ArrowLeft",
        ArrowRight: "ArrowRight",
        ArrowUp: "ArrowUp",
        ArrowDown: "ArrowDown",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
    }
    if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key
    return named[key] ?? null
}
