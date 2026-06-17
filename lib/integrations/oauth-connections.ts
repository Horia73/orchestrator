import fs from "fs"
import path from "path"
import { AsyncLocalStorage } from "async_hooks"

import {
  ensureOAuthConnectionForProfile,
  getIntegrationConnection,
  getPreferredIntegrationConnectionId,
  listAccessibleIntegrationConnections,
  resolveIntegrationConnectionForProfile,
  setPreferredIntegrationConnection,
  type AccessibleIntegrationConnection,
  type IntegrationConnectionProvider,
} from "@/lib/integrations/connection-store"
import {
  readGoogleOAuthToken,
  writeGoogleOAuthToken,
  type GoogleOAuthTokenRecord,
} from "@/lib/integrations/google-oauth"
import { getActiveProfileId, normalizeProfileId } from "@/lib/profiles/context"
import { getProfile } from "@/lib/profiles/store"
import { runtimePathsForProfile } from "@/lib/runtime-paths"

export type GoogleAccountConnectionProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"

export interface GoogleAccountConnectionStatus {
  id: string
  provider: GoogleAccountConnectionProvider
  displayName: string
  ownerProfileId: string
  ownerName: string
  access: "read" | "write" | "setup"
  source: "owned" | "shared"
  selected: boolean
  accountEmail: string | null
  connected: boolean
  expiresAt: number | null
  needsReconnect: boolean
}

export interface ResolvedGoogleAccountToken {
  token: GoogleOAuthTokenRecord | null
  tokenPath: string
  connection: GoogleAccountConnectionStatus | null
  availableConnections: GoogleAccountConnectionStatus[]
  legacy: boolean
}

interface ProviderConfig {
  provider: GoogleAccountConnectionProvider
  tokenProvider: string
  legacyTokenPath: string
}

const providerContext =
  new AsyncLocalStorage<Partial<Record<GoogleAccountConnectionProvider, string>>>()

export function runWithGoogleAccountConnection<T>(
  provider: GoogleAccountConnectionProvider,
  connectionId: string,
  fn: () => T
): T {
  const current = providerContext.getStore() ?? {}
  return providerContext.run({ ...current, [provider]: connectionId }, fn)
}

export function resolveGoogleAccountToken(
  config: ProviderConfig
): ResolvedGoogleAccountToken {
  migrateLegacyTokenIfNeeded(config)

  const profileId = getActiveProfileId()
  const overrideConnectionId = providerContext.getStore()?.[config.provider]
  const accessible = listAccessibleIntegrationConnections(profileId, config.provider)
  const selected = overrideConnectionId
    ? requireAccessibleConnection(profileId, config.provider, overrideConnectionId)
    : resolveIntegrationConnectionForProfile(profileId, config.provider)

  if (selected) {
    const tokenPath = googleAccountTokenPath(config.provider, selected.connection)
    const token = readGoogleOAuthToken(tokenPath, config.tokenProvider)
    const availableConnections = listGoogleAccountConnectionStatuses({
      provider: config.provider,
      tokenProvider: config.tokenProvider,
      selectedConnectionId: selected.connection.id,
    })
    return {
      token,
      tokenPath,
      connection:
        availableConnections.find((item) => item.id === selected.connection.id) ??
        googleAccountConnectionStatus(config.provider, selected, true, token),
      availableConnections,
      legacy: false,
    }
  }

  const token = readGoogleOAuthToken(config.legacyTokenPath, config.tokenProvider)
  return {
    token,
    tokenPath: config.legacyTokenPath,
    connection: null,
    availableConnections: accessible.map((item) =>
      googleAccountConnectionStatus(config.provider, item, false, null)
    ),
    legacy: true,
  }
}

export function saveGoogleAccountTokenForActiveProfile(input: {
  provider: GoogleAccountConnectionProvider
  tokenProvider: string
  legacyTokenPath: string
  token: GoogleOAuthTokenRecord
}): { connectionId: string | null; tokenPath: string } {
  const email = input.token.accountEmail?.trim().toLowerCase()
  if (!email) {
    writeGoogleOAuthToken(input.legacyTokenPath, input.token)
    return { connectionId: null, tokenPath: input.legacyTokenPath }
  }

  const profileId = getActiveProfileId()
  const connection = ensureOAuthConnectionForProfile({
    provider: input.provider,
    ownerProfileId: profileId,
    accountEmail: email,
  })
  const tokenPath = googleAccountTokenPath(input.provider, {
    id: connection.id,
    ownerProfileId: profileId,
  })
  writeGoogleOAuthToken(tokenPath, input.token)
  setPreferredIntegrationConnection({
    profileId,
    provider: input.provider,
    connectionId: connection.id,
    actorProfileId: profileId,
  })
  return { connectionId: connection.id, tokenPath }
}

