import { getProfile, getControlDb, listProfiles, recordProfileAudit } from "@/lib/profiles/store"
import { getActiveProfileId, normalizeProfileId } from "@/lib/profiles/context"
import type { IntegrationAccess } from "@/lib/profiles/types"
import { createHash } from "crypto"

export type IntegrationConnectionProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "home_assistant"
export type GrantableIntegrationAccess = Exclude<IntegrationAccess, "none">

export interface IntegrationConnectionRecord {
  id: string
  provider: IntegrationConnectionProvider
  ownerProfileId: string
  displayName: string
  createdAt: number
  updatedAt: number
}

export interface IntegrationConnectionGrantRecord {
  connectionId: string
  profileId: string
  access: GrantableIntegrationAccess
  createdByProfileId: string | null
  createdAt: number
  updatedAt: number
}

export interface IntegrationConnectionPreferenceRecord {
  profileId: string
  provider: IntegrationConnectionProvider
  connectionId: string
  updatedAt: number
}

export interface AccessibleIntegrationConnection {
  connection: IntegrationConnectionRecord
  access: GrantableIntegrationAccess
  source: "owned" | "shared"
}

interface ConnectionRow {
  id: string
  provider: IntegrationConnectionProvider
  ownerProfileId: string
  displayName: string
  createdAt: number
  updatedAt: number
}

interface GrantRow {
  connectionId: string
  profileId: string
  access: GrantableIntegrationAccess
  createdByProfileId: string | null
  createdAt: number
  updatedAt: number
}

const ACCESS_RANK: Record<GrantableIntegrationAccess, number> = {
  read: 1,
  write: 2,
  setup: 3,
}
const SHAREABLE_CONNECTION_PROVIDERS = new Set<IntegrationConnectionProvider>([
  "home_assistant",
])

let schemaReady = false

export function ensureIntegrationConnectionSchema(): void {
  if (schemaReady) return
  getControlDb().exec(`
    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      ownerProfileId TEXT NOT NULL,
      displayName TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (ownerProfileId) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner
      ON integration_connections(provider, ownerProfileId);

    CREATE TABLE IF NOT EXISTS integration_connection_grants (
      connectionId TEXT NOT NULL,
      profileId TEXT NOT NULL,
      access TEXT NOT NULL,
      createdByProfileId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (connectionId, profileId),
      FOREIGN KEY (connectionId) REFERENCES integration_connections(id) ON DELETE CASCADE,
      FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connection_grants_profile
      ON integration_connection_grants(profileId, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS integration_connection_preferences (
      profileId TEXT NOT NULL,
      provider TEXT NOT NULL,
      connectionId TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (profileId, provider),
      FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (connectionId) REFERENCES integration_connections(id) ON DELETE CASCADE
    );
  `)
  schemaReady = true
}

export function homeAssistantConnectionId(ownerProfileId: string): string {
  return `home_assistant_${normalizeProfileId(ownerProfileId)}`
}

export function oauthConnectionId(
  provider: Exclude<IntegrationConnectionProvider, "home_assistant">,
  ownerProfileId: string,
  accountEmail: string
): string {
  return `${provider}_${normalizeProfileId(ownerProfileId)}_${slugPart(accountEmail)}_${shortHash(accountEmail)}`
}

export function ensureOAuthConnectionForProfile(input: {
  provider: Exclude<IntegrationConnectionProvider, "home_assistant">
  ownerProfileId?: string
  accountEmail: string
  displayName?: string
}): IntegrationConnectionRecord {
  const profileId = normalizeProfileId(input.ownerProfileId ?? getActiveProfileId())
  const accountEmail = input.accountEmail.trim().toLowerCase()
  if (!accountEmail) throw new Error("Google account email is required.")
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`Profile not found: ${profileId}`)
  const label = providerDisplayName(input.provider)
  return ensureIntegrationConnection({
    provider: input.provider,
    ownerProfileId: profileId,
    id: oauthConnectionId(input.provider, profileId, accountEmail),
    displayName: input.displayName?.trim() || `${accountEmail} (${label})`,
  })
}

