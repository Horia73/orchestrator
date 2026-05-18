"use client"

import * as React from "react"
import { Loader2, Monitor, MousePointer2, Pause, Play, WifiOff } from "lucide-react"

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
    const targetRef = React.useRef<HTMLDivElement>(null)
    const rfbRef = React.useRef<import("@novnc/novnc").default | null>(null)
    const [state, setState] = React.useState<BrowserAgentLiveState | null>(null)
    const [connection, setConnection] = React.useState<"idle" | "connecting" | "connected" | "disconnected" | "error">("idle")
    const [busy, setBusy] = React.useState(false)

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
                rfb.background = "#0c0c0e"
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

    return (
        <div className="overflow-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] shadow-sm">
            <div className="flex min-w-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950 px-3 py-2">
                <Monitor className="size-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-zinc-200">
                        Live Chromium {state.display ? `on ${state.display}` : ""}
                    </div>
                    <div className="truncate text-[11px] text-zinc-500">
                        {connection}{state.paused ? " · agent paused" : ""}{state.sessions[0]?.currentUrl ? ` · ${state.sessions[0].currentUrl}` : ""}
                    </div>
                </div>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => setControl(userControl ? "agent" : "user")}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[12px] transition-colors disabled:opacity-60",
                        userControl
                            ? "border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15"
                            : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                    )}
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
            </div>
            {userControl && (
                <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[11px] text-amber-200">
                    <Pause className="size-3.5" />
                    Human control is active. The browser agent is paused until control is returned.
                </div>
            )}
            <div ref={targetRef} className="h-[min(460px,calc(100vh-260px))] min-h-[260px] bg-[#0c0c0e]" />
        </div>
    )
}
