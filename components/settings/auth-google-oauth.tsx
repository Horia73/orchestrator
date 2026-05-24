"use client"

import * as React from "react"
import { ChevronDown, Loader2, Plus, Save, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  ConfigInput,
  CopyableCode,
  GuideLink,
  InlineNotice,
} from "@/components/settings/auth-shared"
import type {
  GmailIntegrationStatusEntry,
  GoogleCalendarIntegrationStatusEntry,
  GoogleDriveIntegrationStatusEntry,
  RuntimeAccessInfo,
} from "@/components/settings/use-integrations-status"
import type {
  BusyAction,
  GmailConfigInput,
  GoogleWorkspaceConfigInput,
  NoticeTone,
} from "@/components/settings/auth-types"

export function shouldWarnAboutLocalhostRedirect(redirectUri: string): boolean {
    if (typeof window === "undefined") return false
    const redirectUrl = parseUrl(redirectUri)
    if (!redirectUrl || !isLoopbackHostname(redirectUrl.hostname)) return false
    return !isLoopbackHostname(window.location.hostname)
}

export function localhostRedirectNotice(redirectUri: string, runtime?: RuntimeAccessInfo): { tone: NoticeTone; text: string } {
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
    const host = hostname
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase()
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "::1" ||
        host === "0:0:0:0:0:0:0:1" ||
        /^127(?:\.\d{1,3}){3}$/.test(host)
    )
}

function buildTunnelHelp(redirectUri: string, runtime?: RuntimeAccessInfo): { command: string; openUrl: string } {
    const redirectUrl = parseUrl(redirectUri)
    const localPort = redirectUrl?.port || runtime?.tunnel.localPort || "3000"
    const remotePort = runtime?.tunnel.remotePort || "3000"
    const currentHost = typeof window === "undefined" ? "" : window.location.hostname
    const host =
        runtime?.sshHostCandidates[0] ||
        (currentHost && !isLoopbackHostname(currentHost) ? currentHost : "") ||
        "server"
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

export function GmailSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Gmail OAuth setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>
                        Choose or create the Google Cloud project in{" "}
                        <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.
                    </li>
                    <li>
                        Enable <GuideLink href={ENABLE_GMAIL_API_URL}>Gmail API</GuideLink> in APIs &amp; Services.
                    </li>
                    <li>
                        Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for
                        External testing, add your email in{" "}
                        <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.
                    </li>
                    <li>
                        Create a <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.
                    </li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>
                    Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect
                    and approve Google consent.
                </p>
            </div>
        </details>
    )
}

export function GoogleCalendarSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Google Calendar setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>
                        Choose or create the Google Cloud project in{" "}
                        <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.
                    </li>
                    <li>
                        Enable <GuideLink href={ENABLE_CALENDAR_API_URL}>Google Calendar API</GuideLink> in APIs &amp;
                        Services.
                    </li>
                    <li>
                        Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for
                        External testing, add your email in{" "}
                        <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.
                    </li>
                    <li>
                        Create or reuse a{" "}
                        <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.
                    </li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>
                    Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect.
                    Calendar changes sync with iOS only when saved on the Google calendar.
                </p>
            </div>
        </details>
    )
}

export function GoogleWorkspaceSetupGuide({ redirectUri, runtime }: { redirectUri: string; runtime?: RuntimeAccessInfo }) {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Google Workspace setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <ol className="grid list-decimal gap-1.5 pl-4">
                    <li>
                        Choose or create the Google Cloud project in{" "}
                        <GuideLink href={GOOGLE_PROJECTS_URL}>Google Cloud</GuideLink>.
                    </li>
                    <li>
                        Enable APIs in APIs &amp; Services: <GuideLink href={ENABLE_DRIVE_API_URL}>Drive</GuideLink>,{" "}
                        <GuideLink href={ENABLE_DOCS_API_URL}>Docs</GuideLink>,{" "}
                        <GuideLink href={ENABLE_SHEETS_API_URL}>Sheets</GuideLink>,{" "}
                        <GuideLink href={ENABLE_SLIDES_API_URL}>Slides</GuideLink>, and{" "}
                        <GuideLink href={ENABLE_PEOPLE_API_URL}>People</GuideLink>.
                    </li>
                    <li>
                        Configure <GuideLink href={GOOGLE_AUTH_BRANDING_URL}>Google Auth platform</GuideLink>; for
                        External testing, add your email in{" "}
                        <GuideLink href={GOOGLE_AUTH_AUDIENCE_URL}>Audience</GuideLink>.
                    </li>
                    <li>
                        Create or reuse a{" "}
                        <GuideLink href={GOOGLE_AUTH_CLIENTS_URL}>Web application OAuth client</GuideLink>.
                    </li>
                    <li>Add this exact authorized redirect URI:</li>
                </ol>
                <CopyableCode value={redirectUri} openable />
                <OAuthRedirectNote redirectUri={redirectUri} runtime={runtime} />
                <p>
                    Download the OAuth client JSON or copy the client ID and secret, save them here, then use Connect
                    and approve Google consent.
                </p>
            </div>
        </details>
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
                This localhost callback works directly when Orchestrator is running on the same machine as this browser.
                If Orchestrator is on a different headless server, run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">{tunnel.command}</code>, keep that terminal
                open until this card says Connected, browse to{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">{tunnel.openUrl}</code>, then stop the tunnel
                with <code className="rounded bg-muted px-1 py-0.5 font-mono">Ctrl+C</code>.{hostCandidates} For no
                tunnel, use a real HTTPS domain and put that exact callback in the redirect URI field.
            </p>
        )
    }

    return (
        <p>
            Google accepts localhost redirects for local/tunneled setup, or HTTPS redirects on a real public domain. LAN
            names like <code className="rounded bg-muted px-1 py-0.5 font-mono">.lan</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">.local</code>, and private IPs are fine for opening
            Orchestrator, but not as Google OAuth redirect URIs.
        </p>
    )
}