export function ensureHomeAssistantConnectionForProfile(
  ownerProfileId = getActiveProfileId(),
  displayName?: string
): IntegrationConnectionRecord {
  const profileId = normalizeProfileId(ownerProfileId)
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`Profile not found: ${profileId}`)
  return ensureIntegrationConnection({
    provider: "home_assistant",
    ownerProfileId: profileId,
    id: homeAssistantConnectionId(profileId),
    displayName:
      displayName?.trim() ||
      `${profile.name}'s Home Assistant`,
  })
}

export function ensureIntegrationConnection(input: {
  id: string
  provider: IntegrationConnectionProvider
  ownerProfileId: string
  displayName: string
}): IntegrationConnectionRecord {
  ensureIntegrationConnectionSchema()
  const now = Date.now()
  const ownerProfileId = normalizeProfileId(input.ownerProfileId)
  const existing = getIntegrationConnection(input.id)
  if (existing) {
    if (
      existing.ownerProfileId !== ownerProfileId ||
      existing.provider !== input.provider
    ) {
      throw new Error(`Connection id collision: ${input.id}`)
    }
    if (existing.displayName !== input.displayName) {
      getControlDb()
        .prepare(
          `
            UPDATE integration_connections
            SET displayName = ?, updatedAt = ?
            WHERE id = ?
          `
        )
        .run(input.displayName, now, input.id)
    }
    return getIntegrationConnection(input.id) ?? existing
  }

  getControlDb()
    .prepare(
      `
        INSERT INTO integration_connections (
          id, provider, ownerProfileId, displayName, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(input.id, input.provider, ownerProfileId, input.displayName, now, now)
  const created = getIntegrationConnection(input.id)
  if (!created) throw new Error(`Failed to create connection ${input.id}`)
  return created
}

export function getIntegrationConnection(
  connectionId: string
): IntegrationConnectionRecord | null {
  ensureIntegrationConnectionSchema()
  const row = getControlDb()
    .prepare(`SELECT * FROM integration_connections WHERE id = ?`)
    .get(connectionId) as ConnectionRow | undefined
  return row ? connectionFromRow(row) : null
}

export function listIntegrationConnections(options?: {
  provider?: IntegrationConnectionProvider
  ownerProfileId?: string
}): IntegrationConnectionRecord[] {
  ensureIntegrationConnectionSchema()
  const clauses: string[] = []
  const args: unknown[] = []
  if (options?.provider) {
    clauses.push("provider = ?")
    args.push(options.provider)
  }
  if (options?.ownerProfileId) {
    clauses.push("ownerProfileId = ?")
    args.push(normalizeProfileId(options.ownerProfileId))
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getControlDb()
    .prepare(
      `
        SELECT * FROM integration_connections
        ${where}
        ORDER BY provider ASC, ownerProfileId ASC, createdAt ASC
      `
    )
    .all(...args) as ConnectionRow[]
  return rows.map(connectionFromRow)
}

export function listIntegrationConnectionGrants(options?: {
  connectionId?: string
  profileId?: string
}): IntegrationConnectionGrantRecord[] {
  ensureIntegrationConnectionSchema()
  const clauses: string[] = []
  const args: unknown[] = []
  if (options?.connectionId) {
    clauses.push("connectionId = ?")
    args.push(options.connectionId)
  }
  if (options?.profileId) {
    clauses.push("profileId = ?")
    args.push(normalizeProfileId(options.profileId))
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = getControlDb()
    .prepare(
      `
        SELECT * FROM integration_connection_grants
        ${where}
        ORDER BY updatedAt DESC
      `
    )
    .all(...args) as GrantRow[]
  return rows.map(grantFromRow)
}

export function listIntegrationConnectionPreferences(options?: {
  profileId?: string
  provider?: IntegrationConnectionProvider
}): IntegrationConnectionPreferenceRecord[] {
  ensureIntegrationConnectionSchema()
  const clauses: string[] = []
  const args: unknown[] = []
  if (options?.profileId) {
    clauses.push("profileId = ?")
    args.push(normalizeProfileId(options.profileId))
  }
  if (options?.provider) {
    clauses.push("provider = ?")
    args.push(options.provider)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  return getControlDb()
    .prepare(
      `
        SELECT profileId, provider, connectionId, updatedAt
        FROM integration_connection_preferences
        ${where}
        ORDER BY updatedAt DESC
      `
    )
    .all(...args) as IntegrationConnectionPreferenceRecord[]
}

export function listAccessibleIntegrationConnections(
  profileId: string,
  provider: IntegrationConnectionProvider
): AccessibleIntegrationConnection[] {
  ensureIntegrationConnectionSchema()
  const cleanProfileId = normalizeProfileId(profileId)
  const owned = listIntegrationConnections({
    provider,
    ownerProfileId: cleanProfileId,
  }).map((connection): AccessibleIntegrationConnection => ({
    connection,
    access: "setup",
    source: "owned",
  }))
  if (!SHAREABLE_CONNECTION_PROVIDERS.has(provider)) return owned

  const grantRows = getControlDb()
    .prepare(
      `
        SELECT c.*, g.access
        FROM integration_connection_grants g
        JOIN integration_connections c ON c.id = g.connectionId
        WHERE g.profileId = ? AND c.provider = ?
        ORDER BY g.updatedAt DESC
      `
    )
    .all(cleanProfileId, provider) as Array<ConnectionRow & { access: GrantableIntegrationAccess }>

  const seen = new Set(owned.map((item) => item.connection.id))
  const shared = grantRows
    .filter((row) => !seen.has(row.id))
    .map((row): AccessibleIntegrationConnection => ({
      connection: connectionFromRow(row),
      access: normalizeGrantAccess(row.access),
      source: "shared",
    }))

  return [...owned, ...shared]
}

export function getPreferredIntegrationConnectionId(
  profileId: string,
  provider: IntegrationConnectionProvider
): string | null {
  ensureIntegrationConnectionSchema()
  const row = getControlDb()
    .prepare(
      `
        SELECT connectionId
        FROM integration_connection_preferences
        WHERE profileId = ? AND provider = ?
      `
    )
    .get(normalizeProfileId(profileId), provider) as
    | { connectionId: string }
    | undefined
  return row?.connectionId ?? null
}

export function setPreferredIntegrationConnection(input: {
  profileId: string
  provider: IntegrationConnectionProvider
  connectionId: string
  actorProfileId?: string | null
}): AccessibleIntegrationConnection {
  const profileId = normalizeProfileId(input.profileId)
  const accessible = listAccessibleIntegrationConnections(profileId, input.provider)
  const selected = accessible.find(
    (item) => item.connection.id === input.connectionId
  )
  if (!selected) {
    throw new Error("Profile does not have access to this connection.")
  }
  getControlDb()
    .prepare(
      `
        INSERT INTO integration_connection_preferences (
          profileId, provider, connectionId, updatedAt
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profileId, provider) DO UPDATE SET
          connectionId = excluded.connectionId,
          updatedAt = excluded.updatedAt
      `
    )
    .run(profileId, input.provider, input.connectionId, Date.now())
  recordProfileAudit({
    actorProfileId: input.actorProfileId ?? null,
    targetProfileId: profileId,
    type: "integration.connection.preference.updated",
    summary: `Updated ${input.provider} default connection for ${profileName(profileId)}`,
    payload: {
      provider: input.provider,
      connectionId: input.connectionId,
    },
  })
  return selected
}

export function resolveIntegrationConnectionForProfile(
  profileId: string,
  provider: IntegrationConnectionProvider
): AccessibleIntegrationConnection | null {
  const cleanProfileId = normalizeProfileId(profileId)
  const accessible = listAccessibleIntegrationConnections(cleanProfileId, provider)
  if (accessible.length === 0) return null

  const preferredId = getPreferredIntegrationConnectionId(cleanProfileId, provider)
  const preferred = preferredId
    ? accessible.find((item) => item.connection.id === preferredId)
    : null
  if (preferred) return preferred

  return (
    accessible.find((item) => item.source === "owned") ??
    accessible[0] ??
    null
  )
}

export function grantIntegrationConnection(input: {
  connectionId: string
  profileId: string
  access: IntegrationAccess
  actorProfileId?: string | null
}): IntegrationConnectionGrantRecord {
  ensureIntegrationConnectionSchema()
  const connection = getIntegrationConnection(input.connectionId)
  if (!connection) throw new Error("Connection not found.")
  if (!SHAREABLE_CONNECTION_PROVIDERS.has(connection.provider)) {
    throw new Error(
      `${providerDisplayName(connection.provider)} connections cannot be shared across profiles. Connect that account under the target profile instead.`
    )
  }
  const profileId = normalizeProfileId(input.profileId)
  const target = getProfile(profileId)
  if (!target) throw new Error(`Profile not found: ${profileId}`)
  if (target.disabledAt) throw new Error(`Profile is disabled: ${target.name}`)
  if (profileId === connection.ownerProfileId) {
    throw new Error("Owners already have full access to their own connection.")
  }
  const access = normalizeGrantAccess(input.access)
  const now = Date.now()

  getControlDb()
    .prepare(
      `
        INSERT INTO integration_connection_grants (
          connectionId, profileId, access, createdByProfileId, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(connectionId, profileId) DO UPDATE SET
          access = excluded.access,
          updatedAt = excluded.updatedAt
      `
    )
    .run(
      connection.id,
      profileId,
      access,
      input.actorProfileId ?? null,
      now,
      now
    )

  recordProfileAudit({
    actorProfileId: input.actorProfileId ?? null,
    targetProfileId: profileId,
    type: "integration.connection.granted",
    summary: `Granted ${profileName(profileId)} ${access} access to ${connection.displayName}`,
    payload: {
      provider: connection.provider,
      connectionId: connection.id,
      ownerProfileId: connection.ownerProfileId,
      access,
    },
  })

  const grant = listIntegrationConnectionGrants({
    connectionId: connection.id,
    profileId,
  })[0]
  if (!grant) throw new Error("Failed to save connection grant.")
  return grant
}

export function revokeIntegrationConnectionGrant(input: {
  connectionId: string
  profileId: string
  actorProfileId?: string | null
}): boolean {
  ensureIntegrationConnectionSchema()
  const connection = getIntegrationConnection(input.connectionId)
  if (!connection) throw new Error("Connection not found.")
  const profileId = normalizeProfileId(input.profileId)
  const result = getControlDb()
    .prepare(
      `
        DELETE FROM integration_connection_grants
        WHERE connectionId = ? AND profileId = ?
      `
    )
    .run(connection.id, profileId)
  if (result.changes > 0) {
    recordProfileAudit({
      actorProfileId: input.actorProfileId ?? null,
      targetProfileId: profileId,
      type: "integration.connection.revoked",
      summary: `Revoked ${profileName(profileId)} access to ${connection.displayName}`,
      payload: {
        provider: connection.provider,
        connectionId: connection.id,
        ownerProfileId: connection.ownerProfileId,
      },
    })
  }
  return result.changes > 0
}

export function normalizeGrantAccess(value: IntegrationAccess): GrantableIntegrationAccess {
  if (value === "setup" || value === "write" || value === "read") return value
  throw new Error("Connection grant access must be read, write, or setup.")
}

export function hasGrantAccess(
  actual: GrantableIntegrationAccess,
  needed: IntegrationAccess
): boolean {
  if (needed === "none") return true
  return ACCESS_RANK[actual] >= ACCESS_RANK[normalizeGrantAccess(needed)]
}

function connectionFromRow(row: ConnectionRow): IntegrationConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    ownerProfileId: row.ownerProfileId,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function grantFromRow(row: GrantRow): IntegrationConnectionGrantRecord {
  return {
    connectionId: row.connectionId,
    profileId: row.profileId,
    access: normalizeGrantAccess(row.access),
    createdByProfileId: row.createdByProfileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function profileName(profileId: string): string {
  return getProfile(profileId)?.name ?? profileId
}

function providerDisplayName(provider: IntegrationConnectionProvider): string {
  if (provider === "gmail") return "Gmail"
  if (provider === "google_calendar") return "Google Calendar"
  if (provider === "google_drive") return "Google Workspace"
  return "Home Assistant"
}

function slugPart(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
  if (slug) return slug
  return "account"
}

function shortHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 12)
}

export function listConnectionProfiles(): Array<{
  id: string
  name: string
  role: string
  disabledAt: number | null
}> {
  return listProfiles({ includeDisabled: true }).map((profile) => ({
    id: profile.id,
    name: profile.name,
    role: profile.role,
    disabledAt: profile.disabledAt,
  }))
}
