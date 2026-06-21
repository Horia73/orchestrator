import type { ComponentType } from "react"
import {
  CalendarDays,
  FolderOpen,
  House,
  LocateFixed,
  Mail,
  MapPinned,
  MessageCircle,
  Network,
} from "lucide-react"
import type {
  GoogleDriveIntegrationStatusEntry,
  IntegrationsStatus,
  LocationIntelligenceIntegrationStatusEntry,
  MapsIntegrationStatusEntry,
  RemoteMcpIntegrationStatusEntry,
  WeatherIntegrationStatusEntry,
  WhatsAppIntegrationStatusEntry,
} from "@/components/settings/use-integrations-status"

export const AUTH_SERVICE_IDS = [
  "gmail",
  "whatsapp",
  "googleCalendar",
  "googleDrive",
  "homeAssistant",
  "mapsWeather",
  "locationIntelligence",
  "mcp",
] as const

export type AuthServiceId = (typeof AUTH_SERVICE_IDS)[number]
export type AuthStatusTone = "success" | "warn" | "muted"

export interface AuthServiceDescriptor {
  id: AuthServiceId
  name: string
  summary: string
  status: string
  tone: AuthStatusTone
  icon: ComponentType<{ className?: string }>
  iconClassName: string
  iconWrapClassName: string
}

export const DEFAULT_AUTH_SERVICE_ID: AuthServiceId = "gmail"

export function isAuthServiceId(value: string | null): value is AuthServiceId {
  return (
    value !== null && (AUTH_SERVICE_IDS as readonly string[]).includes(value)
  )
}

export function authStatusDotClass(tone: AuthStatusTone): string {
  if (tone === "success") return "bg-emerald-500"
  if (tone === "warn") return "bg-amber-500"
  return "bg-foreground/25"
}

export function buildAuthServiceDescriptors(
  data: IntegrationsStatus
): AuthServiceDescriptor[] {
  const gmailStatus = oauthStatus(
    data.gmail.configured,
    data.gmail.connected,
    data.gmail.needsReconnect
  )
  const calendarStatus = oauthStatus(
    data.googleCalendar.configured,
    data.googleCalendar.connected,
    data.googleCalendar.needsReconnect
  )
  const driveStatus = oauthStatus(
    data.googleDrive.configured,
    data.googleDrive.connected,
    data.googleDrive.needsReconnect
  )
  const whatsappStatus = whatsAppStatus(data.whatsapp)
  const homeAssistantStatus = data.homeAssistant.configured
    ? data.homeAssistant.connected && !data.homeAssistant.needsReconnect
      ? ({ tone: "success", status: "Connected" } satisfies Pick<
          AuthServiceDescriptor,
          "tone" | "status"
        >)
      : ({ tone: "warn", status: "Unreachable" } satisfies Pick<
          AuthServiceDescriptor,
          "tone" | "status"
        >)
    : ({ tone: "warn", status: "Config needed" } satisfies Pick<
        AuthServiceDescriptor,
        "tone" | "status"
      >)
  const mapsStatus = mapsWeatherStatus(data.maps, data.weather)
  const locationStatus = locationIntelligenceStatus(data.locationIntelligence)
  const mcpStatus = remoteMcpStatus(data.mcp)

  return [
    {
      id: "gmail",
      name: data.gmail.name,
      summary:
        accountSummary(data.gmail.accountEmail, data.gmail.availableConnections.length) ??
        oauthSummary(
          data.gmail.configured,
          data.gmail.connected,
          data.gmail.needsReconnect
        ),
      icon: Mail,
      iconWrapClassName: "bg-red-500/10",
      iconClassName: "text-red-600 dark:text-red-400",
      ...gmailStatus,
    },
    {
      id: "whatsapp",
      name: data.whatsapp.name,
      summary: whatsAppSummary(data.whatsapp),
      icon: MessageCircle,
      iconWrapClassName: "bg-emerald-500/10",
      iconClassName: "text-emerald-700 dark:text-emerald-400",
      ...whatsappStatus,
    },
    {
      id: "googleCalendar",
      name: data.googleCalendar.name,
      summary:
        data.googleCalendar.primaryCalendarSummary ??
        accountSummary(
          data.googleCalendar.accountEmail,
          data.googleCalendar.availableConnections.length
        ) ??
        oauthSummary(
          data.googleCalendar.configured,
          data.googleCalendar.connected,
          data.googleCalendar.needsReconnect
        ),
      icon: CalendarDays,
      iconWrapClassName: "bg-blue-500/10",
      iconClassName: "text-blue-700 dark:text-blue-400",
      ...calendarStatus,
    },
    {
      id: "googleDrive",
      name: data.googleDrive.name,
      summary:
        accountSummary(
          data.googleDrive.accountEmail,
          data.googleDrive.availableConnections.length
        ) ??
        data.googleDrive.accountName ??
        oauthSummary(
          data.googleDrive.configured,
          data.googleDrive.connected,
          data.googleDrive.needsReconnect
        ),
      icon: FolderOpen,
      iconWrapClassName: "bg-emerald-500/10",
      iconClassName: "text-emerald-700 dark:text-emerald-400",
      ...driveStatus,
    },
    {
      id: "homeAssistant",
      name: data.homeAssistant.name,
      summary:
        data.homeAssistant.locationName ??
        data.homeAssistant.baseUrl ??
        (data.homeAssistant.configured
          ? "API verification pending"
          : "Add URL and token"),
      icon: House,
      iconWrapClassName: "bg-sky-500/10",
      iconClassName: "text-sky-700 dark:text-sky-400",
      ...homeAssistantStatus,
    },
    {
      id: "mapsWeather",
      name: "Maps & Weather",
      summary: mapsWeatherSummary(data.maps, data.weather),
      icon: MapPinned,
      iconWrapClassName: "bg-cyan-500/10",
      iconClassName: "text-cyan-700 dark:text-cyan-400",
      ...mapsStatus,
    },
    {
      id: "locationIntelligence",
      name: data.locationIntelligence.name,
      summary: locationIntelligenceSummary(data.locationIntelligence),
      icon: LocateFixed,
      iconWrapClassName: "bg-violet-500/10",
      iconClassName: "text-violet-700 dark:text-violet-400",
      ...locationStatus,
    },
    {
      id: "mcp",
      name: data.mcp.name,
      summary: remoteMcpSummary(data.mcp),
      icon: Network,
      iconWrapClassName: "bg-indigo-500/10",
      iconClassName: "text-indigo-700 dark:text-indigo-400",
      ...mcpStatus,
    },
  ]
}

