"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/utils"

interface SessionEvent {
    type: "data" | "exit" | "error"
    data?: string
    code?: number | null
    signal?: number | null
    message?: string
}

interface CliTerminalProps {
    sessionId: string
    /** Fired when the underlying subprocess exits. */
    onExit?: (code: number | null) => void
    /**
     * Receives the running plain-text accumulator. Useful for sibling panels
     * that want to scan output (e.g. URL detector).
     */
    onText?: (text: string) => void
    className?: string
}

/**
 * Full xterm.js terminal connected to a node-pty session via SSE.
 *
 * Stream payload is base64-encoded raw PTY bytes — we decode and pump
 * straight into xterm so ANSI cursor moves, colours, and TUIs render exactly
 * like in a native terminal. Keystrokes (including arrow keys, ctrl combos,
 * bracketed paste) are forwarded to /input as raw strings.
 *
 * Resize uses FitAddon + ResizeObserver: whenever the container size changes,
 * fit() recomputes cols/rows and we POST /resize so the PTY's TIOCSWINSZ
 * matches what the model sees.
 */
export function CliTerminal({ sessionId, onExit, onText, className }: CliTerminalProps) {
    const containerRef = React.useRef<HTMLDivElement>(null)
    const termRef = React.useRef<Terminal | null>(null)
    const fitRef = React.useRef<FitAddon | null>(null)
    const textBufferRef = React.useRef<string>("")

    const [status, setStatus] = React.useState<"connecting" | "running" | "exited" | "error">("connecting")
    const [exitCode, setExitCode] = React.useState<number | null>(null)

    // ---- Mount xterm ----------------------------------------------------
    React.useEffect(() => {
        if (!containerRef.current) return

        const term = new Terminal({
            convertEol: false,
            cursorBlink: true,
            cursorStyle: "block",
            fontFamily: '"SF Mono", Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.2,
            scrollback: 5000,
            allowProposedApi: true,
            theme: {
                background: "#0c0c0e",
                foreground: "#e4e4e7",
                cursor: "#e4e4e7",
                black: "#1f1f23",
                red: "#f87171",
                green: "#34d399",
                yellow: "#fbbf24",
                blue: "#60a5fa",
                magenta: "#c084fc",
                cyan: "#22d3ee",
                white: "#e4e4e7",
                brightBlack: "#52525b",
                brightRed: "#fca5a5",
                brightGreen: "#86efac",
                brightYellow: "#fcd34d",
                brightBlue: "#93c5fd",
                brightMagenta: "#d8b4fe",
                brightCyan: "#67e8f9",
                brightWhite: "#fafafa",
            },
        })
        const fit = new FitAddon()
        const links = new WebLinksAddon()
        term.loadAddon(fit)
        term.loadAddon(links)
        term.open(containerRef.current)
        try { fit.fit() } catch { /* container not laid out yet */ }

        termRef.current = term
        fitRef.current = fit

        // Forward keystrokes to the PTY. xterm gives us the raw escape
        // sequences (arrow keys etc.) which we pass through unchanged.
        const dataDisposable = term.onData(data => {
            void fetch(`/api/cli/${encodeURIComponent(sessionId)}/input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data }),
            }).catch(() => { /* surfaced via stream errors */ })
        })

        return () => {
            dataDisposable.dispose()
            term.dispose()
            termRef.current = null
            fitRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // ---- Resize -----------------------------------------------------------
    React.useEffect(() => {
        const el = containerRef.current
        const fit = fitRef.current
        const term = termRef.current
        if (!el || !fit || !term) return

        const apply = () => {
            try { fit.fit() } catch { return }
            const cols = term.cols
            const rows = term.rows
            void fetch(`/api/cli/${encodeURIComponent(sessionId)}/resize`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cols, rows }),
            }).catch(() => {})
        }

        const observer = new ResizeObserver(() => apply())
        observer.observe(el)
        apply()
        return () => observer.disconnect()
    }, [sessionId])

    // ---- SSE stream -------------------------------------------------------
    React.useEffect(() => {
        const term = termRef.current
        if (!term) return

        const es = new EventSource(`/api/cli/${encodeURIComponent(sessionId)}/stream`)
        es.addEventListener("open", () => setStatus("running"))

        es.addEventListener("message", e => {
            try {
                const ev = JSON.parse(e.data) as SessionEvent
                if (ev.type === "data" && ev.data) {
                    const bytes = base64ToUint8Array(ev.data)
                    term.write(bytes)
                    if (onText) {
                        textBufferRef.current += new TextDecoder("utf-8", { fatal: false }).decode(bytes)
                        // Cap so memory doesn't grow unbounded for long sessions.
                        if (textBufferRef.current.length > 1_000_000) {
                            textBufferRef.current = textBufferRef.current.slice(-500_000)
                        }
                        onText(textBufferRef.current)
                    }
                } else if (ev.type === "error") {
                    term.write(`\r\n\x1b[31m[error: ${ev.message ?? "unknown"}]\x1b[0m\r\n`)
                } else if (ev.type === "exit") {
                    const code = ev.code ?? null
                    setStatus("exited")
                    setExitCode(code)
                    onExit?.(code)
                    term.write(`\r\n\x1b[2;90m── exit ${code ?? "?"}\x1b[0m\r\n`)
                    es.close()
                }
            } catch { /* malformed */ }
        })

        es.addEventListener("error", () => {
            // EventSource auto-retries; only flag if we have no signal yet.
            if (status === "connecting") setStatus("error")
        })

        return () => { es.close() }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    return (
        <div className={cn("flex flex-col overflow-hidden rounded-lg border border-border/70 bg-[#0c0c0e]", className)}>
            <div className="flex items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-950 px-3 py-1.5">
                <span className="size-2.5 rounded-full bg-rose-500/80" />
                <span className="size-2.5 rounded-full bg-amber-500/80" />
                <span className="size-2.5 rounded-full bg-emerald-500/80" />
                <span className="ml-2 text-[11px] uppercase tracking-wider text-zinc-500">
                    {status === "exited"
                        ? `exit ${exitCode ?? "?"}`
                        : status === "error"
                          ? "stream lost"
                          : status === "running"
                            ? "connected"
                            : "connecting…"}
                </span>
                {status === "connecting" && <Loader2 className="ml-1 size-3 animate-spin text-zinc-500" />}
            </div>

            <div ref={containerRef} className="min-h-[280px] flex-1 px-2 py-2" />
        </div>
    )
}

/** Decode base64 → Uint8Array. xterm.write accepts both string and bytes. */
function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
}
