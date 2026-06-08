export type ProfileRole = "admin" | "member"

export type ProfileSurface =
  | "chat"
  | "inbox"
  | "library"
  | "scheduling"
  | "watchlist"
  | "monitor"
  | "maps"
  | "workouts"
  | "settings"

export type IntegrationAccess = "none" | "read" | "write" | "setup"

export type IntegrationPermissionId =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "whatsapp"
  | "home_assistant"
  | "maps"
  | "weather"
  | "watchlist"

export type ToolPermissionId =
  | "read_files"
  | "write_files"
  | "shell"
  | "browser_agent"
  | "delegate_agents"
  | "web_access"
  | "memory"
  | "skills"
  | "scheduling"
  | "monitoring"
  | "microscripts"
  | "backups"
  | "updates"
  | "models"
  | "settings_files"

export interface ProfilePermissions {
  surfaces: Record<ProfileSurface, boolean>
  tools: Record<ToolPermissionId, boolean>
  integrations: Record<IntegrationPermissionId, IntegrationAccess>
  inheritAdminApiKeys: boolean
  allowedProviderApiKeys: string[]
}

export interface ProfileRecord {
  id: string
  name: string
  role: ProfileRole
  color: string
  avatar: string | null
  pinHash: string | null
  pinSalt: string | null
  permissions: ProfilePermissions
  disabledAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ProfileSessionRecord {
  tokenHash: string
  profileId: string
  deviceLabel: string | null
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

export interface ProfileAuditEvent {
  id: string
  actorProfileId: string | null
  targetProfileId: string | null
  type: string
  summary: string
  payload: Record<string, unknown>
  createdAt: number
}

export const PROFILE_SURFACES: ProfileSurface[] = [
  "chat",
  "inbox",
  "library",
  "scheduling",
  "watchlist",
  "monitor",
  "maps",
  "workouts",
  "settings",
]

export const TOOL_PERMISSION_IDS: ToolPermissionId[] = [
  "read_files",
  "write_files",
  "shell",
  "browser_agent",
  "delegate_agents",
  "web_access",
  "memory",
  "skills",
  "scheduling",
  "monitoring",
  "microscripts",
  "backups",
  "updates",
  "models",
  "settings_files",
]

export const INTEGRATION_PERMISSION_IDS: IntegrationPermissionId[] = [
  "gmail",
  "google_calendar",
  "google_drive",
  "whatsapp",
  "home_assistant",
  "maps",
  "weather",
  "watchlist",
]

const MEMBER_SURFACE_DEFAULTS: Record<ProfileSurface, boolean> = {
  chat: true,
  inbox: true,
  library: true,
  scheduling: true,
  watchlist: true,
  monitor: false,
  maps: true,
  workouts: true,
  settings: false,
}

const MEMBER_TOOL_DEFAULTS: Record<ToolPermissionId, boolean> = {
  read_files: true,
  write_files: true,
  shell: false,
  browser_agent: true,
  delegate_agents: true,
  web_access: true,
  memory: true,
  skills: true,
  scheduling: true,
  monitoring: false,
  microscripts: true,
  backups: false,
  updates: false,
  models: false,
  settings_files: false,
}

const MEMBER_INTEGRATION_DEFAULTS: Record<
  IntegrationPermissionId,
  IntegrationAccess
> = {
  gmail: "none",
  google_calendar: "none",
  google_drive: "none",
  whatsapp: "none",
  home_assistant: "none",
  maps: "read",
  weather: "read",
  watchlist: "write",
}

export function defaultMemberPermissions(): ProfilePermissions {
  return {
    surfaces: { ...MEMBER_SURFACE_DEFAULTS },
    tools: { ...MEMBER_TOOL_DEFAULTS },
    integrations: { ...MEMBER_INTEGRATION_DEFAULTS },
    inheritAdminApiKeys: false,
    allowedProviderApiKeys: [],
  }
}

export function adminPermissions(): ProfilePermissions {
  const surfaces = Object.fromEntries(
    PROFILE_SURFACES.map((surface) => [surface, true])
  ) as Record<ProfileSurface, boolean>
  const tools = Object.fromEntries(
    TOOL_PERMISSION_IDS.map((tool) => [tool, true])
  ) as Record<ToolPermissionId, boolean>
  const integrations = Object.fromEntries(
    INTEGRATION_PERMISSION_IDS.map((integration) => [integration, "setup"])
  ) as Record<IntegrationPermissionId, IntegrationAccess>
  return {
    surfaces,
    tools,
    integrations,
    inheritAdminApiKeys: true,
    allowedProviderApiKeys: ["*"],
  }
}

export function normalizeProfilePermissions(
  input: unknown,
  role: ProfileRole
): ProfilePermissions {
  const defaults =
    role === "admin" ? adminPermissions() : defaultMemberPermissions()
  if (!input || typeof input !== "object") return defaults
  const raw = input as Partial<ProfilePermissions>

  const surfaces = { ...defaults.surfaces }
  if (raw.surfaces && typeof raw.surfaces === "object") {
    for (const surface of PROFILE_SURFACES) {
      const value = (raw.surfaces as Record<string, unknown>)[surface]
      if (typeof value === "boolean") surfaces[surface] = value
    }
  }

  const tools = { ...defaults.tools }
  if (raw.tools && typeof raw.tools === "object") {
    for (const tool of TOOL_PERMISSION_IDS) {
      const value = (raw.tools as Record<string, unknown>)[tool]
      if (typeof value === "boolean") tools[tool] = value
    }
  }

  const integrations = { ...defaults.integrations }
  if (raw.integrations && typeof raw.integrations === "object") {
    for (const integration of INTEGRATION_PERMISSION_IDS) {
      const value = (raw.integrations as Record<string, unknown>)[integration]
      if (
        value === "none" ||
        value === "read" ||
        value === "write" ||
        value === "setup"
      ) {
        integrations[integration] = value
      }
    }
  }

  return {
    surfaces,
    tools,
    integrations,
    inheritAdminApiKeys:
      typeof raw.inheritAdminApiKeys === "boolean"
        ? raw.inheritAdminApiKeys
        : defaults.inheritAdminApiKeys,
    allowedProviderApiKeys: Array.isArray(raw.allowedProviderApiKeys)
      ? raw.allowedProviderApiKeys.filter((value): value is string =>
          typeof value === "string"
        )
      : [...defaults.allowedProviderApiKeys],
  }
}