function accountSummary(accountEmail: string | null, connectionCount: number): string | null {
  if (!accountEmail) return null
  if (connectionCount <= 1) return accountEmail
  return `${accountEmail} + ${connectionCount - 1} more`
}

export function oauthStatus(
  configured: boolean,
  connected: boolean,
  needsReconnect: boolean
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (!configured) return { tone: "warn", status: "Config needed" }
  if (connected && !needsReconnect)
    return { tone: "success", status: "Connected" }
  if (connected || needsReconnect) return { tone: "warn", status: "Reconnect" }
  return { tone: "muted", status: "Not connected" }
}

export function oauthSummary(
  configured: boolean,
  connected: boolean,
  needsReconnect: boolean
): string {
  if (!configured) return "OAuth client missing"
  if (connected && needsReconnect) return "Reconnect required"
  if (connected) return "OAuth tokens stored locally"
  return "Ready to connect"
}

export function whatsAppStatus(
  entry: WhatsAppIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (entry.provider === "disabled") return { tone: "muted", status: "Disabled" }
  if (!entry.configured) return { tone: "warn", status: "Browser needed" }
  if (entry.connected && !entry.needsReconnect)
    return { tone: "success", status: "Connected" }
  if (entry.phase === "qr") return { tone: "warn", status: "Scan QR" }
  if (entry.phase === "starting" || entry.phase === "authenticated")
    return { tone: "warn", status: "Linking" }
  if (
    entry.needsReconnect ||
    entry.phase === "error" ||
    entry.phase === "auth_failure"
  ) {
    return { tone: "warn", status: "Reconnect" }
  }
  if (entry.sessionStored) return { tone: "warn", status: "Saved" }
  return { tone: "muted", status: "Not connected" }
}

export function whatsAppSummary(entry: WhatsAppIntegrationStatusEntry): string {
  if (entry.provider === "disabled") return "Disabled"
  if (entry.connected)
    return entry.accountName || entry.phoneNumber || "Local session running"
  if (entry.phase === "qr") return "Waiting for QR scan"
  if (entry.phase === "starting" || entry.phase === "authenticated")
    return "WhatsApp is linking"
  if (entry.sessionStored && entry.needsReconnect)
    return "Local session needs reconnect"
  if (entry.sessionStored) return "Session saved locally"
  if (!entry.configured) return "Local browser not found"
  return "No active session"
}

export function mapsWeatherStatus(
  maps: MapsIntegrationStatusEntry,
  weather: WeatherIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (maps.connected && weather.anyProviderReady)
    return { tone: "success", status: "Ready" }
  if (maps.connected) return { tone: "success", status: "Maps ready" }
  if (!maps.configured) return { tone: "warn", status: "Key needed" }
  return { tone: "warn", status: "API issue" }
}

