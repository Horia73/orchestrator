"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Download,
    Loader2,
    LogIn,
    LogOut,
    RefreshCcw,
    RotateCcw,
    Terminal as TerminalIcon,
    XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CliLoginModal } from "@/components/cli/cli-login-modal"
import { useCliStatus, type CliStatusEntry } from "./use-cli-status"

interface ModalState {
    cliId: string
    cliName: string
    mode: "install" | "login" | "logout" | "free"
    hint: string
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
                    <h2 className="text-[15px] font-semibold text-foreground/85">CLI accounts</h2>
                    <p className="mt-0.5 text-[12.5px] text-foreground/50">
                        Local CLI subscriptions used by the coding agent. The orchestrator delegates code work
                        through these — no API key needed once you&apos;re logged in.
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
                {loading && !data && (
                    <>
                        <div className="h-[160px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                        <div className="h-[160px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                    </>
                )}

                {data && Object.entries(data).map(([id, entry]) => (
                    <CliCard
                        key={id}
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

function CliCard({ entry, onInstall, onLogin, onLogout, onRestart }: {
    entry: CliStatusEntry
    onInstall: () => void
    onLogin: () => void
    onLogout: () => void
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
