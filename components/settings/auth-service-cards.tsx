"use client"

import * as React from "react"
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudSun,
  Database,
  FolderOpen,
  KeyRound,
  LocateFixed,
  LogIn,
  Loader2,
  Mail,
  MapPinned,
  MessageCircle,
  Network,
  Plus,
  QrCode,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Badge,
  ConfigInput,
  CopyableCode,
  GuideLink,
  InlineNotice,
} from "@/components/settings/auth-shared"
import {
  GmailConfigForm,
  GmailSetupGuide,
  GoogleCalendarSetupGuide,
  GoogleWorkspaceConfigForm,
  GoogleWorkspaceSetupGuide,
} from "@/components/settings/auth-google-oauth"
import type {
  BusyAction,
  GmailConfigInput,
  GoogleCalendarConfigInput,
  GoogleDriveConfigInput,
  GoogleMapsConfigInput,
  RemoteMcpConfigInput,
} from "@/components/settings/auth-types"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  calendarScopeGranted,
  calendarScopeLabel,
  driveScopeGranted,
  driveScopeLabel,
  formatByteString,
  formatDriveStorage,
  formatExpiry,
  formatStatusTimestamp,
  scopeLabel,
  shortPath,
  sourceTypeLabel,
} from "@/components/settings/auth-tab-helpers"
import type {
  GmailIntegrationStatusEntry,
  GoogleAccountConnectionStatusEntry,
  GoogleCalendarIntegrationStatusEntry,
  GoogleDriveIntegrationStatusEntry,
  LocationIntelligenceIntegrationStatusEntry,
  MapsIntegrationStatusEntry,
  RemoteMcpIntegrationStatusEntry,
  RuntimeAccessInfo,
  WeatherIntegrationStatusEntry,
  WhatsAppIntegrationStatusEntry,
} from "@/components/settings/use-integrations-status"

const GOOGLE_MAPS_PLATFORM_URL =
  "https://console.cloud.google.com/google/maps-apis"
const ENABLE_MAPS_JS_API_URL =
  "https://console.cloud.google.com/apis/library/maps-backend.googleapis.com"
const ENABLE_GEOCODING_API_URL =
  "https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com"
const ENABLE_PLACES_API_URL =
  "https://console.cloud.google.com/apis/library/places-backend.googleapis.com"
const ENABLE_ROUTES_API_URL =
  "https://console.cloud.google.com/apis/library/routes.googleapis.com"
const ENABLE_WEATHER_API_URL =
  "https://console.cloud.google.com/apis/library/weather.googleapis.com"
const ENABLE_AIR_QUALITY_API_URL =
  "https://console.cloud.google.com/apis/library/airquality.googleapis.com"
const ENABLE_POLLEN_API_URL =
  "https://console.cloud.google.com/apis/library/pollen.googleapis.com"
const GOOGLE_MAPS_MAP_IDS_URL =
  "https://console.cloud.google.com/google/maps-apis/studio/maps"
const GOOGLE_MAPS_VECTOR_DOCS_URL =
  "https://developers.google.com/maps/documentation/javascript/map-rendering-type"
const GOOGLE_MAPS_3D_DOCS_URL =
  "https://developers.google.com/maps/documentation/javascript/3d/overview"
const GOOGLE_MAPS_3D_COVERAGE_URL =
  "https://developers.google.com/maps/documentation/javascript/3d/coverage"