export function mapsWeatherSummary(
  maps: MapsIntegrationStatusEntry,
  weather: WeatherIntegrationStatusEntry
): string {
  const weatherLabel =
    weather.providerInUse === "google"
      ? "Google Weather"
      : weather.providerInUse === "open-meteo"
        ? "Open-Meteo fallback"
        : "Weather offline"
  if (!maps.configured) return `Add Maps key · ${weatherLabel}`
  if (!maps.connected) return `Maps not verified · ${weatherLabel}`
  return `${maps.mapIdConfigured ? "Vector Map ID set" : "Demo Map ID"} · ${weatherLabel}`
}

export function sourceTypeLabel(
  value: LocationIntelligenceIntegrationStatusEntry["source"]["type"]
): string {
  if (value === "home-assistant-webhook") return "Home Assistant webhook"
  if (value === "home-assistant") return "Home Assistant"
  if (value === "manual") return "Manual import"
  return "Not set"
}

export function locationIntelligenceStatus(
  entry: LocationIntelligenceIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (!entry.configured) return { tone: "muted", status: "Optional" }
  if (!entry.enabled) return { tone: "muted", status: "Disabled" }
  if (entry.connected) return { tone: "success", status: "Ready" }
  if (entry.needsReconnect) return { tone: "warn", status: "Needs setup" }
  return { tone: "warn", status: "No data" }
}

export function locationIntelligenceSummary(
  entry: LocationIntelligenceIntegrationStatusEntry
): string {
  if (!entry.configured) return "Ask your assistant to set it up"
  if (!entry.enabled) return "Configured but disabled"
  if (entry.journal.lastDate) return `Latest day ${entry.journal.lastDate}`
  if (entry.journal.dayCount > 0)
    return `${entry.journal.dayCount} days indexed`
  if (entry.journal.exists) return "Journal ready; no days yet"
  return "Journal files missing"
}

export function remoteMcpStatus(
  entry: RemoteMcpIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (!entry.configured) return { tone: "muted", status: "Optional" }
  if (entry.connected && !entry.needsReconnect) return { tone: "success", status: "Connected" }
  if (entry.needsReconnect) return { tone: "warn", status: "Reconnect" }
  return { tone: "warn", status: "Needs OAuth" }
}

export function remoteMcpSummary(entry: RemoteMcpIntegrationStatusEntry): string {
  if (!entry.configured) return "Add any remote MCP endpoint"
  if (entry.connectedServerCount > 0) {
    return `${entry.connectedServerCount}/${entry.serverCount} servers connected`
  }
  if (entry.serverCount === 1) return "1 server configured"
  return `${entry.serverCount} servers configured`
}

export function scopeLabel(scope: string): string {
  if (scope === "https://mail.google.com/") return "Full mailbox"
  if (scope.endsWith("/gmail.readonly")) return "Read"
  if (scope.endsWith("/gmail.compose")) return "Draft"
  if (scope.endsWith("/gmail.modify")) return "Modify"
  if (scope.endsWith("/gmail.send")) return "Send"
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

export function calendarScopeGranted(
  grantedScopes: string[],
  requestedScope: string
): boolean {
  return (
    grantedScopes.includes(requestedScope) ||
    (requestedScope.includes("/auth/calendar.") &&
      grantedScopes.includes("https://www.googleapis.com/auth/calendar"))
  )
}

export function calendarScopeLabel(scope: string): string {
  if (scope.endsWith("/calendar.calendarlist.readonly")) return "Calendars"
  if (scope.endsWith("/calendar.events")) return "Events"
  if (scope.endsWith("/calendar.freebusy")) return "Free/busy"
  if (scope.endsWith("/calendar.settings.readonly")) return "Settings"
  if (scope === "https://www.googleapis.com/auth/calendar")
    return "Full calendar"
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

export function driveScopeGranted(
  grantedScopes: string[],
  requestedScope: string
): boolean {
  return grantedScopes.includes(requestedScope)
}

export function driveScopeLabel(scope: string): string {
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

export function formatDriveStorage(
  storage: GoogleDriveIntegrationStatusEntry["storageQuota"]
): string {
  if (!storage?.usage) return "Not verified"
  const usage = formatByteString(storage.usage)
  const limit = storage.limit ? formatByteString(storage.limit) : "unlimited"
  return `${usage} of ${limit}`
}

export function formatByteString(value: string): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return value
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let current = bytes
  let unit = 0
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024
    unit += 1
  }
  const formatted =
    current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)
  return `${formatted} ${units[unit]}`
}

export function formatExpiry(expiresAt: number): string {
  if (expiresAt <= Date.now()) return "Expired"
  return `Expires ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(expiresAt))}`
}

export function formatStatusTimestamp(
  value: number | null | undefined
): string {
  if (!value) return "Not available"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

export function shortPath(value: string): string {
  const parts = value.split("/")
  if (parts.length <= 3) return value
  return `${parts[0] || "/" + parts[1]}/.../${parts.slice(-2).join("/")}`
}
