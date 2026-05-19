"use client"

import * as React from "react"
import { Loader2, Maximize2, Minimize2, Monitor, MousePointer2, Play, WifiOff } from "lucide-react"

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
}

export function BrowserAgentLiveView({ active = false }: BrowserAgentLiveViewProps) {
    const shellRef = React.useRef<HTMLDivElement>(null)
    const targetRef = React.useRef<HTMLDivElement>(null)
    const rfbRef = React.useRef<import("@novnc/novnc").default | null>(null)
    const [state, setState] = React.useState<BrowserAgentLiveState | null>(null)
    const [connection, setConnection] = React.useState<"idle" | "connecting" | "connected" | "disconnected" | "error">("idle")
    const [busy, setBusy] = React.useState(false)
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
    }, [state])

    React.useEffect(() => {
        const updateFullscreen = () => {
            setFullscreen(document.fullscreenElement === shellRef.current)
        }
        updateFullscreen()
        document.addEventListener("fullscreenchange", updateFullscreen)
        return () => document.removeEventListener("fullscreenchange", updateFullscreen)
    }, [])

    const setControl = async (mode: LiveControlMode) => {
        setBusy(true)
        try {
            const res = await fetch("/api/browser-agent/live", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: mode === "user" ? "take_control" : "release_control" }),
            })
            if (res.ok) setState(await res.json() as BrowserAgentLiveState)
        } finally {
            setBusy(false)
        }
    }

    const toggleFullscreen = async () => {
        try {
            if (document.fullscreenElement === shellRef.current) {
                await document.exitFullscreen()
                return
            }
            await shellRef.current?.requestFullscreen()
        } catch {
            // Fullscreen is best-effort and may be blocked by the host shell.
        }
    }

    if (!state) {
        return (
            <div className="grid h-[180px] place-items-center rounded-md border border-border/70 bg-muted/20 text-[12px] text-muted-foreground">
                <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Connecting live view</span>
            </div>
        )
    }

    if (state.mode === "mac-headful" && (state.available || state.ready)) {
        return (
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
                <Monitor className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">Patchright is running in a local headful browser window on this Mac.</span>
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">headful</span>
            </div>
        )
    }

    if (!state.ready || !state.wsUrl) {
        return (
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
                <WifiOff className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">{state.reason || "Live browser view is not available."}</span>
            </div>
        )
    }

    const userControl = state.controlMode === "user"
    const viewportWidth = state.width && state.width > 0 ? state.width : 16
    const viewportHeight = state.height && state.height > 0 ? state.height : 9

    return (
        <div
            ref={shellRef}
            className={cn(
                "grid gap-2 bg-background",
                fullscreen && "h-screen grid-rows-[minmax(0,1fr)_auto] p-3"
            )}
        >
            <div
                className={cn(
                    "min-h-0 overflow-hidden rounded-md border border-border/70 bg-white shadow-sm",
                    fullscreen ? "h-full" : "w-full"
                )}
                style={fullscreen ? undefined : { aspectRatio: `${viewportWidth} / ${viewportHeight}` }}
                aria-label={`${connection} browser live view`}
            >
                <div ref={targetRef} className="size-full bg-white" />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
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
        </div>
    )
}