export function LocationIntelligenceCard({
  entry,
}: {
  entry: LocationIntelligenceIntegrationStatusEntry
}) {
  const badge = !entry.configured ? (
    <Badge tone="muted" icon={<LocateFixed className="size-3" />}>
      Optional
    </Badge>
  ) : !entry.enabled ? (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Disabled
    </Badge>
  ) : entry.connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Ready
    </Badge>
  ) : (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Needs setup
    </Badge>
  )

  const sourceLabel =
    entry.source.label ??
    entry.source.entityId ??
    sourceTypeLabel(entry.source.type)

  const startSetup = () => {
    try {
      window.localStorage.setItem("chat:draft:new", entry.setupPrompt)
      // Clear the restored conversation so home opens the "new" composer,
      // where the chat:draft:new prompt is shown (not the last chat).
      window.localStorage.removeItem("chat:active-id")
    } catch {
      // Navigation still opens chat; draft prefill is best-effort.
    }
    window.location.assign("/?new=1")
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
              <LocateFixed className="size-4 text-violet-700 dark:text-violet-400" />
            </span>
            <CardTitle className="truncate">Location Intelligence</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>
          Optional local Home Assistant location journal, raw observations,
          daily summaries, and Library Places views. Tracking is off until
          explicitly configured.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <LocateFixed className="size-3.5 text-foreground/50" />
              Source
            </div>
            <div className="grid gap-1.5 text-[12.5px]">
              <StatusRow
                label="Mode"
                value={sourceTypeLabel(entry.source.type)}
              />
              <StatusRow
                label="Entity"
                value={entry.source.entityId ?? "Not set"}
              />
              <StatusRow label="Label" value={sourceLabel} />
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <Database className="size-3.5 text-foreground/50" />
              Journal
            </div>
            <div className="grid gap-1.5 text-[12.5px]">
              <StatusRow
                label="Files"
                value={entry.journal.exists ? "Found" : "Not found"}
              />
              <StatusRow label="Days" value={String(entry.journal.dayCount)} />
              <StatusRow
                label="Latest"
                value={entry.journal.lastDate ?? "No days yet"}
              />
              <StatusRow
                label="Path"
                value={entry.journal.relativePath ?? "Not configured"}
              />
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <Clock3 className="size-3.5 text-foreground/50" />
              Policy
            </div>
            <div className="grid gap-1.5 text-[12.5px]">
              <StatusRow label="Retention" value={entry.retention.label} />
              <StatusRow label="Maps mode" value={entry.mapsMode} />
              <StatusRow
                label="Script"
                value={entry.journalScriptId ?? "Not set"}
              />
              <StatusRow label="Task" value={entry.dailyTaskId ?? "Not set"} />
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-[12.5px]">
            <div className="mb-2 font-medium text-foreground/75">
              Microscript
            </div>
            <div className="grid gap-1.5">
              <StatusRow
                label="Status"
                value={
                  entry.microscript
                    ? entry.microscript.exists
                      ? (entry.microscript.status ?? "Unknown")
                      : "Missing"
                    : "Not configured"
                }
              />
              <StatusRow
                label="Last run"
                value={formatStatusTimestamp(entry.microscript?.lastRunAt)}
              />
              <StatusRow
                label="Next run"
                value={formatStatusTimestamp(entry.microscript?.nextRunAt)}
              />
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-[12.5px]">
            <div className="mb-2 font-medium text-foreground/75">
              Daily intelligence task
            </div>
            <div className="grid gap-1.5">
              <StatusRow
                label="Status"
                value={
                  entry.dailyTask
                    ? entry.dailyTask.exists
                      ? (entry.dailyTask.status ?? "Unknown")
                      : "Missing"
                    : "Not configured"
                }
              />
              <StatusRow
                label="Last run"
                value={formatStatusTimestamp(entry.dailyTask?.lastRunAt)}
              />
              <StatusRow
                label="Next run"
                value={formatStatusTimestamp(entry.dailyTask?.nextRunAt)}
              />
            </div>
          </div>
        </div>

        {entry.error && <InlineNotice tone="warning" text={entry.error} />}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={entry.configured ? "outline" : "default"}
            onClick={startSetup}
          >
            <MessageCircle className="size-3.5" />
            Ask your assistant to set up Location Intelligence
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/library?tab=places">
              <MapPinned className="size-3.5" />
              Open Places
            </a>
          </Button>
        </div>

        <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
            <span>Setup guidance</span>
            <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
            <p>
              Location Intelligence needs explicit opt-in, a Home Assistant
              location source, a local journal microscript that preserves raw
              points, a daily scheduled summary task, retention choice, and Maps
              mode choice.
            </p>
            <p>
              Library Places can show summarized Places and raw observations;
              longer stops are inferred from gaps between webhook samples.
              Retention can be finite or &ldquo;keep everything&rdquo;. Setup
              stores only non-secret ids and preferences in local config;
              webhook or Home Assistant credentials belong in existing secret
              surfaces.
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

export function RemoteMcpCard({
  entry,
  busy,
  onSaveConfig,
  onStartOAuth,
  onDisconnect,
  onRemove,
  canManage,
}: {
  entry: RemoteMcpIntegrationStatusEntry
  busy: BusyAction
  onSaveConfig: (input: RemoteMcpConfigInput) => Promise<boolean>
  onStartOAuth: (serverId: string) => void
  onDisconnect: (serverId: string) => void
  onRemove: (serverId: string) => void
  canManage: boolean
}) {
  const [label, setLabel] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [authType, setAuthType] = React.useState<"oauth" | "none">("oauth")
  const [notes, setNotes] = React.useState("")
  const isBusy = busy !== null
  const badge = !entry.configured ? (
    <Badge tone="muted" icon={<Network className="size-3" />}>
      Optional
    </Badge>
  ) : entry.connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      {entry.connectedServerCount}/{entry.serverCount} ready
    </Badge>
  ) : (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Needs auth
    </Badge>
  )

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const saved = await onSaveConfig({
      label,
      url,
      authType,
      enabled: true,
      notes,
    })
    if (saved) {
      setLabel("")
      setUrl("")
      setNotes("")
      setAuthType("oauth")
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
              <Network className="size-4 text-indigo-700 dark:text-indigo-400" />
            </span>
            <CardTitle className="truncate">{entry.name}</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>{entry.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          {canManage && (
            <form
              onSubmit={submit}
              className="grid gap-3 rounded-xl border border-border/70 bg-background/60 p-3"
            >
              <div className="grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_160px]">
                <ConfigInput
                  label="Label"
                  value={label}
                  onChange={setLabel}
                  placeholder="Apollo, Linear, custom MCP"
                />
                <ConfigInput
                  label="MCP endpoint"
                  value={url}
                  onChange={setUrl}
                  placeholder="https://provider.example/mcp"
                />
                <label className="grid gap-1">
                  <span className="text-[11.5px] font-medium text-foreground/60">
                    Auth
                  </span>
                  <Select
                    value={authType}
                    options={[
                      { value: "oauth", label: "OAuth" },
                      { value: "none", label: "No auth" },
                    ]}
                    disabled={isBusy}
                    onValueChange={(value) =>
                      setAuthType(value === "none" ? "none" : "oauth")
                    }
                  />
                </label>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <ConfigInput
                  label="Notes"
                  value={notes}
                  onChange={setNotes}
                  placeholder="Optional non-secret provider limits or intended use"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={isBusy || !url.trim()}
                  className="md:mb-0.5"
                >
                  {busy === "mcp-save" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  Save server
                </Button>
              </div>
            </form>
          )}

          <div className="grid gap-2">
            {entry.servers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-3 py-8 text-center text-[13px] text-foreground/45">
                No remote MCP servers configured.
              </div>
            ) : (
              entry.servers.map((server) => (
                <div
                  key={server.id}
                  className="grid gap-3 rounded-xl border border-border/70 bg-background/60 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-foreground/80">
                          {server.label}
                        </span>
                        <Badge
                          tone={server.connected ? "success" : "warn"}
                          icon={
                            server.connected ? (
                              <CheckCircle2 className="size-3" />
                            ) : (
                              <AlertCircle className="size-3" />
                            )
                          }
                        >
                          {server.connected ? "Ready" : "Needs auth"}
                        </Badge>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11.5px] text-foreground/45">
                        {server.url}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {server.authType === "oauth" && !server.connected && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => onStartOAuth(server.id)}
                          >
                            {busy === "mcp-connect" ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <LogIn className="size-3.5" />
                            )}
                            Connect
                          </Button>
                        )}
                        {server.authType === "oauth" && server.connected && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => onDisconnect(server.id)}
                          >
                            <Unplug className="size-3.5" />
                            Disconnect
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => onRemove(server.id)}
                        >
                          <Trash2 className="size-3.5" />
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="grid gap-1.5 text-[12.5px] md:grid-cols-3">
                    <StatusRow
                      label="Auth"
                      value={server.authType === "oauth" ? "OAuth" : "No auth"}
                    />
                    <StatusRow
                      label="Tools"
                      value={
                        server.toolCount === null
                          ? "Not listed"
                          : String(server.toolCount)
                      }
                    />
                    <StatusRow
                      label="Checked"
                      value={formatStatusTimestamp(server.lastCheckedAt)}
                    />
                  </div>
                  {server.toolsPreview.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {server.toolsPreview.map((tool) => (
                        <span
                          key={tool}
                          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/60"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                  {server.error && (
                    <InlineNotice tone="warning" text={server.error} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
      <span className="text-foreground/55">{label}</span>
      <span className="truncate text-foreground/80" title={value}>
        {value}
      </span>
    </div>
  )
}

function GoogleAccountSelector({
  connections,
  selectedConnectionId,
  busy,
  onSelectConnection,
  canManage,
}: {
  connections: GoogleAccountConnectionStatusEntry[]
  selectedConnectionId: string
  busy: BusyAction
  onSelectConnection: (connectionId: string) => void
  canManage: boolean
}) {
  if (connections.length === 0) return null

  const selected = connections.find(
    (connection) => connection.id === selectedConnectionId
  )
  const selectedReady = Boolean(selected?.connected && !selected.needsReconnect)
  const options = connections.map((connection) => ({
    value: connection.id,
    label: googleConnectionLabel(connection),
  }))

  return (
    <div className="grid gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-[12.5px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-foreground/75">Default account</div>
          <div className="truncate text-[12px] text-foreground/50">
            {selected
              ? selected.source === "shared"
                ? `Shared by ${selected.ownerName}`
                : "Owned by this profile"
              : "Choose which local account this profile uses"}
          </div>
        </div>
        <Badge
          tone={selectedReady ? "success" : "warn"}
          icon={
            selectedReady ? (
              <CheckCircle2 className="size-3" />
            ) : (
              <AlertCircle className="size-3" />
            )
          }
        >
          {selectedReady ? "Ready" : "Reconnect"}
        </Badge>
      </div>
      <Select
        value={selectedConnectionId}
        options={options}
        disabled={!canManage || busy !== null || connections.length <= 1}
        placeholder="Choose account"
        onValueChange={(connectionId) => {
          if (connectionId && connectionId !== selectedConnectionId) {
            onSelectConnection(connectionId)
          }
        }}
      />
    </div>
  )
}

function googleConnectionLabel(
  connection: GoogleAccountConnectionStatusEntry
): string {
  const account = connection.accountEmail ?? connection.displayName
  const suffix = connection.source === "shared" ? ` · ${connection.ownerName}` : ""
  return `${account}${suffix}`
}

export function GmailCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
  onSelectConnection,
  canManage,
}: {
  entry: GmailIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GmailConfigInput) => Promise<boolean>
  onSelectConnection: (connectionId: string) => void
  canManage: boolean
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
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

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
          <span className="truncate text-foreground/85">
            {entry.accountEmail ?? "Not connected"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
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
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        <GoogleAccountSelector
          connections={entry.availableConnections}
          selectedConnectionId={entry.connection?.id ?? ""}
          busy={busy}
          onSelectConnection={onSelectConnection}
          canManage={canManage}
        />

        {!entry.configured && canManage && (
          <GmailConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
        )}
        <GmailSetupGuide redirectUri={entry.redirectUri} runtime={runtime} />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
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
              {busy === "disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function GoogleCalendarCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
  onSelectConnection,
  canManage,
}: {
  entry: GoogleCalendarIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GoogleCalendarConfigInput) => Promise<boolean>
  onSelectConnection: (connectionId: string) => void
  canManage: boolean
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
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

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
          <span className="truncate text-foreground/85">
            {entry.accountEmail ?? "Not connected"}
          </span>
          <span className="text-foreground/55">Primary</span>
          <span
            className="truncate text-foreground/75"
            title={entry.primaryCalendarId ?? undefined}
          >
            {entry.primaryCalendarSummary ||
              entry.primaryCalendarId ||
              "Not verified"}
          </span>
          <span className="text-foreground/55">Calendars</span>
          <span className="text-foreground/75">
            {entry.calendarCount === null
              ? "Not read yet"
              : `${entry.calendarCount} visible`}
            {entry.writableCalendarCount !== null
              ? ` | ${entry.writableCalendarCount} writable`
              : ""}
          </span>
          <span className="text-foreground/55">Timezone</span>
          <span className="truncate text-foreground/75">
            {entry.timeZone ?? "Not verified"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
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
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        <GoogleAccountSelector
          connections={entry.availableConnections}
          selectedConnectionId={entry.connection?.id ?? ""}
          busy={busy}
          onSelectConnection={onSelectConnection}
          canManage={canManage}
        />

        {!entry.configured && canManage && (
          <GoogleWorkspaceConfigForm
            entry={entry}
            busy={busy}
            onSave={onSaveConfig}
          />
        )}
        <GoogleCalendarSetupGuide
          redirectUri={entry.redirectUri}
          runtime={runtime}
        />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "google-calendar-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
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
              {busy === "google-calendar-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function GoogleWorkspaceCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
  onSelectConnection,
  canManage,
}: {
  entry: GoogleDriveIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GoogleDriveConfigInput) => Promise<boolean>
  onSelectConnection: (connectionId: string) => void
  canManage: boolean
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
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

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
            {entry.maxUploadSize
              ? formatByteString(entry.maxUploadSize)
              : "Not verified"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
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
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        <GoogleAccountSelector
          connections={entry.availableConnections}
          selectedConnectionId={entry.connection?.id ?? ""}
          busy={busy}
          onSelectConnection={onSelectConnection}
          canManage={canManage}
        />

        {!entry.configured && canManage && (
          <GoogleWorkspaceConfigForm
            entry={entry}
            busy={busy}
            onSave={onSaveConfig}
          />
        )}
        <GoogleWorkspaceSetupGuide
          redirectUri={entry.redirectUri}
          runtime={runtime}
        />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "google-drive-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
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
              {busy === "google-drive-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function WhatsAppCard({
  entry,
  busy,
  onConnect,
  onDisconnect,
  canManage,
}: {
  entry: WhatsAppIntegrationStatusEntry
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  canManage: boolean
}) {
  const connected = entry.connected && !entry.needsReconnect
  const providerLabel =
    entry.provider === "baileys"
      ? "Baileys"
      : entry.provider === "wwebjs"
        ? "Legacy browser"
        : "Disabled"
  const savedSessionIdle =
    entry.sessionStored &&
    !entry.needsReconnect &&
    !connected &&
    entry.phase !== "qr" &&
    entry.phase !== "starting" &&
    entry.phase !== "authenticated"
  const badge = entry.provider === "disabled" ? (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Disabled
    </Badge>
  ) : !entry.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Browser needed
    </Badge>
  ) : connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Connected
    </Badge>
  ) : entry.phase === "qr" ? (
    <Badge tone="warn" icon={<QrCode className="size-3" />}>
      Scan QR
    </Badge>
  ) : entry.phase === "starting" || entry.phase === "authenticated" ? (
    <Badge tone="warn" icon={<Loader2 className="size-3 animate-spin" />}>
      Linking
    </Badge>
  ) : entry.needsReconnect ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : savedSessionIdle ? (
    <Badge tone="warn" icon={<Smartphone className="size-3" />}>
      Session saved
    </Badge>
  ) : entry.phase === "error" || entry.phase === "auth_failure" ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

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
            {entry.accountName ||
              entry.phoneNumber ||
              (entry.sessionStored ? "Reconnect to verify" : "Not connected")}
          </span>
          <span className="text-foreground/55">Session</span>
          <span className="text-foreground/75">
            {connected
              ? "Running from local session"
              : entry.sessionStored && entry.needsReconnect
                ? "Stored locally; scan again to verify"
              : entry.sessionStored
                ? "Stored locally; reconnect to start"
                : "No local session"}
          </span>
          <span className="text-foreground/55">Provider</span>
          <span className="text-foreground/75">{providerLabel}</span>
          {entry.provider === "wwebjs" && (
            <>
              <span className="text-foreground/55">Browser</span>
              <span
                className="truncate text-foreground/75"
                title={entry.browserExecutablePath ?? undefined}
              >
                {entry.browserExecutablePath
                  ? shortPath(entry.browserExecutablePath)
                  : "Chrome/Chromium not found"}
              </span>
            </>
          )}
          <span className="text-foreground/55">Mode</span>
          <span className="text-foreground/75">
            Reads plus confirmed writes
          </span>
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
              Open WhatsApp on your phone, go to Linked devices, then scan this
              code.
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
            text={
              entry.provider === "disabled"
                ? "WhatsApp is disabled by WHATSAPP_PROVIDER=disabled."
                : `Missing local browser: ${entry.missingConfig.join(", ")}.`
            }
          />
        )}
        {entry.lastError && (
          <InlineNotice tone="error" text={entry.lastError} />
        )}

        <WhatsAppSetupGuide />

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "whatsapp-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Smartphone className="size-3.5" />
            )}
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
              {busy === "whatsapp-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function MapsWeatherCard({
  maps,
  weather,
  busy,
  onSaveConfig,
  canManage,
}: {
  maps: MapsIntegrationStatusEntry
  weather: WeatherIntegrationStatusEntry
  busy: BusyAction
  onSaveConfig: (input: GoogleMapsConfigInput) => Promise<boolean>
  canManage: boolean
}) {
  const mapsBadge = !maps.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Key needed
    </Badge>
  ) : maps.connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Maps ready
    </Badge>
  ) : (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      API issue
    </Badge>
  )

  const weatherBadge =
    weather.providerInUse === "google" ? (
      <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
        Google Weather
      </Badge>
    ) : weather.providerInUse === "open-meteo" ? (
      <Badge
        tone={weather.google.needsReconnect ? "warn" : "success"}
        icon={<CloudSun className="size-3" />}
      >
        Open-Meteo
      </Badge>
    ) : (
      <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
        Offline
      </Badge>
    )

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
              <MapPinned className="size-4 text-cyan-700 dark:text-cyan-400" />
            </span>
            <CardTitle className="truncate">Maps & Weather</CardTitle>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {mapsBadge}
            {weatherBadge}
          </div>
        </div>
        <CardDescription>
          One Google Maps Platform key powers Smart Maps, geocoding, places,
          routes, and optional Google weather upgrades.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <MapPinned className="size-3.5 text-foreground/50" />
              Google Maps Platform
            </div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
              <span className="text-foreground/55">API key</span>
              <span className="truncate text-foreground/85">
                {maps.configured ? "Stored locally" : "Missing"}
              </span>
              <span className="text-foreground/55">Geocoding</span>
              <span className="truncate text-foreground/75">
                {maps.connected
                  ? "Verified"
                  : maps.configured
                    ? "Not verified"
                    : "Needs key"}
              </span>
              <span className="text-foreground/55">Map ID</span>
              <span
                className={cn(
                  "truncate",
                  maps.mapIdConfigured
                    ? "text-foreground/75"
                    : "text-amber-700 dark:text-amber-300"
                )}
              >
                {maps.mapIdConfigured
                  ? maps.mapIdLabel
                  : "Demo ID - add vector Map ID"}
              </span>
              <span className="text-foreground/55">Earth 3D</span>
              <span className="text-foreground/75">
                {maps.earth3d.readyToTry
                  ? "Ready to try (beta)"
                  : "Needs Maps key"}
              </span>
              <span className="text-foreground/55">Map APIs</span>
              <span className="text-foreground/75">
                Maps JavaScript, Geocoding, Places, Routes
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <CloudSun className="size-3.5 text-foreground/50" />
              Weather providers
            </div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
              <span className="text-foreground/55">Active</span>
              <span className="truncate text-foreground/85">
                {weather.providerInUse === "google"
                  ? "Google Weather"
                  : weather.providerInUse === "open-meteo"
                    ? "Open-Meteo fallback"
                    : "Unavailable"}
              </span>
              <span className="text-foreground/55">Google</span>
              <span className="truncate text-foreground/75">
                {weather.google.connected
                  ? "Weather API verified"
                  : weather.google.configured
                    ? "Key stored; Weather API not verified"
                    : "Optional upgrade"}
              </span>
              <span className="text-foreground/55">Open-Meteo</span>
              <span className="text-foreground/75">
                {weather.openMeteo.available
                  ? "Keyless fallback for weather, AQ, pollen"
                  : "Unavailable"}
              </span>
            </div>
          </div>
        </div>

        <SmartMapsOnboardingPanel maps={maps} />
        {canManage && (
          <GoogleMapsKeyForm maps={maps} busy={busy} onSave={onSaveConfig} />
        )}
        <MapsWeatherSetupGuide />
        {maps.error && (
          <InlineNotice tone="error" text={`Maps: ${maps.error}`} />
        )}
        {weather.google.error && (
          <InlineNotice
            tone="warning"
            text={`Google Weather/Pollen setup: ${weather.google.error}`}
          />
        )}
        {weather.openMeteo.error && (
          <InlineNotice
            tone="warning"
            text={`Open-Meteo: ${weather.openMeteo.error}`}
          />
        )}
      </CardContent>
    </Card>
  )
}

