"use client"

import * as React from "react"
import {
    AlertCircle,
    CalendarDays,
    CheckCircle2,
    ChevronDown,
    Clipboard,
    ExternalLink,
    FolderOpen,
    House,
    KeyRound,
    Loader2,
    LogIn,
    Mail,
    MessageCircle,
    Plus,
    QrCode,
    RefreshCcw,
    Save,
    ShieldCheck,
    Smartphone,
    Unplug,
    Upload,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CliAccountsSection } from "@/components/settings/cli-accounts"
import {
    useIntegrationsStatus,
    type GmailIntegrationStatusEntry,
    type GoogleCalendarIntegrationStatusEntry,
    type GoogleDriveIntegrationStatusEntry,
    type HomeAssistantIntegrationStatusEntry,
    type RuntimeAccessInfo,
    type WhatsAppIntegrationStatusEntry,
} from "@/components/settings/use-integrations-status"

type OAuthMessage = {
    type?: string
    provider?: string
    ok?: boolean
    message?: string
}

interface GmailConfigInput {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    rawEnv?: string
}

interface GoogleWorkspaceConfigInput {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    rawEnv?: string
}

type GoogleCalendarConfigInput = GoogleWorkspaceConfigInput
type GoogleDriveConfigInput = GoogleWorkspaceConfigInput

interface HomeAssistantConfigInput {
    baseUrl?: string
    token?: string
    rawEnv?: string
}

type BusyAction =
    | "connect"
    | "disconnect"
    | "save"
    | "google-calendar-connect"
    | "google-calendar-disconnect"
    | "google-calendar-save"
    | "google-drive-connect"
    | "google-drive-disconnect"
    | "google-drive-save"
    | "whatsapp-connect"
    | "whatsapp-disconnect"
    | "homeassistant-save"
    | "homeassistant-disconnect"
    | "homeassistant-action-mode"
    | null

type NoticeTone = "success" | "error" | "warning"

function shouldWarnAboutLocalhostRedirect(redirectUri: string): boolean {
    if (typeof window === "undefined") return false
    const redirectUrl = parseUrl(redirectUri)
    if (!redirectUrl || !isLoopbackHostname(redirectUrl.hostname)) return false
    return !isLoopbackHostname(window.location.hostname)
}

function localhostRedirectNotice(redirectUri: string, runtime?: RuntimeAccessInfo): { tone: NoticeTone; text: string } {
    const tunnel = buildTunnelHelp(redirectUri, runtime)
    return {
        tone: "warning",
        text: `Google will return to ${redirectUri}. That works directly if Orchestrator is running on this same browser machine. If Orchestrator is on a different headless server, run ${tunnel.command}, keep that terminal open until the integration says Connected, use ${tunnel.openUrl}, then stop the tunnel with Ctrl+C.`,
    }
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value)
    } catch {
        return null
    }
}

function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
    return host === "localhost"
        || host.endsWith(".localhost")
        || host === "::1"
        || host === "0:0:0:0:0:0:0:1"
        || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function buildTunnelHelp(redirectUri: string, runtime?: RuntimeAccessInfo): { command: string; openUrl: string } {
    const redirectUrl = parseUrl(redirectUri)
    const localPort = redirectUrl?.port || runtime?.tunnel.localPort || "3000"
    const remotePort = runtime?.tunnel.remotePort || "3000"
    const currentHost = typeof window === "undefined" ? "" : window.location.hostname
    const host = runtime?.sshHostCandidates[0]
        || (currentHost && !isLoopbackHostname(currentHost) ? currentHost : "")
        || "server"
    const user = runtime?.sshUser || "user"
    return {
        command: `ssh -N -L ${localPort}:127.0.0.1:${remotePort} ${user}@${host}`,
        openUrl: `http://localhost:${localPort}/settings`,
    }
}

const GOOGLE_PROJECTS_URL = "https://console.cloud.google.com/projectselector2/home/dashboard"
const GOOGLE_AUTH_BRANDING_URL = "https://console.cloud.google.com/auth/branding"
const GOOGLE_AUTH_AUDIENCE_URL = "https://console.cloud.google.com/auth/audience"
const GOOGLE_AUTH_CLIENTS_URL = "https://console.cloud.google.com/auth/clients"
const ENABLE_GMAIL_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com"
const ENABLE_CALENDAR_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com"
const ENABLE_DRIVE_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com"
const ENABLE_DOCS_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=docs.googleapis.com"
const ENABLE_SHEETS_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=sheets.googleapis.com"
const ENABLE_SLIDES_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=slides.googleapis.com"
const ENABLE_PEOPLE_API_URL = "https://console.cloud.google.com/flows/enableapi?apiid=people.googleapis.com"

export function AuthTab() {
    return (
        <div className="flex flex-col gap-6">
            <ConnectedServicesSection />
            <div className="border-t border-border/60 pt-6">
                <CliAccountsSection />
            </div>
        </div>
    )
}

