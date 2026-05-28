"use client"

import * as React from "react"
import { Copy, ExternalLink, Terminal as TerminalIcon, X } from "lucide-react"
import { copyTextToClipboard } from "@/lib/clipboard"

import { cn } from "@/lib/utils"
import { CliTerminal } from "./cli-terminal"

interface CliLoginModalProps {
    cliName: string
    cliId: string
    mode: "install" | "login" | "logout" | "free" | "setup-token"
    hint: string
    onClose: () => void
}

const URL_REGEX = /https?:\/\/[^\s)\]"'<>\x1b]+/g
// CSI / OSC / single-char escape stripper for the URL detector. xterm itself
// renders everything fine — we just need clean text for regex matching.
const ANSI_REGEX = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g
const SPAWN_START_DELAY_MS = 100

function extractUrls(text: string): string[] {
    const stripped = text.replace(ANSI_REGEX, "")
    const found = new Set<string>()
    let m
    while ((m = URL_REGEX.exec(stripped)) !== null) {
        // Trim trailing punctuation a CLI might print right after a URL.
        found.add(m[0].replace(/[.,;:!?)\]]+$/, ""))
    }
    return [...found]
}

/**
 * Modal hosting an interactive CLI session. Pattern adapted from the quiz-local
 * cc-proxy admin panel: full xterm terminal in the body, plus a URL panel
 * above it that auto-extracts OAuth links so the user can click through.
 */
export function CliLoginModal({ cliName, cliId, mode, hint, onClose }: CliLoginModalProps) {
    const [sessionId, setSessionId] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const [exited, setExited] = React.useState<{ code: number | null } | null>(null)
    const [urls, setUrls] = React.useState<string[]>([])
    const [copiedUrl, setCopiedUrl] = React.useState<string | null>(null)

    React.useEffect(() => {
        let cancelled = false
        let createdSessionId: string | null = null
        // Avoid launching OAuth twice during React StrictMode's mount probe.
        const spawnTimer = window.setTimeout(() => {
            ;(async () => {
                try {
                    const res = await fetch("/api/cli/spawn", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ cli: cliId, mode }),
                    })
                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}))
                        throw new Error(body.error || `Spawn failed (${res.status})`)
                    }
                    const json = await res.json() as { sessionId: string }
                    if (cancelled) {
                        fetch(`/api/cli/${json.sessionId}`, { method: "DELETE" }).catch(() => {})
                        return
                    }
                    createdSessionId = json.sessionId
                    setSessionId(json.sessionId)
                } catch (err) {
                    if (!cancelled) setError(err instanceof Error ? err.message : "Spawn failed")
                }
            })()
        }, SPAWN_START_DELAY_MS)

        return () => {
            cancelled = true
            window.clearTimeout(spawnTimer)
            if (createdSessionId) {
                fetch(`/api/cli/${createdSessionId}`, { method: "DELETE" }).catch(() => {})
            }
        }
    }, [cliId, mode])

    const onText = React.useCallback((text: string) => {
        const next = extractUrls(text)
        setUrls(prev => (prev.length === next.length && prev.every((u, i) => u === next[i]) ? prev : next))
    }, [])

    const copy = async (url: string) => {
        if (!await copyTextToClipboard(url)) return
        setCopiedUrl(url)
        setTimeout(() => setCopiedUrl(prev => (prev === url ? null : prev)), 1200)
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 px-4 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-border/70 bg-card p-5 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground/5">
                            <TerminalIcon className="size-4 text-foreground/70" />
                        </span>
                        <div>
                            <h3 className="text-[16px] font-semibold leading-tight text-foreground">
                                {cliName} — {mode === "install"
                                    ? "Install"
                                    : mode === "login"
                                        ? "Login"
                                        : mode === "logout"
                                            ? "Logout"
                                            : mode === "setup-token"
                                                ? "Set up long-lived token"
                                                : "Session"}
                            </h3>
                            <p className="mt-0.5 text-[12.5px] text-foreground/60">{hint}</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="flex size-7 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
                        aria-label="Close"
                    >
                        <X className="size-4" />
                    </button>
                </div>

                {error && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                        {error}
                    </div>
                )}

                {urls.length > 0 && (
                    <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                        <div className="text-[11.5px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                            Open in your browser
                        </div>
                        {urls.map(url => (
                            <div key={url} className="flex items-center gap-2 text-[12.5px]">
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
                                >
                                    <ExternalLink className="size-3 shrink-0 opacity-70" />
                                    <span className="truncate">{url}</span>
                                </a>
                                <button
                                    onClick={() => copy(url)}
                                    className={cn(
                                        "inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground/70 transition-colors",
                                        "hover:bg-muted/60 hover:text-foreground"
                                    )}
                                >
                                    <Copy className="size-3" />
                                    {copiedUrl === url ? "Copied" : "Copy"}
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {sessionId ? (
                    <CliTerminal
                        sessionId={sessionId}
                        onExit={code => setExited({ code })}
                        onText={onText}
                        className="h-[440px]"
                    />
                ) : (
                    <div className="flex h-[440px] items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-[13px] text-foreground/55">
                        {error ? "Failed to start." : "Starting CLI session…"}
                    </div>
                )}

                <div className="flex items-center justify-between text-[12px] text-foreground/55">
                    <span>
                        {exited
                            ? exited.code === 0
                                ? "Session ended successfully."
                                : `Session ended with exit ${exited.code ?? "?"}.`
                            : mode === "install"
                                ? "Wait for installation to finish, then close this window."
                                : mode === "setup-token"
                                    ? "Open the URL, copy the token, paste it here, then press Enter. Claude Code may hide pasted token text."
                                    : "Type or click a URL to complete the flow."}
                    </span>
                    <button
                        onClick={onClose}
                        className="rounded-md border border-border bg-background px-2.5 py-1 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60"
                    >
                        {exited ? "Done" : "Close"}
                    </button>
                </div>
            </div>
        </div>
    )
}