export function SmartMapsOnboardingPanel({
  maps,
}: {
  maps: MapsIntegrationStatusEntry
}) {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5 text-[12px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold text-foreground/80">
              Smart Maps visual setup
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-foreground/45 transition-transform group-open:rotate-180" />
          </div>
          <p className="mt-0.5 line-clamp-2 max-w-3xl text-foreground/55">
            Maps stays the default. Add a custom Vector Map ID for reliable
            tilt/rotation; Earth 3D remains a beta mode where Google has
            photorealistic coverage.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Badge
            tone={maps.mapIdConfigured ? "success" : "warn"}
            icon={
              maps.mapIdConfigured ? (
                <CheckCircle2 className="size-3" />
              ) : (
                <AlertCircle className="size-3" />
              )
            }
          >
            {maps.mapIdConfigured ? "Vector Map ID" : "Needs Map ID"}
          </Badge>
          <Badge
            tone={maps.earth3d.readyToTry ? "success" : "muted"}
            icon={<MapPinned className="size-3" />}
          >
            Earth 3D beta
          </Badge>
        </div>
      </summary>

      <div className="mt-2 border-t border-border/60 pt-2">
        <ol className="grid list-decimal gap-2 pl-4 text-foreground/65 md:grid-cols-3 md:gap-3">
          <li>
            <span className="font-medium text-foreground/75">API key</span>
            <span className="mt-0.5 block">
              Enable{" "}
              <GuideLink href={ENABLE_MAPS_JS_API_URL}>
                Maps JavaScript
              </GuideLink>
              , <GuideLink href={ENABLE_GEOCODING_API_URL}>Geocoding</GuideLink>
              , Places, and Routes, then save one Google Maps Platform key.
            </span>
          </li>
          <li>
            <span className="font-medium text-foreground/75">
              Vector Map ID
            </span>
            <span className="mt-0.5 block">
              In{" "}
              <GuideLink href={GOOGLE_MAPS_MAP_IDS_URL}>
                Map Management
              </GuideLink>
              , create a JavaScript map ID, choose Vector, enable Tilt and
              Rotation, then save it as{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                GOOGLE_MAPS_MAP_ID
              </code>
              .
            </span>
          </li>
          <li>
            <span className="font-medium text-foreground/75">Earth 3D</span>
            <span className="mt-0.5 block">
              Earth mode uses{" "}
              <GuideLink href={GOOGLE_MAPS_3D_DOCS_URL}>3D Maps beta</GuideLink>
              . Check{" "}
              <GuideLink href={GOOGLE_MAPS_3D_COVERAGE_URL}>coverage</GuideLink>
              ; when coverage is weak, Smart Maps should fall back to normal
              Maps.
            </span>
          </li>
        </ol>

        <div className="mt-3 grid gap-1.5 border-t border-border/60 pt-2 text-foreground/55">
          <div>{maps.vectorMap.message}</div>
          <div>{maps.earth3d.message}</div>
          <GuideLink href={GOOGLE_MAPS_VECTOR_DOCS_URL}>
            Why Vector Map ID matters for tilt and heading
          </GuideLink>
        </div>
      </div>
    </details>
  )
}

export function GoogleMapsKeyForm({
  maps,
  busy,
  onSave,
}: {
  maps: MapsIntegrationStatusEntry
  busy: BusyAction
  onSave: (input: GoogleMapsConfigInput) => Promise<boolean>
}) {
  const [rawEnv, setRawEnv] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [mapId, setMapId] = React.useState("")
  const [open, setOpen] = React.useState(false)

  const save = async () => {
    const ok = await onSave({ rawEnv, apiKey, mapId })
    if (!ok) return
    setRawEnv("")
    setApiKey("")
    setMapId("")
    setOpen(false)
  }

  if (!open) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-[12px]",
          maps.configured
            ? "border-border/70 bg-background/60 text-foreground/65"
            : "border-cyan-500/25 bg-cyan-500/5 text-cyan-900 dark:text-cyan-200"
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-3.5 text-foreground/45" />
          <span className="font-medium text-foreground/75">
            Google Maps key & vector Map ID
          </span>
          {!maps.configured && (
            <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-cyan-700 dark:text-cyan-300">
              Not configured
            </span>
          )}
          {maps.configured && !maps.mapIdConfigured && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
              Map ID recommended
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant={maps.configured ? "outline" : "default"}
          onClick={() => setOpen(true)}
          disabled={busy !== null}
        >
          <Plus className="size-3.5" />
          {maps.configured ? "Edit setup" : "Add key"}
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-3 py-3 text-[12px] text-cyan-900 dark:text-cyan-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-3.5 text-foreground/50" />
          <span className="font-medium text-foreground/75">
            Google Maps key & vector Map ID
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy !== null}
          >
            Hide
          </Button>
          <Button size="sm" onClick={save} disabled={busy !== null}>
            {busy === "google-maps-save" ? (
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
          <span className="font-medium text-foreground/70">
            Paste .env lines
          </span>
          <textarea
            value={rawEnv}
            onChange={(event) => setRawEnv(event.target.value)}
            placeholder={"GOOGLE_MAPS_API_KEY=...\nGOOGLE_MAPS_MAP_ID=..."}
            className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
          />
        </label>

        <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
          <p className="text-[12px] font-medium text-foreground/70">
            Or type values directly
          </p>
          <ConfigInput
            label="API key"
            value={apiKey}
            onChange={setApiKey}
            placeholder={
              maps.configured
                ? "Stored key unchanged if left blank"
                : "Google Maps Platform key"
            }
            type="password"
          />
          <ConfigInput
            label="Vector Map ID"
            value={mapId}
            onChange={setMapId}
            placeholder={
              maps.mapIdConfigured
                ? "Stored Map ID unchanged if left blank"
                : "JavaScript Vector Map ID"
            }
          />
        </div>
        <p className="text-[11.5px] leading-relaxed text-foreground/55">
          The same key is used for Maps JavaScript, Geocoding, Places, Routes,
          and optional Google Weather APIs. The Map ID is recommended for
          production tilt and rotation.
        </p>
      </div>
    </div>
  )
}

export function MapsWeatherSetupGuide() {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
        <span>Mini tutorial: Maps, Vector tilt, Earth 3D, Weather</span>
        <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
        <ol className="grid list-decimal gap-1.5 pl-4">
          <li>
            Open{" "}
            <GuideLink href={GOOGLE_MAPS_PLATFORM_URL}>
              Google Maps Platform
            </GuideLink>
            , choose or create the project, then create one API key.
          </li>
          <li>
            Enable map APIs separately:{" "}
            <GuideLink href={ENABLE_MAPS_JS_API_URL}>Maps JavaScript</GuideLink>
            , <GuideLink href={ENABLE_GEOCODING_API_URL}>Geocoding</GuideLink>,{" "}
            <GuideLink href={ENABLE_PLACES_API_URL}>Places</GuideLink>, and{" "}
            <GuideLink href={ENABLE_ROUTES_API_URL}>Routes</GuideLink>.
          </li>
          <li>
            For reliable tilt/rotation, create a{" "}
            <GuideLink href={GOOGLE_MAPS_MAP_IDS_URL}>Map ID</GuideLink>: type
            JavaScript, rendering Vector, Tilt and Rotation enabled. Save it as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              GOOGLE_MAPS_MAP_ID
            </code>
            .
          </li>
          <li>
            Earth 3D uses{" "}
            <GuideLink href={GOOGLE_MAPS_3D_DOCS_URL}>3D Maps beta</GuideLink>,
            not the normal satellite tilt. Confirm important locations in the{" "}
            <GuideLink href={GOOGLE_MAPS_3D_COVERAGE_URL}>
              coverage map
            </GuideLink>
            .
          </li>
          <li>
            Enable environment APIs separately:{" "}
            <GuideLink href={ENABLE_WEATHER_API_URL}>Weather</GuideLink>,{" "}
            <GuideLink href={ENABLE_AIR_QUALITY_API_URL}>Air Quality</GuideLink>
            , and <GuideLink href={ENABLE_POLLEN_API_URL}>Pollen</GuideLink>.
          </li>
          <li>
            Paste it here as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              GOOGLE_MAPS_API_KEY
            </code>
            . Orchestrator verifies Geocoding with the same key. Google Weather,
            Air Quality, and Pollen use it when those APIs are enabled.
          </li>
          <li>
            After the first successful test, restrict the key in Google Cloud
            Console to the APIs enabled above and to your deployment&apos;s
            allowed origins where applicable.
          </li>
        </ol>
        <p>
          Open-Meteo needs no key and stays as the fallback for forecasts, air
          quality, historical comparison, and seasonal pollen.
        </p>
      </div>
    </details>
  )
}

export function WhatsAppSetupGuide() {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
        <span>Mini tutorial: WhatsApp setup</span>
        <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
	        <p>
	          Use Connect to start a local WhatsApp companion session. A QR code
	          appears in this card.
        </p>
        <p>
          On your phone, open WhatsApp, go to Settings or Menu, choose Linked
          devices, then Link a device.
        </p>
	        <p>
	          Scan the QR code. Orchestrator stores the companion session locally
	          and exposes WhatsApp tools to the main agent.
        </p>
        <p>
          Messages, photos, files, and delete-for-everyone actions require
          explicit confirmation before they run.
        </p>
      </div>
    </details>
  )
}