function ConnectedServicesSection() {
    const { data, loading, error, refresh } = useIntegrationsStatus()
    const [busy, setBusy] = React.useState<BusyAction>(null)
    const [feedback, setFeedback] = React.useState<{ tone: NoticeTone; text: string } | null>(null)
    const popupRef = React.useRef<Window | null>(null)

    React.useEffect(() => {
        const handler = (event: MessageEvent<OAuthMessage>) => {
            if (event.origin !== window.location.origin) return
            if (event.data?.type !== "orchestrator:integration-auth") return
            if (event.data.provider !== "gmail" && event.data.provider !== "googleCalendar" && event.data.provider !== "googleDrive") return
            setBusy(null)
            const label = event.data.provider === "googleCalendar"
                ? "Google Calendar"
                : event.data.provider === "googleDrive"
                    ? "Google Workspace"
                    : "Gmail"
            setFeedback({
                tone: event.data.ok === true ? "success" : "error",
                text: event.data.message || (event.data.ok ? `${label} connected.` : `${label} authorization failed.`),
            })
            void refresh()
        }
        window.addEventListener("message", handler)
        return () => window.removeEventListener("message", handler)
    }, [refresh])

    React.useEffect(() => {
        if (busy !== "connect" && busy !== "google-calendar-connect" && busy !== "google-drive-connect") return
        const timer = window.setInterval(() => {
            if (popupRef.current?.closed) {
                popupRef.current = null
                setBusy(null)
                void refresh()
            }
        }, 1200)
        return () => window.clearInterval(timer)
    }, [busy, refresh])

    React.useEffect(() => {
        const phase = data?.whatsapp.phase
        if (phase !== "starting" && phase !== "qr" && phase !== "authenticated") return
        const timer = window.setInterval(() => void refresh(), 2000)
        return () => window.clearInterval(timer)
    }, [data?.whatsapp.phase, refresh])

    const connectGmail = async () => {
        setBusy("connect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/gmail/oauth/start", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { authUrl?: string; redirectUri?: string; error?: string }
            if (!res.ok || !json.authUrl) throw new Error(json.error || `OAuth start failed (${res.status})`)
            if (json.redirectUri && shouldWarnAboutLocalhostRedirect(json.redirectUri)) {
                setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
            }

            const popup = window.open(
                json.authUrl,
                "orchestrator-gmail-oauth",
                "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
            )
            if (!popup) {
                window.location.assign(json.authUrl)
                return
            }
            popupRef.current = popup
            popup.focus()
        } catch (err) {
            setBusy(null)
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not start Gmail OAuth." })
        }
    }

    const disconnectGmail = async () => {
        const confirmed = window.confirm("Disconnect Gmail from Orchestrator? Stored Gmail OAuth tokens will be removed locally.")
        if (!confirmed) return
        setBusy("disconnect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/gmail/disconnect", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Disconnect failed (${res.status})`)
            setFeedback({ tone: "success", text: "Gmail disconnected." })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect Gmail." })
        } finally {
            setBusy(null)
        }
    }

    const saveGmailConfig = async (input: GmailConfigInput): Promise<boolean> => {
        setBusy("save")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/gmail/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
            setFeedback({ tone: "success", text: "Gmail OAuth config saved." })
            await refresh()
            return true
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not save Gmail OAuth config." })
            return false
        } finally {
            setBusy(null)
        }
    }

    const connectGoogleCalendar = async () => {
        setBusy("google-calendar-connect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-calendar/oauth/start", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { authUrl?: string; redirectUri?: string; error?: string }
            if (!res.ok || !json.authUrl) throw new Error(json.error || `OAuth start failed (${res.status})`)
            if (json.redirectUri && shouldWarnAboutLocalhostRedirect(json.redirectUri)) {
                setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
            }

            const popup = window.open(
                json.authUrl,
                "orchestrator-google-calendar-oauth",
                "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
            )
            if (!popup) {
                window.location.assign(json.authUrl)
                return
            }
            popupRef.current = popup
            popup.focus()
        } catch (err) {
            setBusy(null)
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not start Google Calendar OAuth." })
        }
    }

    const disconnectGoogleCalendar = async () => {
        const confirmed = window.confirm("Disconnect Google Calendar from Orchestrator? Stored Google Calendar OAuth tokens will be removed locally.")
        if (!confirmed) return
        setBusy("google-calendar-disconnect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-calendar/disconnect", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Disconnect failed (${res.status})`)
            setFeedback({ tone: "success", text: "Google Calendar disconnected." })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect Google Calendar." })
        } finally {
            setBusy(null)
        }
    }

    const saveGoogleCalendarConfig = async (input: GoogleCalendarConfigInput): Promise<boolean> => {
        setBusy("google-calendar-save")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-calendar/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
            setFeedback({ tone: "success", text: "Google Workspace OAuth config saved." })
            await refresh()
            return true
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not save Google Calendar OAuth config." })
            return false
        } finally {
            setBusy(null)
        }
    }

    const connectGoogleDrive = async () => {
        setBusy("google-drive-connect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-drive/oauth/start", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { authUrl?: string; redirectUri?: string; error?: string }
            if (!res.ok || !json.authUrl) throw new Error(json.error || `OAuth start failed (${res.status})`)
            if (json.redirectUri && shouldWarnAboutLocalhostRedirect(json.redirectUri)) {
                setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
            }

            const popup = window.open(
                json.authUrl,
                "orchestrator-google-drive-oauth",
                "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
            )
            if (!popup) {
                window.location.assign(json.authUrl)
                return
            }
            popupRef.current = popup
            popup.focus()
        } catch (err) {
            setBusy(null)
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not start Google Workspace OAuth." })
        }
    }

    const disconnectGoogleDrive = async () => {
        const confirmed = window.confirm("Disconnect Google Workspace from Orchestrator? Stored Google Workspace OAuth tokens will be removed locally.")
        if (!confirmed) return
        setBusy("google-drive-disconnect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-drive/disconnect", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Disconnect failed (${res.status})`)
            setFeedback({ tone: "success", text: "Google Workspace disconnected." })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect Google Workspace." })
        } finally {
            setBusy(null)
        }
    }

    const saveGoogleDriveConfig = async (input: GoogleDriveConfigInput): Promise<boolean> => {
        setBusy("google-drive-save")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/google-drive/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
            setFeedback({ tone: "success", text: "Google Workspace OAuth config saved." })
            await refresh()
            return true
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not save Google Workspace OAuth config." })
            return false
        } finally {
            setBusy(null)
        }
    }

    const connectWhatsApp = async () => {
        setBusy("whatsapp-connect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/whatsapp/start", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { status?: WhatsAppIntegrationStatusEntry; error?: string }
            if (!res.ok || !json.status) throw new Error(json.error || `WhatsApp start failed (${res.status})`)

            setFeedback({
                tone: "success",
                text: json.status.connected
                    ? "WhatsApp connected."
                    : json.status.qrAvailable
                        ? "Scan the WhatsApp QR code with your phone."
                        : "WhatsApp is starting. The QR code will appear here when ready.",
            })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not start WhatsApp." })
        } finally {
            setBusy(null)
        }
    }

    const disconnectWhatsApp = async () => {
        const confirmed = window.confirm("Disconnect WhatsApp from Orchestrator? Stored local WhatsApp Web session files will be removed.")
        if (!confirmed) return
        setBusy("whatsapp-disconnect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/whatsapp/disconnect", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Disconnect failed (${res.status})`)
            setFeedback({ tone: "success", text: "WhatsApp disconnected." })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect WhatsApp." })
        } finally {
            setBusy(null)
        }
    }

    const saveHomeAssistantConfig = async (input: HomeAssistantConfigInput): Promise<boolean> => {
        setBusy("homeassistant-save")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/home-assistant/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            })
            const json = await res.json().catch(() => ({})) as {
                error?: string
                homeAssistant?: HomeAssistantIntegrationStatusEntry
            }
            if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
            setFeedback({
                tone: json.homeAssistant?.connected === true ? "success" : "warning",
                text: json.homeAssistant?.connected
                    ? "Home Assistant config saved and verified."
                    : "Home Assistant config saved, but the API could not be verified yet.",
            })
            await refresh()
            return true
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not save Home Assistant config." })
            return false
        } finally {
            setBusy(null)
        }
    }

    const disconnectHomeAssistant = async () => {
        const confirmed = window.confirm("Remove Home Assistant URL and token from local Orchestrator config?")
        if (!confirmed) return
        setBusy("homeassistant-disconnect")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/home-assistant/disconnect", { method: "POST" })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Disconnect failed (${res.status})`)
            setFeedback({ tone: "success", text: "Home Assistant config removed." })
            await refresh()
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not remove Home Assistant config." })
        } finally {
            setBusy(null)
        }
    }

    const updateHomeAssistantActionMode = async (enabled: boolean): Promise<boolean> => {
        setBusy("homeassistant-action-mode")
        setFeedback(null)
        try {
            const res = await fetch("/api/integrations/home-assistant/action-policy", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    enabled,
                    directDomains: ["light", "cover", "climate", "notify"],
                    confirmOtherDomains: true,
                }),
            })
            const json = await res.json().catch(() => ({})) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Action mode update failed (${res.status})`)
            setFeedback({
                tone: "success",
                text: enabled
                    ? "Home Assistant action mode enabled."
                    : "Home Assistant action mode disabled.",
            })
            await refresh()
            return true
        } catch (err) {
            setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not update Home Assistant action mode." })
            return false
        } finally {
            setBusy(null)
        }
    }

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                    <h2 className="text-[15px] font-semibold text-foreground/85">Connected services</h2>
                    <p className="mt-0.5 text-[12.5px] text-foreground/50">
                        OAuth accounts and external services available to Orchestrator and Concierge.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                    Recheck
                </Button>
            </div>

            {error && (
                <InlineNotice tone="error" text={error} />
            )}
            {feedback && (
                <InlineNotice tone={feedback.tone} text={feedback.text} />
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {loading && !data ? (
                    <div className="h-[230px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                ) : data ? (
                    <>
                        <GmailCard
                            entry={data.gmail}
                            runtime={data.runtime}
                            busy={busy}
                            onConnect={connectGmail}
                            onDisconnect={disconnectGmail}
                            onSaveConfig={saveGmailConfig}
                        />
                        <WhatsAppCard
                            entry={data.whatsapp}
                            busy={busy}
                            onConnect={connectWhatsApp}
                            onDisconnect={disconnectWhatsApp}
                        />
                        <GoogleCalendarCard
                            entry={data.googleCalendar}
                            runtime={data.runtime}
                            busy={busy}
                            onConnect={connectGoogleCalendar}
                            onDisconnect={disconnectGoogleCalendar}
                            onSaveConfig={saveGoogleCalendarConfig}
                        />
                        <GoogleWorkspaceCard
                            entry={data.googleDrive}
                            runtime={data.runtime}
                            busy={busy}
                            onConnect={connectGoogleDrive}
                            onDisconnect={disconnectGoogleDrive}
                            onSaveConfig={saveGoogleDriveConfig}
                        />
                        <HomeAssistantCard
                            entry={data.homeAssistant}
                            busy={busy}
                            onSaveConfig={saveHomeAssistantConfig}
                            onUpdateActionMode={updateHomeAssistantActionMode}
                            onDisconnect={disconnectHomeAssistant}
                        />
                    </>
                ) : null}
            </div>
        </section>
    )
}

function GmailCard({
    entry,
    runtime,
    busy,
    onConnect,
    onDisconnect,
    onSaveConfig,
}: {
    entry: GmailIntegrationStatusEntry
    runtime?: RuntimeAccessInfo
    busy: BusyAction
    onConnect: () => void
    onDisconnect: () => void
    onSaveConfig: (input: GmailConfigInput) => Promise<boolean>
}) {
    const connected = entry.connected && !entry.needsReconnect
    const badge = !entry.configured
        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Config needed</Badge>
        : connected
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Connected</Badge>
            : entry.connected
                ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Reconnect</Badge>
                : <Badge tone="muted" icon={<AlertCircle className="size-3" />}>Not connected</Badge>

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
                            <Mail className="size-4 text-red-600 dark:text-red-400" />
                        </span>
                        <CardTitle className="truncate">{entry.name}</CardTitle>
                    </div>
                    {badge}
                </div>
                <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Account</span>
                    <span className="truncate text-foreground/85">{entry.accountEmail ?? "Not connected"}</span>
                    <span className="text-foreground/55">Redirect URI</span>
                    <CopyableCode value={entry.redirectUri} openable />
                    <span className="text-foreground/55">Access</span>
                    <div className="flex flex-wrap gap-1.5">
                        {entry.requestedScopes.map(scope => (
                            <span
                                key={scope}
                                title={scope}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                                    entry.scopes.includes(scope)
                                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                        : "bg-muted text-foreground/50"
                                )}
                            >
                                <ShieldCheck className="size-3" />
                                {scopeLabel(scope)}
                            </span>
                        ))}
                    </div>
                    {entry.expiresAt && (
                        <>
                            <span className="text-foreground/55">Token</span>
                            <span className="text-foreground/75">{formatExpiry(entry.expiresAt)}</span>
                        </>
                    )}
                </div>

                {!entry.configured && (
                    <GmailConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
                )}
                <GmailSetupGuide redirectUri={entry.redirectUri} runtime={runtime} />
                {entry.error && <InlineNotice tone="error" text={entry.error} />}

                <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                        size="sm"
                        onClick={onConnect}
                        disabled={!entry.configured || busy !== null}
                    >
                        {busy === "connect" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                        {entry.connected ? "Reconnect" : "Connect"}
                    </Button>
                    {entry.connected && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onDisconnect}
                            disabled={busy !== null}
                            className="text-destructive hover:text-destructive"
                        >
                            {busy === "disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                            Disconnect
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function GoogleCalendarCard({
    entry,
    runtime,
    busy,
    onConnect,
    onDisconnect,
    onSaveConfig,
}: {
    entry: GoogleCalendarIntegrationStatusEntry
    runtime?: RuntimeAccessInfo
    busy: BusyAction
    onConnect: () => void
    onDisconnect: () => void
    onSaveConfig: (input: GoogleCalendarConfigInput) => Promise<boolean>
}) {
    const connected = entry.connected && !entry.needsReconnect
    const badge = !entry.configured
        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Config needed</Badge>
        : connected
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Connected</Badge>
            : entry.connected
                ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Reconnect</Badge>
                : <Badge tone="muted" icon={<AlertCircle className="size-3" />}>Not connected</Badge>

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                            <CalendarDays className="size-4 text-blue-700 dark:text-blue-400" />
                        </span>
                        <CardTitle className="truncate">{entry.name}</CardTitle>
                    </div>
                    {badge}
                </div>
                <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Account</span>
                    <span className="truncate text-foreground/85">{entry.accountEmail ?? "Not connected"}</span>
                    <span className="text-foreground/55">Primary</span>
                    <span className="truncate text-foreground/75" title={entry.primaryCalendarId ?? undefined}>
                        {entry.primaryCalendarSummary || entry.primaryCalendarId || "Not verified"}
                    </span>
                    <span className="text-foreground/55">Calendars</span>
                    <span className="text-foreground/75">
                        {entry.calendarCount === null ? "Not read yet" : `${entry.calendarCount} visible`}
                        {entry.writableCalendarCount !== null ? ` | ${entry.writableCalendarCount} writable` : ""}
                    </span>
                    <span className="text-foreground/55">Timezone</span>
                    <span className="truncate text-foreground/75">{entry.timeZone ?? "Not verified"}</span>
                    <span className="text-foreground/55">Redirect URI</span>
                    <CopyableCode value={entry.redirectUri} openable />
                    <span className="text-foreground/55">Access</span>
                    <div className="flex flex-wrap gap-1.5">
                        {entry.requestedScopes.map(scope => (
                            <span
                                key={scope}
                                title={scope}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                                    calendarScopeGranted(entry.scopes, scope)
                                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                        : "bg-muted text-foreground/50"
                                )}
                            >
                                <ShieldCheck className="size-3" />
                                {calendarScopeLabel(scope)}
                            </span>
                        ))}
                    </div>
                    {entry.expiresAt && (
                        <>
                            <span className="text-foreground/55">Token</span>
                            <span className="text-foreground/75">{formatExpiry(entry.expiresAt)}</span>
                        </>
                    )}
                </div>

                {!entry.configured && (
                    <GoogleWorkspaceConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
                )}
                <GoogleCalendarSetupGuide redirectUri={entry.redirectUri} runtime={runtime} />
                {entry.error && <InlineNotice tone="error" text={entry.error} />}

                <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                        size="sm"
                        onClick={onConnect}
                        disabled={!entry.configured || busy !== null}
                    >
                        {busy === "google-calendar-connect" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                        {entry.connected ? "Reconnect" : "Connect"}
                    </Button>
                    {entry.connected && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onDisconnect}
                            disabled={busy !== null}
                            className="text-destructive hover:text-destructive"
                        >
                            {busy === "google-calendar-disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                            Disconnect
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function GoogleWorkspaceCard({
    entry,
    runtime,
    busy,
    onConnect,
    onDisconnect,
    onSaveConfig,
}: {
    entry: GoogleDriveIntegrationStatusEntry
    runtime?: RuntimeAccessInfo
    busy: BusyAction
    onConnect: () => void
    onDisconnect: () => void
    onSaveConfig: (input: GoogleDriveConfigInput) => Promise<boolean>
}) {
    const connected = entry.connected && !entry.needsReconnect
    const badge = !entry.configured
        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Config needed</Badge>
        : connected
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Connected</Badge>
            : entry.connected
                ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Reconnect</Badge>
                : <Badge tone="muted" icon={<AlertCircle className="size-3" />}>Not connected</Badge>

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
                            <FolderOpen className="size-4 text-emerald-700 dark:text-emerald-400" />
                        </span>
                        <CardTitle className="truncate">{entry.name}</CardTitle>
                    </div>
                    {badge}
                </div>
                <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Account</span>
                    <span className="truncate text-foreground/85">
                        {entry.accountEmail ?? entry.accountName ?? "Not connected"}
                    </span>
                    <span className="text-foreground/55">Storage</span>
                    <span className="truncate text-foreground/75">
                        {formatDriveStorage(entry.storageQuota)}
                    </span>
                    <span className="text-foreground/55">Max upload</span>
                    <span className="truncate text-foreground/75">
                        {entry.maxUploadSize ? formatByteString(entry.maxUploadSize) : "Not verified"}
                    </span>
                    <span className="text-foreground/55">Redirect URI</span>
                    <CopyableCode value={entry.redirectUri} openable />
                    <span className="text-foreground/55">Access</span>
                    <div className="flex flex-wrap gap-1.5">
                        {entry.requestedScopes.map(scope => (
                            <span
                                key={scope}
                                title={scope}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                                    driveScopeGranted(entry.scopes, scope)
                                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                        : "bg-muted text-foreground/50"
                                )}
                            >
                                <ShieldCheck className="size-3" />
                                {driveScopeLabel(scope)}
                            </span>
                        ))}
                    </div>
                    {entry.expiresAt && (
                        <>
                            <span className="text-foreground/55">Token</span>
                            <span className="text-foreground/75">{formatExpiry(entry.expiresAt)}</span>
                        </>
                    )}
                </div>

                {!entry.configured && (
                    <GoogleWorkspaceConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
                )}
                <GoogleWorkspaceSetupGuide redirectUri={entry.redirectUri} runtime={runtime} />
                {entry.error && <InlineNotice tone="error" text={entry.error} />}

                <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                        size="sm"
                        onClick={onConnect}
                        disabled={!entry.configured || busy !== null}
                    >
                        {busy === "google-drive-connect" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                        {entry.connected ? "Reconnect" : "Connect"}
                    </Button>
                    {entry.connected && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onDisconnect}
                            disabled={busy !== null}
                            className="text-destructive hover:text-destructive"
                        >
                            {busy === "google-drive-disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                            Disconnect
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function WhatsAppCard({
    entry,
    busy,
    onConnect,
    onDisconnect,
}: {
    entry: WhatsAppIntegrationStatusEntry
    busy: BusyAction
    onConnect: () => void
    onDisconnect: () => void
}) {
    const connected = entry.connected && !entry.needsReconnect
    const savedSessionIdle = entry.sessionStored && !connected && entry.phase !== "qr" && entry.phase !== "starting" && entry.phase !== "authenticated"
    const badge = !entry.configured
        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Browser needed</Badge>
        : connected
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Connected</Badge>
            : entry.phase === "qr"
                ? <Badge tone="warn" icon={<QrCode className="size-3" />}>Scan QR</Badge>
                : entry.phase === "starting" || entry.phase === "authenticated"
                    ? <Badge tone="warn" icon={<Loader2 className="size-3 animate-spin" />}>Linking</Badge>
                    : savedSessionIdle
                        ? <Badge tone="warn" icon={<Smartphone className="size-3" />}>Session saved</Badge>
                    : entry.phase === "error" || entry.phase === "auth_failure"
                        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Reconnect</Badge>
                        : <Badge tone="muted" icon={<AlertCircle className="size-3" />}>Not connected</Badge>

    const qrSrc = entry.qrDataUrl ?? entry.qrImageUrl

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
                            <MessageCircle className="size-4 text-emerald-700 dark:text-emerald-400" />
                        </span>
                        <CardTitle className="truncate">{entry.name}</CardTitle>
                    </div>
                    {badge}
                </div>
                <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Account</span>
                    <span className="truncate text-foreground/85">
                        {entry.accountName || entry.phoneNumber || (entry.sessionStored ? "Reconnect to verify" : "Not connected")}
                    </span>
                    <span className="text-foreground/55">Session</span>
                    <span className="text-foreground/75">
                        {connected ? "Running from local session" : entry.sessionStored ? "Stored locally; reconnect to start" : "No local session"}
                    </span>
                    <span className="text-foreground/55">Browser</span>
                    <span className="truncate text-foreground/75" title={entry.browserExecutablePath ?? undefined}>
                        {entry.browserExecutablePath ? shortPath(entry.browserExecutablePath) : "Chrome/Chromium not found"}
                    </span>
                    <span className="text-foreground/55">Mode</span>
                    <span className="text-foreground/75">Read-only tools only</span>
                </div>

                {qrSrc && (
                    <div className="grid gap-2 rounded-xl border border-border/70 bg-background/70 p-3">
                        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
                            <QrCode className="size-3.5" />
                            Scan with WhatsApp
                        </div>
                        <div className="flex justify-center rounded-lg bg-white p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={qrSrc}
                                alt="WhatsApp QR code"
                                className="aspect-square w-full max-w-[240px]"
                            />
                        </div>
                        <p className="text-[12px] leading-relaxed text-foreground/55">
                            Open WhatsApp on your phone, go to Linked devices, then scan this code.
                        </p>
                        {entry.qrExpiresAt && (
                            <p className="text-[11.5px] text-foreground/45">
                                QR refreshes automatically if it expires.
                            </p>
                        )}
                    </div>
                )}

                {!entry.configured && (
                    <InlineNotice
                        tone="error"
                        text={`Missing local browser: ${entry.missingConfig.join(", ")}.`}
                    />
                )}
                {entry.lastError && <InlineNotice tone="error" text={entry.lastError} />}

                <WhatsAppSetupGuide />

                <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                        size="sm"
                        onClick={onConnect}
                        disabled={!entry.configured || busy !== null}
                    >
                        {busy === "whatsapp-connect" ? <Loader2 className="size-3.5 animate-spin" /> : <Smartphone className="size-3.5" />}
                        {entry.connected || entry.sessionStored ? "Reconnect" : "Connect"}
                    </Button>
                    {(entry.connected || entry.sessionStored || entry.phase === "qr") && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onDisconnect}
                            disabled={busy !== null}
                            className="text-destructive hover:text-destructive"
                        >
                            {busy === "whatsapp-disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                            Disconnect
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

function HomeAssistantCard({
    entry,
    busy,
    onSaveConfig,
    onUpdateActionMode,
    onDisconnect,
}: {
    entry: HomeAssistantIntegrationStatusEntry
    busy: BusyAction
    onSaveConfig: (input: HomeAssistantConfigInput) => Promise<boolean>
    onUpdateActionMode: (enabled: boolean) => Promise<boolean>
    onDisconnect: () => void
}) {
    const connected = entry.connected && !entry.needsReconnect
    const badge = !entry.configured
        ? <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Config needed</Badge>
        : connected
            ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Connected</Badge>
            : <Badge tone="warn" icon={<AlertCircle className="size-3" />}>Unreachable</Badge>

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10">
                            <House className="size-4 text-sky-700 dark:text-sky-400" />
                        </span>
                        <CardTitle className="truncate">{entry.name}</CardTitle>
                    </div>
                    {badge}
                </div>
                <CardDescription>{entry.description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
                    <span className="text-foreground/55">Instance</span>
                    {entry.baseUrl ? (
                        <CopyableCode value={entry.baseUrl} openable />
                    ) : (
                        <span className="truncate text-foreground/85">Not configured</span>
                    )}
                    <span className="text-foreground/55">Version</span>
                    <span className="truncate text-foreground/75">
                        {entry.version ?? (entry.configured ? "Not verified" : "Not configured")}
                    </span>
                    <span className="text-foreground/55">Location</span>
                    <span className="truncate text-foreground/75">
                        {[entry.locationName, entry.timeZone].filter(Boolean).join(" | ") || "Not verified"}
                    </span>
                    <span className="text-foreground/55">Inventory</span>
                    <span className="text-foreground/75">
                        {entry.entityCount === null ? "Not read yet" : `${entry.entityCount} entities`}
                        {entry.serviceDomainCount !== null ? ` | ${entry.serviceDomainCount} service domains` : ""}
                    </span>
                    <span className="text-foreground/55">Mode</span>
                    <span className="text-foreground/75">
                        {entry.actionMode.enabled ? "Read + action mode" : "Read-only API tools"}
                    </span>
                </div>

                {entry.error && <InlineNotice tone="error" text={entry.error} />}

                <HomeAssistantConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
                <HomeAssistantActionModePanel entry={entry} busy={busy} onUpdate={onUpdateActionMode} />
                <HomeAssistantSetupGuide />

                {entry.configured && (
                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onDisconnect}
                            disabled={busy !== null}
                            className="text-destructive hover:text-destructive"
                        >
                            {busy === "homeassistant-disconnect" ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                            Forget config
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function GmailSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Gmail OAuth setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>Choose or create the Google Cloud project in <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.</li>
                    <li>Enable <GuideLink href={ENABLE_GMAIL_API_URL}>Gmail API</GuideLink> in APIs &amp; Services.</li>
                    <li>Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for External testing, add your email in <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.</li>
                    <li>Create a <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.</li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect and approve Google consent.</p>
            </div>
        </details>
    )
}

function GoogleCalendarSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Google Calendar setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>Choose or create the Google Cloud project in <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.</li>
                    <li>Enable <GuideLink href={ENABLE_CALENDAR_API_URL}>Google Calendar API</GuideLink> in APIs &amp; Services.</li>
                    <li>Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for External testing, add your email in <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.</li>
                    <li>Create or reuse a <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.</li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect. Calendar changes sync with iOS only when saved on the Google calendar.</p>
            </div>
        </details>
    )
}

function GoogleWorkspaceSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Google Workspace setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>Choose or create the Google Cloud project in <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.</li>
                    <li>Enable APIs in APIs &amp; Services: <GuideLink href={ENABLE_DRIVE_API_URL}>Drive</GuideLink>, <GuideLink href={ENABLE_DOCS_API_URL}>Docs</GuideLink>, <GuideLink href={ENABLE_SHEETS_API_URL}>Sheets</GuideLink>, <GuideLink href={ENABLE_SLIDES_API_URL}>Slides</GuideLink>, and <GuideLink href={ENABLE_PEOPLE_API_URL}>People</GuideLink>.</li>
                    <li>Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for External testing, add your email in <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.</li>
                    <li>Create or reuse a <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.</li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect and approve Google consent.</p>
            </div>
        </details>
    )
}

function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground/75 underline underline-offset-2 hover:text-foreground"
        >
            {children}
            <ExternalLink className="size-3" />
        </a>
    )
}

function OAuthRedirectNote({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    const parsed = parseUrl(redirectUri)
    const isLoopback = parsed ? isLoopbackHostname(parsed.hostname) : false
    const tunnel = buildTunnelHelp(redirectUri, runtime)
    const hostCandidates = runtime?.sshHostCandidates.length
        ? ` Detected SSH host candidates: ${runtime.sshHostCandidates.slice(0, 3).join(", ")}.`
        : ""

    if (isLoopback) {
        return (
            <p>
                This localhost callback works directly when Orchestrator is running on the same machine as this browser. If Orchestrator is on a different headless server, run <code className="rounded bg-muted px-1 py-0.5 font-mono">{tunnel.command}</code>, keep that terminal open until this card says Connected, browse to <code className="rounded bg-muted px-1 py-0.5 font-mono">{tunnel.openUrl}</code>, then stop the tunnel with <code className="rounded bg-muted px-1 py-0.5 font-mono">Ctrl+C</code>.{hostCandidates} For no tunnel, use a real HTTPS domain and put that exact callback in the redirect URI field.
            </p>
        )
    }

    return (
        <p>
            Google accepts localhost redirects for local/tunneled setup, or HTTPS redirects on a real public domain. LAN names like <code className="rounded bg-muted px-1 py-0.5 font-mono">.lan</code>, <code className="rounded bg-muted px-1 py-0.5 font-mono">.local</code>, and private IPs are fine for opening Orchestrator, but not as Google OAuth redirect URIs.
        </p>
    )
}

function HomeAssistantSetupGuide() {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Home Assistant setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <p>In Home Assistant, open your profile, scroll to Long-lived access tokens, then create a token for Orchestrator.</p>
                <p>Paste the instance URL and token here. Typical local URLs are http://homeassistant.local:8123 or http://&lt;ip&gt;:8123.</p>
                <p>Orchestrator stores the token locally and exposes read tools for states, history, logbook, cameras, registries, automations, scripts, scenes, templates, and config checks.</p>
                <p>Action mode allows direct light, cover, climate, and notify service calls. Every other Home Assistant service requires explicit confirmation in chat.</p>
            </div>
        </details>
    )
}

function HomeAssistantActionModePanel({
    entry,
    busy,
    onUpdate,
}: {
    entry: HomeAssistantIntegrationStatusEntry
    busy: BusyAction
    onUpdate: (enabled: boolean) => Promise<boolean>
}) {
    const enabled = entry.actionMode.enabled
    return (
        <div
            className={cn(
                "rounded-xl border px-3 py-3 text-[12px]",
                enabled
                    ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
                    : "border-border/70 bg-background/60 text-foreground/65"
            )}
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="size-3.5 text-foreground/55" />
                        <span className="font-medium text-foreground/75">Action mode</span>
                        <Badge tone={enabled ? "success" : "muted"} icon={enabled ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}>
                            {enabled ? "Enabled" : "Disabled"}
                        </Badge>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-foreground/55">
                        Direct: {entry.actionMode.directDomains.join(", ")}. Other service domains require explicit confirmation.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant={enabled ? "outline" : "default"}
                    onClick={() => void onUpdate(!enabled)}
                    disabled={!entry.connected || busy !== null}
                >
                    {busy === "homeassistant-action-mode" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                    {enabled ? "Disable" : "Enable"}
                </Button>
            </div>
        </div>
    )
}

function WhatsAppSetupGuide() {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: WhatsApp setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <p>Use Connect to start a local WhatsApp Web session. A QR code appears in this card.</p>
                <p>On your phone, open WhatsApp, go to Settings or Menu, choose Linked devices, then Link a device.</p>
                <p>Scan the QR code. Orchestrator stores the browser session locally and exposes read-only chat tools to the main agent.</p>
                <p>This uses your own WhatsApp Web session. No send, delete, archive, or mark-read tool is enabled.</p>
            </div>
        </details>
    )
}

function HomeAssistantConfigForm({
    entry,
    busy,
    onSave,
}: {
    entry: HomeAssistantIntegrationStatusEntry
    busy: BusyAction
    onSave: (input: HomeAssistantConfigInput) => Promise<boolean>
}) {
    const [rawEnv, setRawEnv] = React.useState("")
    const [baseUrl, setBaseUrl] = React.useState(entry.baseUrl ?? "")
    const [token, setToken] = React.useState("")
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
        setBaseUrl(entry.baseUrl ?? "")
    }, [entry.baseUrl, entry.configured])

    const save = async () => {
        const ok = await onSave({
            rawEnv,
            baseUrl,
            token,
        })
        if (!ok) return
        setRawEnv("")
        setToken("")
        setOpen(false)
    }

    if (!open) {
        const label = entry.configured ? "API credentials stored locally" : "Home Assistant API credentials"
        return (
            <div
                className={cn(
                    "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-[12px]",
                    entry.configured
                        ? "border-border/70 bg-background/60 text-foreground/65"
                        : "border-sky-500/25 bg-sky-500/5 text-sky-900 dark:text-sky-200"
                )}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <KeyRound className="size-3.5 text-foreground/45" />
                    <span className="font-medium text-foreground/75">{label}</span>
                    {!entry.configured && (
                        <span className="whitespace-nowrap rounded-full bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
                            Not configured
                        </span>
                    )}
                </div>
                <Button
                    size="sm"
                    variant={entry.configured ? "outline" : "default"}
                    onClick={() => setOpen(true)}
                    disabled={busy !== null}
                >
                    <Plus className="size-3.5" />
                    {entry.configured ? "Edit config" : "Add config"}
                </Button>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-3 py-3 text-[12px] text-sky-900 dark:text-sky-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <KeyRound className="size-3.5 text-foreground/50" />
                    <span className="font-medium text-foreground/75">Home Assistant API credentials</span>
                    {!entry.configured && (
                        <span className="whitespace-nowrap rounded-full bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
                            Not configured
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "homeassistant-save" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        Save & verify
                    </Button>
                </div>
            </div>

            <div className="mt-3 grid gap-2">
                <label className="grid gap-1">
                    <span className="font-medium text-foreground/70">Paste .env lines</span>
                    <textarea
                        value={rawEnv}
                        onChange={event => setRawEnv(event.target.value)}
                        placeholder={"HOME_ASSISTANT_URL=http://homeassistant.local:8123\nHOME_ASSISTANT_TOKEN=..."}
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput label="Instance URL" value={baseUrl} onChange={setBaseUrl} placeholder="http://homeassistant.local:8123" />
                    <ConfigInput
                        label="Long-lived access token"
                        value={token}
                        onChange={setToken}
                        placeholder={entry.configured ? "Stored token unchanged if left blank" : "Paste token"}
                        type="password"
                    />
                </div>
            </div>
        </div>
    )
}

function GmailConfigForm({
    entry,
    busy,
    onSave,
}: {
    entry: GmailIntegrationStatusEntry
    busy: BusyAction
    onSave: (input: GmailConfigInput) => Promise<boolean>
}) {
    const [rawEnv, setRawEnv] = React.useState("")
    const [clientId, setClientId] = React.useState("")
    const [clientSecret, setClientSecret] = React.useState("")
    const [redirectUri, setRedirectUri] = React.useState(entry.redirectUri)
    const [fileFeedback, setFileFeedback] = React.useState<{ ok: boolean; text: string } | null>(null)
    const [open, setOpen] = React.useState(false)
    const fileInputRef = React.useRef<HTMLInputElement | null>(null)

    React.useEffect(() => setRedirectUri(entry.redirectUri), [entry.redirectUri])

    const save = async () => {
        const ok = await onSave({
            rawEnv,
            clientId,
            clientSecret,
            redirectUri: redirectUri === entry.redirectUri ? undefined : redirectUri,
        })
        if (!ok) return
        setRawEnv("")
        setClientId("")
        setClientSecret("")
        setFileFeedback(null)
        setOpen(false)
    }

    const uploadGoogleJson = async (file: File | undefined) => {
        if (!file) return
        try {
            const text = await file.text()
            const parsed = parseGoogleOAuthClientJson(text)
            if (!parsed.clientId || !parsed.clientSecret) {
                throw new Error("Could not find client_id and client_secret in this Google JSON file.")
            }
            setClientId(parsed.clientId)
            setClientSecret(parsed.clientSecret)
            setRedirectUri(parsed.redirectUri || entry.redirectUri)
            setRawEnv("")
            setFileFeedback({
                ok: true,
                text: parsed.redirectUri && parsed.redirectUri !== entry.redirectUri
                    ? "Loaded Google OAuth JSON. Check that the redirect URI matches this app before saving."
                    : "Loaded Google OAuth JSON. Review and save the config.",
            })
        } catch (err) {
            setFileFeedback({ ok: false, text: err instanceof Error ? err.message : "Could not read Google OAuth JSON." })
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    if (!open) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-900 dark:text-amber-200">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">OAuth credentials</span>
                    <span className="whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                        Not configured
                    </span>
                </div>
                <Button size="sm" onClick={() => setOpen(true)} disabled={busy !== null}>
                    <Plus className="size-3.5" />
                    Add config
                </Button>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-3 text-[12px] text-amber-900 dark:text-amber-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">OAuth credentials</span>
                    <span className="whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                        Not configured
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        Save config
                    </Button>
                </div>
            </div>

            <div className="mt-3 grid gap-2">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={event => void uploadGoogleJson(event.target.files?.[0])}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy !== null}
                    >
                        <Upload className="size-3.5" />
                        Upload Google JSON
                    </Button>
                    <span className="text-[11.5px] text-foreground/55">
                        Use the OAuth client JSON downloaded from Google Cloud.
                    </span>
                </div>
                {fileFeedback && <InlineNotice tone={fileFeedback.ok ? "success" : "error"} text={fileFeedback.text} />}

                <label className="grid gap-1">
                    <span className="font-medium text-foreground/70">Paste .env lines</span>
                    <textarea
                        value={rawEnv}
                        onChange={event => setRawEnv(event.target.value)}
                        placeholder={"GOOGLE_OAUTH_CLIENT_ID=...\nGOOGLE_OAUTH_CLIENT_SECRET=...\nGMAIL_OAUTH_REDIRECT_URI=..."}
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput label="Client ID" value={clientId} onChange={setClientId} placeholder="123.apps.googleusercontent.com" />
                    <ConfigInput label="Client secret" value={clientSecret} onChange={setClientSecret} placeholder="GOCSPX-..." type="password" />
                    <ConfigInput label="Redirect URI" value={redirectUri} onChange={setRedirectUri} placeholder={entry.redirectUri} />
                </div>
            </div>
        </div>
    )
}

function GoogleWorkspaceConfigForm({
    entry,
    busy,
    onSave,
}: {
    entry: GoogleCalendarIntegrationStatusEntry | GoogleDriveIntegrationStatusEntry
    busy: BusyAction
    onSave: (input: GoogleWorkspaceConfigInput) => Promise<boolean>
}) {
    const [rawEnv, setRawEnv] = React.useState("")
    const [clientId, setClientId] = React.useState("")
    const [clientSecret, setClientSecret] = React.useState("")
    const [redirectUri, setRedirectUri] = React.useState(entry.redirectUri)
    const [fileFeedback, setFileFeedback] = React.useState<{ ok: boolean; text: string } | null>(null)
    const [open, setOpen] = React.useState(false)
    const fileInputRef = React.useRef<HTMLInputElement | null>(null)

    React.useEffect(() => setRedirectUri(entry.redirectUri), [entry.redirectUri])

    const save = async () => {
        const ok = await onSave({
            rawEnv,
            clientId,
            clientSecret,
            redirectUri: redirectUri === entry.redirectUri ? undefined : redirectUri,
        })
        if (!ok) return
        setRawEnv("")
        setClientId("")
        setClientSecret("")
        setFileFeedback(null)
        setOpen(false)
    }

    const uploadGoogleJson = async (file: File | undefined) => {
        if (!file) return
        try {
            const text = await file.text()
            const parsed = parseGoogleOAuthClientJson(text)
            if (!parsed.clientId || !parsed.clientSecret) {
                throw new Error("Could not find client_id and client_secret in this Google JSON file.")
            }
            setClientId(parsed.clientId)
            setClientSecret(parsed.clientSecret)
            setRedirectUri(parsed.redirectUri || entry.redirectUri)
            setRawEnv("")
            setFileFeedback({
                ok: true,
                text: parsed.redirectUri && parsed.redirectUri !== entry.redirectUri
                    ? "Loaded Google OAuth JSON. Check that the redirect URI matches this app before saving."
                    : "Loaded Google OAuth JSON. Review and save the config.",
            })
        } catch (err) {
            setFileFeedback({ ok: false, text: err instanceof Error ? err.message : "Could not read Google OAuth JSON." })
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    if (!open) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-500/25 bg-blue-500/5 px-3 py-2.5 text-[12px] text-blue-900 dark:text-blue-200">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">Google Workspace OAuth credentials</span>
                    <span className="whitespace-nowrap rounded-full bg-blue-500/10 px-2 py-0.5 text-[10.5px] font-medium text-blue-700 dark:text-blue-300">
                        Not configured
                    </span>
                </div>
                <Button size="sm" onClick={() => setOpen(true)} disabled={busy !== null}>
                    <Plus className="size-3.5" />
                    Add config
                </Button>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-blue-500/25 bg-blue-500/5 px-3 py-3 text-[12px] text-blue-900 dark:text-blue-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">Google Workspace OAuth credentials</span>
                    <span className="whitespace-nowrap rounded-full bg-blue-500/10 px-2 py-0.5 text-[10.5px] font-medium text-blue-700 dark:text-blue-300">
                        Not configured
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "google-calendar-save" || busy === "google-drive-save" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        Save config
                    </Button>
                </div>
            </div>

            <div className="mt-3 grid gap-2">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={event => void uploadGoogleJson(event.target.files?.[0])}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy !== null}
                    >
                        <Upload className="size-3.5" />
                        Upload Google JSON
                    </Button>
                    <span className="text-[11.5px] text-foreground/55">
                        Use the OAuth client JSON downloaded from Google Cloud.
                    </span>
                </div>
                {fileFeedback && <InlineNotice tone={fileFeedback.ok ? "success" : "error"} text={fileFeedback.text} />}

                <label className="grid gap-1">
                    <span className="font-medium text-foreground/70">Paste .env lines</span>
                    <textarea
                        value={rawEnv}
                        onChange={event => setRawEnv(event.target.value)}
                        placeholder={"GOOGLE_OAUTH_CLIENT_ID=...\nGOOGLE_OAUTH_CLIENT_SECRET=...\nGOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=..."}
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput label="Client ID" value={clientId} onChange={setClientId} placeholder="123.apps.googleusercontent.com" />
                    <ConfigInput label="Client secret" value={clientSecret} onChange={setClientSecret} placeholder="GOCSPX-..." type="password" />
                    <ConfigInput label="Redirect URI" value={redirectUri} onChange={setRedirectUri} placeholder={entry.redirectUri} />
                </div>
            </div>
        </div>
    )
}

function ConfigInput({
    label,
    value,
    onChange,
    placeholder,
    type = "text",
}: {
    label: string
    value: string
    onChange: (value: string) => void
    placeholder?: string
    type?: "text" | "password"
}) {
    return (
        <label className="grid gap-1">
            <span className="text-[11.5px] font-medium text-foreground/60">{label}</span>
            <input
                type={type}
                value={value}
                onChange={event => onChange(event.target.value)}
                placeholder={placeholder}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring"
            />
        </label>
    )
}

function CopyableCode({ value, openable = false }: { value: string; openable?: boolean }) {
    const [copied, setCopied] = React.useState(false)
    const copy = async () => {
        if (!await copyTextToClipboard(value)) return
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
    }

    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <button
                type="button"
                onClick={copy}
                className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[11.5px] text-foreground/80 transition-colors hover:bg-muted/80"
                title={copied ? "Copied" : "Click to copy"}
            >
                {value}
            </button>
            <button
                type="button"
                onClick={copy}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
                title={copied ? "Copied" : "Copy redirect URI"}
            >
                <Clipboard className="size-3.5" />
            </button>
            {openable && (
                <button
                    type="button"
                    onClick={() => window.open(value, "_blank", "noopener,noreferrer")}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
                    title="Open URI"
                >
                    <ExternalLink className="size-3.5" />
                </button>
            )}
        </span>
    )
}

function InlineNotice({ tone, text }: { tone: NoticeTone; text: string }) {
    const success = tone === "success"
    const warning = tone === "warning"
    return (
        <div
            className={cn(
                "flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px]",
                success
                    ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : warning
                    ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
            )}
        >
            {success ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 size-3.5 shrink-0" />}
            <p>{text}</p>
        </div>
    )
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
        <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium", cls)}>
            {icon}
            {children}
        </span>
    )
}

function scopeLabel(scope: string): string {
    if (scope === 'https://mail.google.com/') return "Full mailbox"
    if (scope.endsWith('/gmail.readonly')) return "Read"
    if (scope.endsWith('/gmail.compose')) return "Draft"
    if (scope.endsWith('/gmail.modify')) return "Modify"
    if (scope.endsWith('/gmail.send')) return "Send"
    return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function calendarScopeGranted(grantedScopes: string[], requestedScope: string): boolean {
    return grantedScopes.includes(requestedScope)
        || (requestedScope.includes("/auth/calendar.") && grantedScopes.includes("https://www.googleapis.com/auth/calendar"))
}

function calendarScopeLabel(scope: string): string {
    if (scope.endsWith("/calendar.calendarlist.readonly")) return "Calendars"
    if (scope.endsWith("/calendar.events")) return "Events"
    if (scope.endsWith("/calendar.freebusy")) return "Free/busy"
    if (scope.endsWith("/calendar.settings.readonly")) return "Settings"
    if (scope === "https://www.googleapis.com/auth/calendar") return "Full calendar"
    return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function driveScopeGranted(grantedScopes: string[], requestedScope: string): boolean {
    return grantedScopes.includes(requestedScope)
}

function driveScopeLabel(scope: string): string {
    if (scope.endsWith("/drive")) return "Full Drive"
    if (scope.endsWith("/documents")) return "Docs"
    if (scope.endsWith("/spreadsheets")) return "Sheets"
    if (scope.endsWith("/presentations")) return "Slides"
    if (scope.endsWith("/contacts")) return "Contacts"
    if (scope.endsWith("/contacts.other.readonly")) return "Other contacts"
    if (scope.endsWith("/drive.readonly")) return "Read"
    if (scope.endsWith("/drive.file")) return "App files"
    if (scope.endsWith("/drive.metadata.readonly")) return "Metadata"
    return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function formatDriveStorage(storage: GoogleDriveIntegrationStatusEntry["storageQuota"]): string {
    if (!storage?.usage) return "Not verified"
    const usage = formatByteString(storage.usage)
    const limit = storage.limit ? formatByteString(storage.limit) : "unlimited"
    return `${usage} of ${limit}`
}

function formatByteString(value: string): string {
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes < 0) return value
    const units = ["B", "KB", "MB", "GB", "TB", "PB"]
    let current = bytes
    let unit = 0
    while (current >= 1024 && unit < units.length - 1) {
        current /= 1024
        unit += 1
    }
    const formatted = current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)
    return `${formatted} ${units[unit]}`
}

function formatExpiry(expiresAt: number): string {
    if (expiresAt <= Date.now()) return "Expired"
    return `Expires ${new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(expiresAt))}`
}

function shortPath(value: string): string {
    const parts = value.split("/")
    if (parts.length <= 3) return value
    return `${parts[0] || "/" + parts[1]}/.../${parts.slice(-2).join("/")}`
}

function parseGoogleOAuthClientJson(raw: string): { clientId: string; clientSecret: string; redirectUri: string } {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const block = getOAuthClientBlock(parsed)
    return {
        clientId: stringField(block, "client_id"),
        clientSecret: stringField(block, "client_secret"),
        redirectUri: firstStringArrayItem(block, "redirect_uris"),
    }
}

function getOAuthClientBlock(parsed: Record<string, unknown>): Record<string, unknown> {
    const web = parsed.web
    if (web && typeof web === "object" && !Array.isArray(web)) return web as Record<string, unknown>
    const installed = parsed.installed
    if (installed && typeof installed === "object" && !Array.isArray(installed)) return installed as Record<string, unknown>
    return parsed
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === "string" ? value : ""
}

function firstStringArrayItem(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    if (!Array.isArray(value)) return ""
    const first = value.find(item => typeof item === "string")
    return typeof first === "string" ? first : ""
}
