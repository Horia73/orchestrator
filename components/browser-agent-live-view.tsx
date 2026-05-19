"use client"

import * as React from "react"
import { ClipboardPaste, Loader2, Maximize2, Minimize2, Monitor, MousePointer2, Play, WifiOff } from "lucide-react"

import { cn } from "@/lib/utils"

type LiveControlMode = "agent" | "user"
type LiveMode = "disabled" | "mac-headful" | "linux-vnc"

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
    controlMode: LiveControlMode
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
    onOpenDetails?: () => void
}

export function BrowserAgentLiveView({ active = false, onOpenDetails }: BrowserAgentLiveViewProps) {
    const liveViewRef = React.useRef<HTMLDivElement>(null)
    const viewportRef = React.useRef<HTMLDivElement>(null)
    const targetRef = React.useRef<HTMLDivElement>(null)
    const rfbRef = React.useRef<import("@novnc/novnc").default | null>(null)
    const [state, setState] = React.useState<BrowserAgentLiveState | null>(null)
    const [connection, setConnection] = React.useState<"idle" | "connecting" | "connected" | "disconnected" | "error">("idle")
    const [busy, setBusy] = React.useState(false)
    const [inputBusy, setInputBusy] = React.useState(false)
    const [fullscreen, setFullscreen] = React.useState(false)

    const refresh = React.useCallback(async () => {
        const res = await fetch("/api/browser-agent/live", { cache: "no-store" })
        if (!res.ok) throw new Error(`Live view status failed: ${res.status}`)
        setState(await res.json() as BrowserAgentLiveState)
    }, [])

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
        setConnection("connecting")
        target.replaceChildren()

        import("@novnc/novnc")
            .then(({ default: RFB }) => {
                if (disposed) return
                const rfb = new RFB(target, wsUrl)
                rfb.viewOnly = true
                rfb.scaleViewport = true
                rfb.resizeSession = false
                rfb.background = "#ffffff"
                rfb.qualityLevel = 8
                rfb.compressionLevel = 2
                rfb.showDotCursor = true
                rfb.addEventListener("connect", () => setConnection("connected"))
                rfb.addEventListener("disconnect", () => setConnection("disconnected"))
                rfb.addEventListener("securityfailure", () => setConnection("error"))
                rfbRef.current = rfb
            })
            .catch(() => {
                if (!disposed) setConnection("error")
            })

        return () => {
            disposed = true
            rfbRef.current?.disconnect()
            rfbRef.current = null
        }
    }, [state?.mode, state?.wsUrl])

    React.useEffect(() => {
        if (!rfbRef.current || !state) return
        rfbRef.current.viewOnly = state.controlMode !== "user"
        if (state.controlMode === "user") {
            requestAnimationFrame(() => rfbRef.current?.focus({ preventScroll: true }))
        }
    }, [state])

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
            body: JSON.stringify(body),
        })
        if (!res.ok) {
            const message = await res.text().catch(() => "")
            throw new Error(message || `Browser live action failed: ${res.status}`)
        }
        const nextState = await res.json() as BrowserAgentLiveState
        setState(nextState)
        requestAnimationFrame(() => rfbRef.current?.focus({ preventScroll: true }))
        return nextState
    }, [])

    const setControl = async (mode: LiveControlMode) => {
        setBusy(true)
        try {
            await postLiveAction({ action: mode === "user" ? "take_control" : "release_control" })
        } finally {
            setBusy(false)
        }
    }

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

    const pasteText = React.useCallback(async (text: string) => {
        if (!text) return
        setInputBusy(true)
        try {
            await postLiveAction({ action: "paste_text", text })
        } finally {
            setInputBusy(false)
        }
    }, [postLiveAction])

    const pasteFromClipboard = React.useCallback(async () => {
        try {
            const text = await navigator.clipboard?.readText?.()
            await pasteText(text || "")
        } catch {
            requestAnimationFrame(() => rfbRef.current?.focus({ preventScroll: true }))
        }
    }, [pasteText])

    const sendKey = React.useCallback(async (key: string) => {
        setInputBusy(true)
        try {
            await postLiveAction({ action: "press_key", key })
        } finally {
            setInputBusy(false)
        }
    }, [postLiveAction])

    const handleKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (state?.controlMode !== "user" || inputBusy) return
        const key = browserShortcutFromEvent(event, state.platform)
        if (!key) return
        event.preventDefault()
        event.stopPropagation()
        if (key === "Control+V" || key === "Meta+V") {
            const readText = navigator.clipboard?.readText?.bind(navigator.clipboard)
            if (!readText) {
                void sendKey(key)
                return
            }
            void readText()
                .then((text) => text ? pasteText(text) : sendKey(key))
                .catch(() => sendKey(key))
            return
        }
        void sendKey(key)
    }, [inputBusy, pasteText, sendKey, state?.controlMode, state?.platform])

    const handlePasteCapture = React.useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
        if (state?.controlMode !== "user") return
        const text = event.clipboardData.getData("text/plain")
        if (!text) return
        event.preventDefault()
        event.stopPropagation()
        void pasteText(text)
    }, [pasteText, state?.controlMode])

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

    const userControl = state.controlMode === "user"
    const viewportWidth = state.width && state.width > 0 ? state.width : 16
    const viewportHeight = state.height && state.height > 0 ? state.height : 9
    const statusLabel = state.paused
        ? "paused"
        : connection === "connected"
            ? "connected"
            : connection

    return (
        <div
            ref={liveViewRef}
            className="browser-agent-live-view grid gap-2 bg-background outline-none [&:fullscreen]:h-screen [&:fullscreen]:grid-rows-[auto_1fr] [&:fullscreen]:p-3"
            tabIndex={userControl ? 0 : -1}
            onKeyDownCapture={handleKeyDownCapture}
            onPasteCapture={handlePasteCapture}
            onPointerDown={() => {
                if (userControl) rfbRef.current?.focus({ preventScroll: true })
            }}
        >
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
                        <span className="truncate">{statusLabel}</span>
                    </button>
                ) : (
                    <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[12px] text-muted-foreground">
                        <Monitor className="size-3.5 shrink-0" />
                        <span className="truncate font-medium text-foreground/80">Browser agent</span>
                        <span className="truncate">{statusLabel}</span>
                    </span>
                )}
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => setControl(userControl ? "agent" : "user")}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60",
                        userControl
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                            : "border-border bg-background text-foreground/80 hover:bg-muted hover:text-foreground"
                    )}
                    aria-label={userControl ? "Return browser control to agent" : "Take browser control"}
                >
                    {busy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : userControl ? (
                        <Play className="size-3.5" />
                    ) : (
                        <MousePointer2 className="size-3.5" />
                    )}
                    {userControl ? "Return to agent" : "Take control"}
                </button>
                {userControl && (
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
                )}
                <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={fullscreen ? "Exit browser full screen" : "Open browser full screen"}
                >
                    {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                    {fullscreen ? "Exit full screen" : "Full screen"}
                </button>
            </div>
            <div
                ref={viewportRef}
                className="browser-agent-live-viewport min-h-0 w-full overflow-hidden rounded-md border border-border/70 bg-white shadow-sm [background:white]"
                style={{
                    aspectRatio: fullscreen ? "auto" : `${viewportWidth} / ${viewportHeight}`,
                    height: fullscreen ? "100%" : undefined,
                    maxHeight: fullscreen ? "none" : "min(360px, calc(100vh - 320px))",
                    minHeight: fullscreen ? 0 : "220px",
                }}
                aria-label={`${connection} browser live view`}
            >
                <div ref={targetRef} className="size-full bg-white" />
            </div>
        </div>
    )
}

function browserShortcutFromEvent(event: React.KeyboardEvent, platform: NodeJS.Platform): string | null {
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
