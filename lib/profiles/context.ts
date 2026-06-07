import { AsyncLocalStorage } from "async_hooks"

import { ADMIN_PROFILE_ID } from "./constants"

export interface ActiveProfileContext {
  profileId: string
  role?: "admin" | "member"
}

const profileStorage = new AsyncLocalStorage<ActiveProfileContext>()

export function runWithProfileContext<T>(
  context: ActiveProfileContext,
  fn: () => T
): T {
  return profileStorage.run(
    { ...context, profileId: normalizeProfileId(context.profileId) },
    fn
  )
}

export function getActiveProfileContext(): ActiveProfileContext {
  return profileStorage.getStore() ?? { profileId: ADMIN_PROFILE_ID, role: "admin" }
}

export function getActiveProfileId(): string {
  return getActiveProfileContext().profileId
}

export function isAdminProfileId(profileId = getActiveProfileId()): boolean {
  return normalizeProfileId(profileId) === ADMIN_PROFILE_ID
}

export function normalizeProfileId(profileId: string): string {
  const clean = profileId.trim().toLowerCase()
  if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clean)) return clean
  throw new Error(`Invalid profile id: ${profileId}`)
}
