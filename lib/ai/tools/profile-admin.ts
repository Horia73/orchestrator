import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import {
  ensureHomeAssistantConnectionForProfile,
  getIntegrationConnection,
  listConnectionProfiles,
  listIntegrationConnectionGrants,
  listIntegrationConnections,
  revokeIntegrationConnectionGrant,
  setPreferredIntegrationConnection,
} from "@/lib/integrations/connection-store"
import { getHomeAssistantIntegrationStatus } from "@/lib/integrations/home-assistant"
import { grantHomeAssistantConnectionToProfile } from "@/lib/profiles/access-management"
import { getActiveProfileId } from "@/lib/profiles/context"
import { getProfile } from "@/lib/profiles/store"

export const profileAdminListTool: ToolDef = {
  id: "ProfileAdminListAccess",
  name: "ProfileAdminListAccess",
  description:
    "Admin-only. Lists profiles, Home Assistant connection records, and sharing grants so the admin can inspect who owns and can use each connection.",
  input_schema: { type: "object", properties: {} },
  tags: ["read", "profile-admin"],
}

export const profileAdminGrantHomeAssistantTool: ToolDef = {
  id: "ProfileAdminGrantHomeAssistantAccess",
  name: "ProfileAdminGrantHomeAssistantAccess",
  description: [
    "Admin-only. Grants a profile access to a Home Assistant connection without copying secrets.",
    "Use only after explicit user confirmation of profile, connection, and access level.",
    "If connection_id is omitted, the active admin profile's Home Assistant connection is used.",
    "This also raises the target profile's Home Assistant permission to the requested access if needed.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      profile_id: {
        type: "string",
        description: "Target profile id receiving access.",
      },
      connection_id: {
        type: "string",
        description:
          "Optional Home Assistant connection id. Omit to use this admin profile's own Home Assistant connection.",
      },
      access: {
        type: "string",
        enum: ["read", "write", "setup"],
        description:
          "read = inspect states/history; write = control approved devices subject to action policy; setup = manage connection-level setup.",
      },
      confirmed_by_user: {
        type: "boolean",
        description:
          "Must be true only after the user explicitly confirms this exact grant.",
      },
    },
    required: ["profile_id", "access", "confirmed_by_user"],
  },
  tags: ["write", "profile-admin"],
}

export const profileAdminRevokeHomeAssistantTool: ToolDef = {
  id: "ProfileAdminRevokeHomeAssistantAccess",
  name: "ProfileAdminRevokeHomeAssistantAccess",
  description:
    "Admin-only. Revokes a profile's grant to a shared Home Assistant connection. Use only after explicit user confirmation.",
  input_schema: {
    type: "object",
    properties: {
      profile_id: { type: "string", description: "Target profile id." },
      connection_id: {
        type: "string",
        description: "Home Assistant connection id whose grant should be revoked.",
      },
      confirmed_by_user: {
        type: "boolean",
        description:
          "Must be true only after the user explicitly confirms this exact revoke.",
      },
    },
    required: ["profile_id", "connection_id", "confirmed_by_user"],
  },
  tags: ["write", "profile-admin"],
}

export const profileAdminSetHomeAssistantDefaultTool: ToolDef = {
  id: "ProfileAdminSetHomeAssistantDefault",
  name: "ProfileAdminSetHomeAssistantDefault",
  description:
    "Admin-only. Sets which accessible Home Assistant connection a profile should use by default. Use only after explicit user confirmation.",
  input_schema: {
    type: "object",
    properties: {
      profile_id: { type: "string", description: "Target profile id." },
      connection_id: {
        type: "string",
        description: "Accessible Home Assistant connection id to use by default.",
      },
      confirmed_by_user: {
        type: "boolean",
        description:
          "Must be true only after the user explicitly confirms this exact default change.",
      },
    },
    required: ["profile_id", "connection_id", "confirmed_by_user"],
  },
  tags: ["write", "profile-admin"],
}

export const profileAdminTools: ToolDef[] = [
  profileAdminListTool,
  profileAdminGrantHomeAssistantTool,
  profileAdminRevokeHomeAssistantTool,
  profileAdminSetHomeAssistantDefaultTool,
]

