"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Download,
    KeyRound,
    Loader2,
    LogIn,
    LogOut,
    Network,
    RefreshCcw,
    RotateCcw,
    Search,
    Terminal as TerminalIcon,
    Trash2,
    WifiOff,
    XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CliLoginModal } from "@/components/cli/cli-login-modal"
import { useCliStatus, type CliStatusEntry } from "./use-cli-status"

interface ModalState {
    cliId: string
    cliName: string
    mode: "install" | "login" | "logout" | "free" | "setup-token"
    hint: string
}

type LMStudioBusy = "status" | "test" | "scan" | "connect" | "forget" | null

interface LMStudioStatus {
    configured: boolean
    apiKeyConfigured: boolean
    baseUrl: string
    online: boolean
    checkedAt: number
    latencyMs: number | null
    modelCount: number | null
    models: string[]
    endpoint: "native" | "openai" | null
    error: string | null
}

interface LMStudioScanResult extends Omit<LMStudioStatus, "configured" | "apiKeyConfigured"> {
    host: string
}

export function CliAccountsSection() {
    const { data, loading, error, refresh } = useCliStatus()
    const [modal, setModal] = React.useState<ModalState | null>(null)

    const closeModal = () => {
        setModal(null)
        // Subprocess may have just changed login state — re-pull.
        void refresh()
    }

    const restartCli = async (cliId: string, refreshStatus: () => Promise<void>) => {
        try {
            await fetch("/api/cli/restart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cli: cliId }),
            })
        } finally {
            // Re-detect even if the restart call failed — status is the source of truth.
            await refreshStatus()
        }
    }

    return (
        <section className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-3">
                <div>
                    <h2 className="text-[15px] font-semibold text-foreground/85">Local model runtimes</h2>
                    <p className="mt-0.5 text-[12.5px] text-foreground/50">
                        LM Studio on this network plus local CLI subscriptions used by the coding agent.
                        The app checks these locally and keeps their status visible.
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={loading}
                    title="Re-check login status"
                    className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors",
                        "hover:bg-muted/60 hover:text-foreground",
                        loading && "opacity-60"
                    )}
                >
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                    Recheck
                </button>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <LMStudioCard />

                {loading && !data && (
                    <>
                        <div className="h-[160px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                        <div className="h-[160px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                    </>
                )}

                {data && Object.entries(data).map(([id, entry]) => (
                    <CliCard
                        key={id}
                        id={id}
                        entry={entry}
                        onRestart={() => restartCli(id, refresh)}
                        onInstall={() => setModal({
                            cliId: id,
                            cliName: entry.name,
                            mode: "install",
                            hint: entry.installHint,
                        })}
                        onLogin={() => setModal({
                            cliId: id,
                            cliName: entry.name,
                            mode: "login",
                            hint: entry.loginHint,
                        })}
                        onLogout={() => setModal({
                            cliId: id,
                            cliName: entry.name,
                            mode: "logout",
                            hint: "Removing stored credentials. This may be instant.",
                        })}
                        onSetupToken={() => setModal({
                            cliId: id,
                            cliName: entry.name,
                            mode: "setup-token",
                            hint: "Browser will open to mint a long-lived API token. Copy the token it prints back into this terminal, then close this window. The token is stored locally and does not expire — recommended for headless installs.",
                        })}
                    />
                ))}
            </div>

            {modal && (
                <CliLoginModal
                    cliId={modal.cliId}
                    cliName={modal.cliName}
                    mode={modal.mode}
                    hint={modal.hint}
                    onClose={closeModal}
                />
            )}
        </section>
    )
}