export function clearGoogleAccountToken(input: {
  provider: GoogleAccountConnectionProvider
  tokenProvider: string
  legacyTokenPath: string
  connectionId?: string
}): ResolvedGoogleAccountToken {
  const resolved = input.connectionId
    ? runWithGoogleAccountConnection(input.provider, input.connectionId, () =>
        resolveGoogleAccountToken(input)
      )
    : resolveGoogleAccountToken(input)
  try {
    fs.unlinkSync(resolved.tokenPath)
  } catch {
    // Already disconnected.
  }
  if (resolved.legacy) {
    try {
      fs.unlinkSync(input.legacyTokenPath)
    } catch {
      // Already disconnected.
    }
  }
  return resolved
}

export function listGoogleAccountConnectionStatuses(input: {
  provider: GoogleAccountConnectionProvider
  tokenProvider: string
  selectedConnectionId?: string | null
}): GoogleAccountConnectionStatus[] {
  const profileId = getActiveProfileId()
  const selectedId =
    input.selectedConnectionId ??
    getPreferredIntegrationConnectionId(profileId, input.provider)
  return listAccessibleIntegrationConnections(profileId, input.provider).map((item) => {
    const tokenPath = googleAccountTokenPath(input.provider, item.connection)
    const token = readGoogleOAuthToken(tokenPath, input.tokenProvider)
    return googleAccountConnectionStatus(
      input.provider,
      item,
      item.connection.id === selectedId,
      token
    )
  })
}

export function googleAccountTokenPath(
  provider: GoogleAccountConnectionProvider,
  connection: { id: string; ownerProfileId: string }
): string {
  return path.join(
    runtimePathsForProfile(connection.ownerProfileId).privateStateDir,
    "auth",
    `${provider}-accounts`,
    `${safeFilePart(connection.id)}.json`
  )
}

function migrateLegacyTokenIfNeeded(config: ProviderConfig): void {
  const profileId = getActiveProfileId()
  const legacyToken = readGoogleOAuthToken(
    config.legacyTokenPath,
    config.tokenProvider
  )
  const email = legacyToken?.accountEmail?.trim().toLowerCase()
  if (!legacyToken || !email) return

  const existing = listAccessibleIntegrationConnections(profileId, config.provider)
  if (existing.some((item) => item.connection.ownerProfileId === profileId)) return

  const connection = ensureOAuthConnectionForProfile({
    provider: config.provider,
    ownerProfileId: profileId,
    accountEmail: email,
  })
  const tokenPath = googleAccountTokenPath(config.provider, {
    id: connection.id,
    ownerProfileId: profileId,
  })
  if (!fs.existsSync(tokenPath)) writeGoogleOAuthToken(tokenPath, legacyToken)
  setPreferredIntegrationConnection({
    profileId,
    provider: config.provider,
    connectionId: connection.id,
    actorProfileId: profileId,
  })
}

function requireAccessibleConnection(
  profileId: string,
  provider: IntegrationConnectionProvider,
  connectionId: string
): AccessibleIntegrationConnection {
  const cleanProfileId = normalizeProfileId(profileId)
  const connection = getIntegrationConnection(connectionId)
  if (!connection || connection.provider !== provider) {
    throw new Error("Google account connection was not found.")
  }
  const accessible = listAccessibleIntegrationConnections(cleanProfileId, provider)
  const selected = accessible.find((item) => item.connection.id === connection.id)
  if (!selected) {
    throw new Error("This profile does not have access to that Google account.")
  }
  return selected
}

function googleAccountConnectionStatus(
  provider: GoogleAccountConnectionProvider,
  item: AccessibleIntegrationConnection,
  selected: boolean,
  token: GoogleOAuthTokenRecord | null
): GoogleAccountConnectionStatus {
  const owner = getProfile(item.connection.ownerProfileId)
  const expired = token ? token.expiresAt <= Date.now() : false
  return {
    id: item.connection.id,
    provider,
    displayName: item.connection.displayName,
    ownerProfileId: item.connection.ownerProfileId,
    ownerName: owner?.name ?? item.connection.ownerProfileId,
    access: item.access,
    source: item.source,
    selected,
    accountEmail: token?.accountEmail ?? accountEmailFromDisplayName(item.connection.displayName),
    connected: Boolean(token?.accessToken || token?.refreshToken),
    expiresAt: token?.expiresAt ?? null,
    needsReconnect: Boolean(!token || expired || (expired && !token.refreshToken)),
  }
}

function accountEmailFromDisplayName(displayName: string): string | null {
  const match = displayName.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0]?.toLowerCase() ?? null
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_")
}
