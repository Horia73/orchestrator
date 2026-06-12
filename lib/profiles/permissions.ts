import type { ToolDef } from "@/lib/ai/agents/types"

import { getActiveProfileId, isAdminProfileId } from "./context"
import { getProfile } from "./store"
import {
  hasGrantAccess,
  resolveIntegrationConnectionForProfile,
} from "@/lib/integrations/connection-store"
import type {
  IntegrationAccess,
  IntegrationPermissionId,
  ProfilePermissions,
  ToolPermissionId,
} from "./types"

const ACCESS_RANK: Record<IntegrationAccess, number> = {
  none: 0,
  read: 1,
  write: 2,
  setup: 3,
}

const INTEGRATION_TAGS: Record<string, IntegrationPermissionId> = {
  gmail: "gmail",
  "google-calendar": "google_calendar",
  "google-drive": "google_drive",
  "google-docs": "google_drive",
  "google-sheets": "google_drive",
  "google-slides": "google_drive",
  "google-contacts": "google_drive",
  whatsapp: "whatsapp",
  "home-assistant": "home_assistant",
  maps: "maps",
  weather: "weather",
}

const TOOL_TAGS: Record<string, ToolPermissionId> = {
  shell: "shell",
  delegation: "delegate_agents",
  memory: "memory",
  skills: "skills",
  scheduling: "scheduling",
  monitoring: "monitoring",
  microscripts: "microscripts",
}

const TOOL_IDS: Record<string, ToolPermissionId> = {
  Bash: "shell",
  WebFetch: "web_access",
  web_fetch: "web_access",
  create_backup: "backups",
  apply_update: "updates",
  host_status: "updates",
}

export function getActiveProfilePermissions(): ProfilePermissions | null {
  const profileId = getActiveProfileId()
  if (isAdminProfileId(profileId)) return null
  return getProfile(profileId)?.permissions ?? null
}

export function isToolAllowedForActiveProfile(tool: ToolDef): boolean {
  const permissions = getActiveProfilePermissions()
  if (!permissions) return true
  const denied = deniedToolReason(tool, permissions)
  return denied === null
}

export function deniedToolReason(
  tool: ToolDef,
  permissions = getActiveProfilePermissions()
): string | null {
  if (!permissions) return null

  const explicit = TOOL_IDS[tool.id]
  if (explicit && !permissions.tools[explicit]) return denied(explicit)

  for (const tag of tool.tags ?? []) {
    if (tag === "profile-admin") {
      return "Admin profile required for profile administration."
    }

    if (tag === "watchlist" && !permissions.surfaces.watchlist) {
      return "Profile is not allowed to use Watchlist."
    }

    const toolPermission = TOOL_TAGS[tag]
    if (toolPermission && !permissions.tools[toolPermission]) {
      return denied(toolPermission)
    }

    if (tag === "web" && !permissions.tools.web_access) {
      return denied("web_access")
    }
    if (tag === "filesystem") {
      if (tool.tags.includes("write") && !permissions.tools.write_files) {
        return denied("write_files")
      }
      if (!tool.tags.includes("write") && !permissions.tools.read_files) {
        return denied("read_files")
      }
    }

    const integration = INTEGRATION_TAGS[tag]
    if (integration) {
      const needed = neededIntegrationAccess(tool)
      if (!hasIntegrationAccess(permissions, integration, needed)) {
        return `Profile is not allowed to use ${integration} with ${needed} access.`
      }
      if (integration === "home_assistant") {
        const profileId = getActiveProfileId()
        const connection = resolveIntegrationConnectionForProfile(
          profileId,
          "home_assistant"
        )
        if (connection && !hasGrantAccess(connection.access, needed)) {
          return `Profile is not allowed to use Home Assistant connection ${connection.connection.displayName} with ${needed} access.`
        }
      }
    }
  }

  return null
}

export function hasIntegrationAccess(
  permissions: ProfilePermissions,
  integration: IntegrationPermissionId,
  needed: IntegrationAccess
): boolean {
  return (
    ACCESS_RANK[permissions.integrations[integration] ?? "none"] >=
    ACCESS_RANK[needed]
  )
}

function neededIntegrationAccess(tool: ToolDef): IntegrationAccess {
  if (tool.tags.includes("setup")) return "setup"
  if (tool.tags.includes("write") || tool.tags.includes("external_action")) {
    return "write"
  }
  return "read"
}

function denied(permission: ToolPermissionId): string {
  return `Profile is not allowed to use ${permission}.`
}