export function GmailConfigForm({
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
    const [fileFeedback, setFileFeedback] = React.useState<{
        ok: boolean
        text: string
    } | null>(null)
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
                text:
                    parsed.redirectUri && parsed.redirectUri !== entry.redirectUri
                        ? "Loaded Google OAuth JSON. Check that the redirect URI matches this app before saving."
                        : "Loaded Google OAuth JSON. Review and save the config.",
            })
        } catch (err) {
            setFileFeedback({
                ok: false,
                text: err instanceof Error ? err.message : "Could not read Google OAuth JSON.",
            })
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    if (!open) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[12px] text-amber-900 dark:text-amber-200">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">OAuth credentials</span>
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
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
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
                        Not configured
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "save" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            <Save className="size-3.5" />
                        )}
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
                        onChange={(event) => void uploadGoogleJson(event.target.files?.[0])}
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
                        onChange={(event) => setRawEnv(event.target.value)}
                        placeholder={
                            "GOOGLE_OAUTH_CLIENT_ID=...\nGOOGLE_OAUTH_CLIENT_SECRET=...\nGMAIL_OAUTH_REDIRECT_URI=..."
                        }
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput
                        label="Client ID"
                        value={clientId}
                        onChange={setClientId}
                        placeholder="123.apps.googleusercontent.com"
                    />
                    <ConfigInput
                        label="Client secret"
                        value={clientSecret}
                        onChange={setClientSecret}
                        placeholder="GOCSPX-..."
                        type="password"
                    />
                    <ConfigInput
                        label="Redirect URI"
                        value={redirectUri}
                        onChange={setRedirectUri}
                        placeholder={entry.redirectUri}
                    />
                </div>
            </div>
        </div>
    )
}

export function GoogleWorkspaceConfigForm({
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
    const [fileFeedback, setFileFeedback] = React.useState<{
        ok: boolean
        text: string
    } | null>(null)
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
                text:
                    parsed.redirectUri && parsed.redirectUri !== entry.redirectUri
                        ? "Loaded Google OAuth JSON. Check that the redirect URI matches this app before saving."
                        : "Loaded Google OAuth JSON. Review and save the config.",
            })
        } catch (err) {
            setFileFeedback({
                ok: false,
                text: err instanceof Error ? err.message : "Could not read Google OAuth JSON.",
            })
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = ""
        }
    }

    if (!open) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-500/25 bg-blue-500/5 px-3 py-2.5 text-[12px] text-blue-900 dark:text-blue-200">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-foreground/75">Google Workspace OAuth credentials</span>
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-blue-700 dark:text-blue-300">
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
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-blue-700 dark:text-blue-300">
                        Not configured
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "google-calendar-save" || busy === "google-drive-save" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            <Save className="size-3.5" />
                        )}
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
                        onChange={(event) => void uploadGoogleJson(event.target.files?.[0])}
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
                        onChange={(event) => setRawEnv(event.target.value)}
                        placeholder={
                            "GOOGLE_OAUTH_CLIENT_ID=...\nGOOGLE_OAUTH_CLIENT_SECRET=...\nGOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=..."
                        }
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput
                        label="Client ID"
                        value={clientId}
                        onChange={setClientId}
                        placeholder="123.apps.googleusercontent.com"
                    />
                    <ConfigInput
                        label="Client secret"
                        value={clientSecret}
                        onChange={setClientSecret}
                        placeholder="GOCSPX-..."
                        type="password"
                    />
                    <ConfigInput
                        label="Redirect URI"
                        value={redirectUri}
                        onChange={setRedirectUri}
                        placeholder={entry.redirectUri}
                    />
                </div>
            </div>
        </div>
    )
}

function parseGoogleOAuthClientJson(raw: string): {
    clientId: string
    clientSecret: string
    redirectUri: string
} {
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
    if (installed && typeof installed === "object" && !Array.isArray(installed))
        return installed as Record<string, unknown>
    return parsed
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === "string" ? value : ""
}

function firstStringArrayItem(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    if (!Array.isArray(value)) return ""
    const first = value.find((item) => typeof item === "string")
    return typeof first === "string" ? first : ""
}
