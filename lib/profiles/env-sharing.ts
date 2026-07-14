import {
  getActiveProfileId,
  isAdminProfileId,
} from "@/lib/profiles/context"
import { getProfile } from "@/lib/profiles/store"
import {
  activeRuntimePaths,
  runtimePathsForProfile,
} from "@/lib/runtime-paths"

import { ADMIN_PROFILE_ID } from "./constants"

export const SHARED_ADMIN_ENV_READ_ONLY_ERROR =
  "This profile uses the admin environment. Change shared environment values from the admin profile, or turn off Use admin environment for this profile."

export function activeProfileUsesAdminEnvironment(): boolean {
  const profileId = getActiveProfileId()
  if (isAdminProfileId(profileId)) return false
  return getProfile(profileId)?.permissions.inheritAdminApiKeys === true
}

export function activeProfileCanReadAdminEnvironment(): boolean {
  return (
    isAdminProfileId(getActiveProfileId()) ||
    activeProfileUsesAdminEnvironment()
  )
}

export function effectiveWorkspaceEnvPath(): string {
  if (activeProfileUsesAdminEnvironment()) {
    return runtimePathsForProfile(ADMIN_PROFILE_ID).workspaceEnvPath
  }
  return activeRuntimePaths().workspaceEnvPath
}

export function writableWorkspaceEnvPath(): string {
  if (activeProfileUsesAdminEnvironment()) {
    throw new Error(SHARED_ADMIN_ENV_READ_ONLY_ERROR)
  }
  return activeRuntimePaths().workspaceEnvPath
}

export function shouldSyncWorkspaceEnvToProcess(): boolean {
  return isAdminProfileId(getActiveProfileId())
}

export function effectiveWorkspaceEnvSourceLabel(): string {
  return activeProfileUsesAdminEnvironment()
    ? "shared admin environment"
    : "profile workspace environment"
}
