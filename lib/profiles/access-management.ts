import { grantIntegrationConnection } from "@/lib/integrations/connection-store"

import { getProfile, updateProfile } from "./store"
import {
  normalizeProfilePermissions,
  type IntegrationAccess,
} from "./types"

const ACCESS_RANK: Record<IntegrationAccess, number> = {
  none: 0,
  read: 1,
  write: 2,
  setup: 3,
}

export function ensureProfileIntegrationAccess(input: {
  profileId: string
  integration: "home_assistant"
  access: IntegrationAccess
  actorProfileId: string
}): void {
  const profile = getProfile(input.profileId)
  if (!profile) throw new Error(`Profile not found: ${input.profileId}`)
  if (profile.role === "admin") return
  const permissions = normalizeProfilePermissions(
    profile.permissions,
    profile.role
  )
  if (
    ACCESS_RANK[permissions.integrations[input.integration] ?? "none"] >=
    ACCESS_RANK[input.access]
  ) {
    return
  }
  permissions.integrations[input.integration] = input.access
  updateProfile(profile.id, { permissions }, input.actorProfileId)
}

export function grantHomeAssistantConnectionToProfile(input: {
  connectionId: string
  profileId: string
  access: Exclude<IntegrationAccess, "none">
  actorProfileId: string
}) {
  const grant = grantIntegrationConnection({
    connectionId: input.connectionId,
    profileId: input.profileId,
    access: input.access,
    actorProfileId: input.actorProfileId,
  })
  ensureProfileIntegrationAccess({
    profileId: input.profileId,
    integration: "home_assistant",
    access: input.access,
    actorProfileId: input.actorProfileId,
  })
  return grant
}