export async function executeProfileAdminListAccess(): Promise<ToolResult> {
  requireActiveAdminProfile()
  await getHomeAssistantIntegrationStatus(false)
  return {
    success: true,
    data: {
      profiles: listConnectionProfiles(),
      homeAssistant: {
        connections: listIntegrationConnections({ provider: "home_assistant" }),
        grants: listIntegrationConnectionGrants(),
      },
    },
  }
}

export async function executeProfileAdminGrantHomeAssistantAccess(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const actorProfileId = requireActiveAdminProfile()
  if (args.confirmed_by_user !== true) {
    return {
      success: false,
      error:
        "confirmed_by_user must be true after explicit confirmation of the profile, Home Assistant connection, and access level.",
    }
  }
  const profileId = stringArg(args.profile_id, "profile_id")
  const access = accessArg(args.access)
  const connectionId =
    typeof args.connection_id === "string" && args.connection_id.trim()
      ? args.connection_id.trim()
      : await defaultHomeAssistantConnectionId(actorProfileId)

  const grant = grantHomeAssistantConnectionToProfile({
    connectionId,
    profileId,
    access,
    actorProfileId,
  })
  return {
    success: true,
    data: {
      grant,
      connection: getIntegrationConnection(connectionId),
      profile: safeProfile(profileId),
    },
  }
}

export async function executeProfileAdminRevokeHomeAssistantAccess(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const actorProfileId = requireActiveAdminProfile()
  if (args.confirmed_by_user !== true) {
    return {
      success: false,
      error:
        "confirmed_by_user must be true after explicit confirmation of the profile and Home Assistant connection.",
    }
  }
  const profileId = stringArg(args.profile_id, "profile_id")
  const connectionId = stringArg(args.connection_id, "connection_id")
  const revoked = revokeIntegrationConnectionGrant({
    connectionId,
    profileId,
    actorProfileId,
  })
  return {
    success: true,
    data: {
      revoked,
      connection: getIntegrationConnection(connectionId),
      profile: safeProfile(profileId),
    },
  }
}

export async function executeProfileAdminSetHomeAssistantDefault(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const actorProfileId = requireActiveAdminProfile()
  if (args.confirmed_by_user !== true) {
    return {
      success: false,
      error:
        "confirmed_by_user must be true after explicit confirmation of the profile and Home Assistant connection.",
    }
  }
  const profileId = stringArg(args.profile_id, "profile_id")
  const connectionId = stringArg(args.connection_id, "connection_id")
  const selected = setPreferredIntegrationConnection({
    profileId,
    provider: "home_assistant",
    connectionId,
    actorProfileId,
  })
  return {
    success: true,
    data: {
      selected,
      profile: safeProfile(profileId),
    },
  }
}

function requireActiveAdminProfile(): string {
  const profileId = getActiveProfileId()
  const profile = getProfile(profileId)
  if (!profile || profile.role !== "admin") {
    throw new Error("Admin profile required for profile administration.")
  }
  return profile.id
}

async function defaultHomeAssistantConnectionId(actorProfileId: string): Promise<string> {
  const status = await getHomeAssistantIntegrationStatus(false)
  const existing = listIntegrationConnections({
    provider: "home_assistant",
    ownerProfileId: actorProfileId,
  })[0]
  if (existing) return existing.id
  if (!status.configured) {
    throw new Error(
      "This admin profile does not have a configured Home Assistant connection."
    )
  }
  return ensureHomeAssistantConnectionForProfile(actorProfileId).id
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`)
  }
  return value.trim()
}

function accessArg(value: unknown): "read" | "write" | "setup" {
  if (value === "read" || value === "write" || value === "setup") {
    return value
  }
  throw new Error("access must be read, write, or setup.")
}

function safeProfile(profileId: string) {
  const profile = getProfile(profileId)
  if (!profile) return null
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    disabledAt: profile.disabledAt,
    homeAssistantAccess: profile.permissions.integrations.home_assistant,
  }
}
