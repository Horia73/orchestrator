"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/utils"
import { enableTerminalTouchScroll } from "@/components/terminal-touch-scroll"

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
    const pasteNoticeTimerRef = React.useRef<number | null>(null)

    const [status, setStatus] = React.useState<"connecting" | "running" | "exited" | "error">("connecting")
    const [exitCode, setExitCode] = React.useState<number | null>(null)
    const [pasteNotice, setPasteNotice] = React.useState<string | null>(null)

    const showPasteNotice = React.useCallback(() => {
        setPasteNotice("Pasted into terminal. If nothing appears, the CLI is hiding secret input; press Enter.")
        if (pasteNoticeTimerRef.current !== null) {
            window.clearTimeout(pasteNoticeTimerRef.current)
        }
        pasteNoticeTimerRef.current = window.setTimeout(() => {
            setPasteNotice(null)
            pasteNoticeTimerRef.current = null
        }, 3500)
    }, [])

    const handlePasteCapture = React.useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
        const text = event.clipboardData?.getData("text") ?? ""
        if (text.length > 0) showPasteNotice()
    }, [showPasteNotice])

    const sendInput = React.useCallback((data: string) => {
        if (!data) return
        void fetch(`/api/cli/${encodeURIComponent(sessionId)}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data }),
        }).catch(() => { /* surfaced via stream errors */ })
    }, [sessionId])

    const focusTerminal = React.useCallback(() => {
        try {
            termRef.current?.focus()
        } catch {}
    }, [])

    const handleTerminalPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // Touch gestures are for scrolling; mobile typing uses the dedicated
        // input below. Focusing xterm here opens the software keyboard mid-drag
        // and makes the terminal feel locked in place.
        if (event.pointerType !== "mouse" || event.button !== 0) return
        focusTerminal()
    }, [focusTerminal])

    const handleMobileInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.currentTarget.value
        if (!value) return
        sendInput(value)
        event.currentTarget.value = ""
    }, [sendInput])

    const handleMobileInputKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault()
            sendInput("\r")
            event.currentTarget.value = ""
        } else if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
            event.preventDefault()
            sendInput("\x7f")
        } else if (event.key === "Tab") {
            event.preventDefault()
            sendInput("\t")
        } else if (event.key === "Escape") {
            event.preventDefault()
            sendInput("\x1b")
        }
    }, [sendInput])

    const handleMobileInputPaste = React.useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData?.getData("text") ?? ""
        if (!text) return
        event.preventDefault()
        sendInput(text)
        event.currentTarget.value = ""
        showPasteNotice()
    }, [sendInput, showPasteNotice])

    React.useEffect(() => {
        return () => {
            if (pasteNoticeTimerRef.current !== null) {
                window.clearTimeout(pasteNoticeTimerRef.current)
            }
        }
    }, [])

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
        const disableTouchScroll = enableTerminalTouchScroll(term, containerRef.current)
        const helperTextarea = containerRef.current.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
        if (helperTextarea) {
            helperTextarea.setAttribute("autocapitalize", "none")
            helperTextarea.setAttribute("autocomplete", "off")
            helperTextarea.setAttribute("autocorrect", "off")
            helperTextarea.setAttribute("enterkeyhint", "enter")
            helperTextarea.setAttribute("inputmode", "text")
            helperTextarea.spellcheck = false
        }
        try { fit.fit() } catch { /* container not laid out yet */ }
        term.focus()

        termRef.current = term
        fitRef.current = fit

        // Forward keystrokes to the PTY. xterm gives us the raw escape
        // sequences (arrow keys etc.) which we pass through unchanged.
        const dataDisposable = term.onData(data => {
            sendInput(data)
        })

        return () => {
            disableTouchScroll()
            dataDisposable.dispose()
            term.dispose()
            termRef.current = null
            fitRef.current = null
        }
    }, [sendInput])

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

        let es: EventSource | null = null
        let disposed = false
        let exited = false

        const connect = () => {
            if (disposed || exited) return
            es?.close()
            // The stream replays the whole session buffer on connect, so start
            // from a clean screen or reconnects would double the history.
            term.reset()
            textBufferRef.current = ""

            const source = new EventSource(`/api/cli/${encodeURIComponent(sessionId)}/stream`)
            es = source
            source.addEventListener("open", () => setStatus("running"))

            source.addEventListener("message", e => {
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
                        exited = true
                        setStatus("exited")
                        setExitCode(code)
                        onExit?.(code)
                        term.write(`\r\n\x1b[2;90m── exit ${code ?? "?"}\x1b[0m\r\n`)
                        source.close()
                    }
                } catch { /* malformed */ }
            })

            source.addEventListener("error", () => {
                // EventSource auto-retries; only flag if we have no signal yet.
                setStatus(prev => (prev === "connecting" ? "error" : prev))
            })
        }

        connect()

        // iOS Safari kills the SSE socket while the tab is backgrounded, and a
        // CLOSED EventSource never retries on its own — reconnect on foreground.
        const reconnectIfDead = () => {
            if (document.visibilityState !== "visible") return
            if (!es || es.readyState === EventSource.CLOSED) connect()
        }
        document.addEventListener("visibilitychange", reconnectIfDead)
        window.addEventListener("focus", reconnectIfDead)

        return () => {
            disposed = true
            document.removeEventListener("visibilitychange", reconnectIfDead)
            window.removeEventListener("focus", reconnectIfDead)
            es?.close()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    return (
        <div
            className={cn("flex flex-col overflow-hidden rounded-lg border border-border/70 bg-[#0c0c0e]", className)}
            onPasteCapture={handlePasteCapture}
            onPointerDown={handleTerminalPointerDown}
        >
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
                {pasteNotice && (
                    <span className="ml-auto max-w-[70%] truncate rounded bg-zinc-800 px-2 py-0.5 text-[11px] normal-case tracking-normal text-zinc-300">
                        {pasteNotice}
                    </span>
                )}
            </div>

            <div ref={containerRef} className="min-h-[220px] flex-1 px-2 py-2" />
            <div className="border-t border-zinc-800/80 bg-zinc-950 px-2 py-2 md:hidden">
                <input
                    type="text"
                    inputMode="text"
                    enterKeyHint="enter"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Terminal input"
                    placeholder="Terminal input"
                    onChange={handleMobileInputChange}
                    onKeyDown={handleMobileInputKeyDown}
                    onPaste={handleMobileInputPaste}
                    className="h-9 w-full rounded-md border border-zinc-800 bg-[#0c0c0e] px-2 font-mono text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
                />
            </div>
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