function LMStudioCard() {
    const [status, setStatus] = React.useState<LMStudioStatus | null>(null)
    const [baseUrl, setBaseUrl] = React.useState("")
    const [apiKey, setApiKey] = React.useState("")
    const [apiKeyDirty, setApiKeyDirty] = React.useState(false)
    const [inputDirty, setInputDirty] = React.useState(false)
    const [busy, setBusy] = React.useState<LMStudioBusy>("status")
    const [notice, setNotice] = React.useState<{ tone: "success" | "warn" | "error"; text: string } | null>(null)
    const [scanResults, setScanResults] = React.useState<LMStudioScanResult[]>([])

    const loadStatus = React.useCallback(async (quiet = false) => {
        if (!quiet) setBusy("status")
        try {
            const res = await fetch("/api/lm-studio/status", { cache: "no-store" })
            const json = await res.json().catch(() => ({})) as LMStudioStatus & { error?: string }
            if (!res.ok) throw new Error(json.error || `Status failed (${res.status})`)
            setStatus(json)
            if (!inputDirty) setBaseUrl(json.baseUrl || "")
            if (!quiet && json.configured && !json.online) {
                setNotice({ tone: "warn", text: json.error ?? "LM Studio is configured but offline." })
            }
        } catch (err) {
            if (!quiet) {
                setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not read LM Studio status." })
            }
        } finally {
            if (!quiet) setBusy(null)
        }
    }, [inputDirty])

    React.useEffect(() => {
        void loadStatus()
    }, [loadStatus])

    React.useEffect(() => {
        const timer = window.setInterval(() => {
            void loadStatus(true)
        }, 10_000)
        return () => window.clearInterval(timer)
    }, [loadStatus])

    const typedApiKeyBody = apiKeyDirty ? { apiKey } : {}

    const test = async () => {
        if (!baseUrl.trim()) {
            setNotice({ tone: "warn", text: "Enter the LM Studio server URL first." })
            return
        }
        setBusy("test")
        setNotice(null)
        try {
            const res = await fetch("/api/lm-studio/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ baseUrl, ...typedApiKeyBody }),
            })
            const json = await res.json().catch(() => ({})) as LMStudioStatus & { error?: string }
            if (!res.ok) throw new Error(json.error || `Ping failed (${res.status})`)
            setNotice({ tone: "success", text: `Ping OK${json.modelCount !== null ? ` · ${json.modelCount} model${json.modelCount === 1 ? "" : "s"}` : ""}` })
        } catch (err) {
            setNotice({ tone: "error", text: err instanceof Error ? err.message : "LM Studio ping failed." })
        } finally {
            setBusy(null)
        }
    }

    const connect = async (nextBaseUrl = baseUrl) => {
        if (!nextBaseUrl.trim()) {
            setNotice({ tone: "warn", text: "Enter the LM Studio server URL first." })
            return false
        }
        setBusy("connect")
        setNotice(null)
        try {
            const res = await fetch("/api/lm-studio/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ baseUrl: nextBaseUrl, ...typedApiKeyBody }),
            })
            const json = await res.json().catch(() => ({})) as {
                status?: LMStudioStatus
                fetched?: number
                error?: string
            }
            if (!res.ok || !json.status) throw new Error(json.error || `Connect failed (${res.status})`)
            setStatus(json.status)
            setBaseUrl(json.status.baseUrl)
            setInputDirty(false)
            setApiKey("")
            setApiKeyDirty(false)
            setNotice({ tone: "success", text: `Connected to LM Studio · ${json.fetched ?? json.status.modelCount ?? 0} model${(json.fetched ?? json.status.modelCount ?? 0) === 1 ? "" : "s"} loaded.` })
            return true
        } catch (err) {
            setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not connect to LM Studio." })
            return false
        } finally {
            setBusy(null)
        }
    }

    const scan = async () => {
        setBusy("scan")
        setNotice(null)
        setScanResults([])
        try {
            const res = await fetch("/api/lm-studio/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ baseUrl: baseUrl.trim() || undefined, ...typedApiKeyBody }),
            })
            const json = await res.json().catch(() => ({})) as { results?: LMStudioScanResult[]; error?: string }
            if (!res.ok) throw new Error(json.error || `Scan failed (${res.status})`)
            const results = json.results ?? []
            setScanResults(results)
            if (results.length === 0) {
                setNotice({ tone: "warn", text: "No LM Studio server found on localhost or the detected private LAN ranges." })
                return
            }
            const best = results[0]
            setBaseUrl(best.baseUrl)
            setInputDirty(false)
            setNotice({ tone: "success", text: `Found ${best.host}. Connecting…` })
            await connect(best.baseUrl)
        } catch (err) {
            setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not scan for LM Studio." })
        } finally {
            setBusy(null)
        }
    }

    const forget = async () => {
        setBusy("forget")
        setNotice(null)
        try {
            const res = await fetch("/api/lm-studio/connect", { method: "DELETE" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Forget failed (${res.status})`)
            setStatus(null)
            setBaseUrl("")
            setApiKey("")
            setApiKeyDirty(false)
            setInputDirty(false)
            setScanResults([])
            setNotice({ tone: "success", text: "LM Studio config removed." })
            await loadStatus(true)
        } catch (err) {
            setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not remove LM Studio config." })
        } finally {
            setBusy(null)
        }
    }

    const statusBadge = busy === "status" && !status
        ? <Badge tone="muted" icon={<Loader2 className="size-3 animate-spin" />}>Checking</Badge>
        : status?.online
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Online</Badge>
            : status?.configured
                ? <Badge tone="warn" icon={<WifiOff className="size-3" />}>Offline</Badge>
                : <Badge tone="muted" icon={<XCircle className="size-3" />}>Not configured</Badge>

    const disabled = busy !== null
    const noticeClass =
        notice?.tone === "success"
            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
            : notice?.tone === "warn"
                ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300"
                : "border-destructive/30 bg-destructive/5 text-destructive"

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
                            <Network className="size-4 text-foreground/70" />
                        </span>
                        <CardTitle className="truncate">LM Studio</CardTitle>
                    </div>
                    {statusBadge}
                </div>
                <CardDescription className="mt-1">
                    Local OpenAI-compatible model server. Auto-detect scans only localhost,
                    host.docker.internal, common home LANs, and detected private LAN ranges on port 1234.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid gap-2">
                    <label className="grid gap-1.5">
                        <span className="text-[12px] font-medium text-foreground/65">Server URL</span>
                        <input
                            value={baseUrl}
                            onChange={(event) => {
                                setBaseUrl(event.target.value)
                                setInputDirty(true)
                            }}
                            placeholder="http://192.168.1.25:1234/v1"
                            className="h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring focus:ring-3 focus:ring-ring/30"
                        />
                    </label>
                    <label className="grid gap-1.5">
                        <span className="text-[12px] font-medium text-foreground/65">API key (optional)</span>
                        <input
                            value={apiKey}
                            onChange={(event) => {
                                setApiKey(event.target.value)
                                setApiKeyDirty(true)
                            }}
                            placeholder={status?.apiKeyConfigured ? "Saved; leave blank to keep existing" : "Only if LM Studio requires one"}
                            type="password"
                            className="h-9 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring focus:ring-3 focus:ring-ring/30"
                        />
                    </label>
                </div>

                <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Endpoint</span>
                    <span className="truncate text-foreground/85">{status?.endpoint ? `${status.endpoint} models API` : "Not checked"}</span>
                    <span className="text-foreground/55">Models</span>
                    <span className="truncate text-foreground/85">
                        {status?.modelCount !== null && status?.modelCount !== undefined
                            ? `${status.modelCount}${status.models.length ? ` · ${status.models.join(", ")}` : ""}`
                            : "Unknown"}
                    </span>
                    <span className="text-foreground/55">Ping</span>
                    <span className="text-foreground/85">{status?.latencyMs !== null && status?.latencyMs !== undefined ? `${status.latencyMs}ms` : "—"}</span>
                </div>

                {notice && (
                    <div className={cn("rounded-lg border px-3 py-2 text-[12px]", noticeClass)}>
                        {notice.text}
                    </div>
                )}

                {scanResults.length > 1 && (
                    <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-[12px] text-foreground/65">
                        Other matches: {scanResults.slice(1, 4).map((result) => result.host).join(", ")}
                    </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                    <button
                        onClick={scan}
                        disabled={disabled}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                        {busy === "scan" ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                        Auto-detect & Connect
                    </button>
                    <button
                        onClick={() => void connect()}
                        disabled={disabled}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
                    >
                        {busy === "connect" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                        Connect
                    </button>
                    <button
                        onClick={test}
                        disabled={disabled || !baseUrl.trim()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
                    >
                        {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                        Ping
                    </button>
                    {status?.configured && (
                        <button
                            onClick={forget}
                            disabled={disabled}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive disabled:opacity-60"
                        >
                            {busy === "forget" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                            Forget
                        </button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function CliCard({ id, entry, onInstall, onLogin, onLogout, onSetupToken, onRestart }: {
    id: string
    entry: CliStatusEntry
    onInstall: () => void
    onLogin: () => void
    onLogout: () => void
    onSetupToken: () => void
    onRestart: () => Promise<void>
}) {
    const [restarting, setRestarting] = React.useState(false)
    const handleRestart = async () => {
        if (restarting) return
        setRestarting(true)
        try {
            await onRestart()
        } finally {
            setRestarting(false)
        }
    }
    // Only Claude Code exposes the setup-token flow today; codex doesn't have
    // an equivalent and would confuse the user with an option that no-ops.
    const supportsSetupToken = id === "claude-code"
    const isOAuth = entry.authMethod === "oauth"
    const isSetupToken = entry.authMethod === "setup-token"

    const statusBadge = !entry.installed
        ? <Badge tone="muted" icon={<XCircle className="size-3" />}>Not installed</Badge>
        : entry.needsReconnect
            ? <Badge tone="warn" icon={<Clock className="size-3" />}>Reconnect</Badge>
            : entry.loggedIn
                ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Logged in</Badge>
                : <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Not logged in</Badge>

    const authMethodLabel = isOAuth
        ? "Browser OAuth (expires)"
        : isSetupToken
            ? "Long-lived token (no expiry)"
            : entry.authMethod === "api-key"
                ? "API key"
                : undefined

    const expiryLabel = formatExpiryHint(entry.expiresAt, entry.needsReconnect)

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground/5">
                            <TerminalIcon className="size-4 text-foreground/70" />
                        </span>
                        <CardTitle>{entry.name}</CardTitle>
                    </div>
                    {statusBadge}
                </div>
                <CardDescription className="mt-1">{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Binary</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground/85">{entry.bin}</code>
                    {entry.detail && (
                        <>
                            <span className="text-foreground/55">Account</span>
                            <span className="text-foreground/85">{entry.detail}</span>
                        </>
                    )}
                    {authMethodLabel && (
                        <>
                            <span className="text-foreground/55">Auth</span>
                            <span className={cn(
                                "text-foreground/85",
                                entry.needsReconnect && "text-amber-700 dark:text-amber-400"
                            )}>
                                {authMethodLabel}
                                {expiryLabel ? ` · ${expiryLabel}` : ""}
                            </span>
                        </>
                    )}
                </div>

                {entry.needsReconnect && supportsSetupToken && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                        <p className="font-medium">OAuth session expired.</p>
                        <p className="mt-0.5 text-amber-800/85 dark:text-amber-200/85">
                            Click <span className="font-medium">Reconnect</span> to refresh via browser OAuth, or set up a{" "}
                            <span className="font-medium">long-lived token</span> — recommended on a headless server so the
                            session does not drop every few days.
                        </p>
                    </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                    {!entry.installed ? (
                        <>
                            <button
                                onClick={onInstall}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90"
                            >
                                <Download className="size-3.5" />
                                Install
                            </button>
                            {entry.installDocsUrl && (
                                <a
                                    href={entry.installDocsUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/65 transition-colors hover:bg-muted/60 hover:text-foreground"
                                >
                                    Docs
                                </a>
                            )}
                        </>
                    ) : entry.needsReconnect ? (
                        <>
                            <button
                                onClick={onLogin}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90"
                            >
                                <LogIn className="size-3.5" />
                                Reconnect
                            </button>
                            {supportsSetupToken && (
                                <button
                                    onClick={onSetupToken}
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground"
                                >
                                    <KeyRound className="size-3.5" />
                                    Use long-lived token
                                </button>
                            )}
                            <button
                                onClick={onLogout}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
                            >
                                <LogOut className="size-3.5" />
                                Log out
                            </button>
                        </>
                    ) : entry.loggedIn ? (
                        <>
                            {supportsSetupToken && isOAuth && (
                                <button
                                    onClick={onSetupToken}
                                    title="Switch to a non-expiring API token — best for headless installs."
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground"
                                >
                                    <KeyRound className="size-3.5" />
                                    Switch to long-lived token
                                </button>
                            )}
                            <button
                                onClick={onLogout}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
                            >
                                <LogOut className="size-3.5" />
                                Log out
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={onLogin}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90"
                            >
                                <LogIn className="size-3.5" />
                                Log in
                            </button>
                            {supportsSetupToken && (
                                <button
                                    onClick={onSetupToken}
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground"
                                >
                                    <KeyRound className="size-3.5" />
                                    Use long-lived token
                                </button>
                            )}
                        </>
                    )}
                    {entry.installed && (
                        <button
                            onClick={handleRestart}
                            disabled={restarting}
                            title="Restart this CLI — clears live sessions and re-detects status. New models still need to be in the catalog."
                            className={cn(
                                "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/75 transition-colors",
                                "hover:bg-muted/60 hover:text-foreground",
                                restarting && "opacity-60"
                            )}
                        >
                            {restarting
                                ? <Loader2 className="size-3.5 animate-spin" />
                                : <RotateCcw className="size-3.5" />}
                            Restart
                        </button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function formatExpiryHint(expiresAt: number | undefined, needsReconnect: boolean | undefined): string {
    if (typeof expiresAt !== "number") return ""
    const deltaMs = expiresAt - Date.now()
    if (deltaMs < 0) {
        const ago = -deltaMs
        if (ago < 60_000) return "expired just now"
        if (ago < 3_600_000) return `expired ${Math.round(ago / 60_000)}m ago`
        if (ago < 86_400_000) return `expired ${Math.round(ago / 3_600_000)}h ago`
        return `expired ${Math.round(ago / 86_400_000)}d ago`
    }
    if (needsReconnect) {
        if (deltaMs < 60_000) return "expires in <1m"
        return `expires in ${Math.round(deltaMs / 60_000)}m`
    }
    if (deltaMs < 3_600_000) return `expires in ${Math.round(deltaMs / 60_000)}m`
    if (deltaMs < 86_400_000) return `expires in ${Math.round(deltaMs / 3_600_000)}h`
    return `expires in ${Math.round(deltaMs / 86_400_000)}d`
}

function Badge({ tone, icon, children }: {
    tone: "success" | "warn" | "muted"
    icon: React.ReactNode
    children: React.ReactNode
}) {
    const cls =
        tone === "success" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : tone === "warn" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted text-foreground/55"
    return (
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium", cls)}>
            {icon}
            {children}
        </span>
    )
}
