"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    House,
    KeyRound,
    Loader2,
    Plus,
    Save,
    ShieldCheck,
    Unplug,
} from "lucide-react"

import {
    Badge,
    ConfigInput,
    CopyableCode,
    InlineNotice,
} from "@/components/settings/auth-shared"
import { HomeAssistantLocationSourcePanel } from "@/components/settings/auth-home-assistant-location"
import type {
    BusyAction,
    HomeAssistantConfigInput,
} from "@/components/settings/auth-types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { HomeAssistantIntegrationStatusEntry } from "@/components/settings/use-integrations-status"
import { cn } from "@/lib/utils"

export function HomeAssistantCard({
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
    const badge = !entry.configured ? (
        <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
            Config needed
        </Badge>
    ) : connected ? (
        <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
            Connected
        </Badge>
    ) : (
        <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
            Unreachable
        </Badge>
    )

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
                    <span className="text-foreground/55">Connection</span>
                    <span className="truncate text-foreground/75">
                        {entry.connection
                            ? `${entry.connection.displayName} (${entry.connection.source === "owned" ? "own" : `shared by ${entry.connection.ownerName}`}, ${accessLabel(entry.connection.access)})`
                            : "No profile connection"}
                    </span>
                </div>

                {entry.error && <InlineNotice tone="error" text={entry.error} />}

                <HomeAssistantConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
                <HomeAssistantActionModePanel entry={entry} busy={busy} onUpdate={onUpdateActionMode} />
                <HomeAssistantLocationSourcePanel entry={entry} />
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
                            {busy === "homeassistant-disconnect" ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                <Unplug className="size-3.5" />
                            )}
                            Forget config
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function accessLabel(access: "read" | "write" | "setup"): string {
    if (access === "setup") return "manage"
    if (access === "write") return "read + control"
    return "read"
}

function HomeAssistantSetupGuide() {
    return (
        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
                <span>Mini tutorial: Home Assistant setup</span>
                <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
                <p>
                    In Home Assistant, open your profile, scroll to Long-lived access tokens, then create a token for
                    Orchestrator.
                </p>
                <p>
                    Paste the instance URL and token here. Typical local URLs are http://homeassistant.local:8123 or
                    http://&lt;ip&gt;:8123.
                </p>
                <p>
                    Orchestrator stores the token locally and exposes read tools for states, history, logbook, cameras,
                    registries, automations, scripts, scenes, templates, and config checks.
                </p>
                <p>
                    After the API verifies, Orchestrator can infer and save the `person.*` or `device_tracker.*` entity
                    that represents your live location. If it is unclear, choose it here.
                </p>
                <p>
                    Action mode allows direct light, cover, climate, and notify service calls. Every other Home
                    Assistant service requires explicit confirmation in chat.
                </p>
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
                        <Badge
                            tone={enabled ? "success" : "muted"}
                            icon={enabled ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}
                        >
                            {enabled ? "Enabled" : "Disabled"}
                        </Badge>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-foreground/55">
                        Direct: {entry.actionMode.directDomains.join(", ")}. Other service domains require explicit
                        confirmation.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant={enabled ? "outline" : "default"}
                    onClick={() => void onUpdate(!enabled)}
                    disabled={!entry.connected || busy !== null}
                >
                    {busy === "homeassistant-action-mode" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <ShieldCheck className="size-3.5" />
                    )}
                    {enabled ? "Disable" : "Enable"}
                </Button>
            </div>
        </div>
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
                        <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-sky-700 dark:text-sky-300">
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
                        <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-sky-700 dark:text-sky-300">
                            Not configured
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
                        Hide
                    </Button>
                    <Button size="sm" onClick={save} disabled={busy !== null}>
                        {busy === "homeassistant-save" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            <Save className="size-3.5" />
                        )}
                        Save & verify
                    </Button>
                </div>
            </div>

            <div className="mt-3 grid gap-2">
                <label className="grid gap-1">
                    <span className="font-medium text-foreground/70">Paste .env lines</span>
                    <textarea
                        value={rawEnv}
                        onChange={(event) => setRawEnv(event.target.value)}
                        placeholder={"HOME_ASSISTANT_URL=http://homeassistant.local:8123\nHOME_ASSISTANT_TOKEN=..."}
                        className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
                    />
                </label>

                <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
                    <p className="text-[12px] font-medium text-foreground/70">Or type values directly</p>
                    <ConfigInput
                        label="Instance URL"
                        value={baseUrl}
                        onChange={setBaseUrl}
                        placeholder="http://homeassistant.local:8123"
                    />
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
