import crypto from "crypto"
import fs from "fs"
import path from "path"

import Database from "better-sqlite3"

import {
  ORCHESTRATOR_STATE_DIR,
  runtimePathsForProfile,
} from "@/lib/runtime-paths"

import { ADMIN_PROFILE_ID, PROFILE_SESSION_MAX_AGE_SECONDS } from "./constants"
import {
  adminPermissions,
  normalizeProfilePermissions,
  type IntegrationAccess,
  type IntegrationPermissionId,
  type ProfileAuditEvent,
  type ProfilePermissions,
  type ProfileRecord,
  type ProfileRole,
  type ProfileSessionRecord,
} from "./types"

const CONTROL_DB_PATH = path.join(
  /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
  "control.db"
)

let db: Database.Database | null = null

interface ProfileRow {
  id: string
  name: string
  role: ProfileRole
  color: string
  avatar: string | null
  pinHash: string | null
  pinSalt: string | null
  permissions: string | null
  disabledAt: number | null
  createdAt: number
  updatedAt: number
}

interface SessionRow {
  tokenHash: string
  profileId: string
  deviceLabel: string | null
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface AuditRow {
  id: string
  actorProfileId: string | null
  targetProfileId: string | null
  type: string
  summary: string
  payload: string | null
  createdAt: number
}

interface WebhookSlugOwnerRow {
  slug: string
  profileId: string
  endpointId: string
  createdAt: number
  updatedAt: number
}

export interface ProfileWebhookSlugOwner {
  slug: string
  profileId: string
  endpointId: string
  createdAt: number
  updatedAt: number
}

export interface CreateProfileInput {
  name: string
  role?: ProfileRole
  color?: string
  avatar?: string | null
  pin?: string | null
  permissions?: ProfilePermissions
}

export interface UpdateProfileInput {
  name?: string
  role?: ProfileRole
  color?: string
  avatar?: string | null
  pin?: string | null
  clearPin?: boolean
  permissions?: ProfilePermissions
  disabledAt?: number | null
}

export interface CreateSessionInput {
  profileId: string
  deviceLabel?: string | null
  userAgent?: string | null
  maxAgeSeconds?: number
}

export function getControlDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(CONTROL_DB_PATH), { recursive: true })
  db = new Database(CONTROL_DB_PATH, { timeout: 10_000 })
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 10000")
  db.pragma("journal_mode = WAL")
  initializeControlSchema(db)
  ensureDefaultAdminProfile(db)
  migrateLegacyMemberProfileDefaults(db)
  migrateMemberBasicSettingsAccess(db)
  migrateMemberPersonalIntegrationSelfService(db)
  restoreMemberApiKeySharingAfterHaDecouple(db)
  return db
}

export function listProfiles(options?: {
  includeDisabled?: boolean
}): ProfileRecord[] {
  const rows = getControlDb()
    .prepare(
      `SELECT * FROM profiles ${
        options?.includeDisabled ? "" : "WHERE disabledAt IS NULL"
      } ORDER BY role = 'admin' DESC, createdAt ASC`
    )
    .all() as ProfileRow[]
  return rows.map(profileFromRow)
}

export function getProfile(profileId: string): ProfileRecord | null {
  const row = getControlDb()
    .prepare(`SELECT * FROM profiles WHERE id = ?`)
    .get(normalizeStoredProfileId(profileId)) as ProfileRow | undefined
  return row ? profileFromRow(row) : null
}

export function createProfile(
  input: CreateProfileInput,
  actorProfileId: string | null = null
): ProfileRecord {
  const role = input.role ?? "member"
  const now = Date.now()
  const id = uniqueProfileId(input.name)
  const pin = normalizePin(input.pin)
  const pinData = pin ? hashPin(pin) : null
  const permissions =
    role === "admin"
      ? adminPermissions()
      : normalizeProfilePermissions(input.permissions, "member")

  getControlDb()
    .prepare(
      `
        INSERT INTO profiles (
          id, name, role, color, avatar, pinHash, pinSalt, permissions,
          disabledAt, createdAt, updatedAt
        )
        VALUES (@id, @name, @role, @color, @avatar, @pinHash, @pinSalt,
          @permissions, NULL, @createdAt, @updatedAt)
      `
    )
    .run({
      id,
      name: normalizeName(input.name),
      role,
      color: normalizeColor(input.color),
      avatar: input.avatar ?? null,
      pinHash: pinData?.hash ?? null,
      pinSalt: pinData?.salt ?? null,
      permissions: JSON.stringify(permissions),
      createdAt: now,
      updatedAt: now,
    })

  recordProfileAudit({
    actorProfileId,
    targetProfileId: id,
    type: "profile.created",
    summary: `Created profile ${input.name}`,
    payload: { role },
  })
  const profile = getProfile(id)
  if (!profile) throw new Error(`Failed to create profile ${id}`)
  return profile
}

export function updateProfile(
  profileId: string,
  input: UpdateProfileInput,
  actorProfileId: string | null = null
): ProfileRecord | null {
  const existing = getProfile(profileId)
  if (!existing) return null
  if (
    existing.id === ADMIN_PROFILE_ID &&
    input.role &&
    input.role !== "admin"
  ) {
    throw new Error("The built-in admin profile cannot be demoted.")
  }

  const nextRole = input.role ?? existing.role
  const now = Date.now()
  const pin = normalizePin(input.pin)
  const pinData = pin
    ? hashPin(pin)
    : input.clearPin
      ? { hash: null, salt: null }
      : { hash: existing.pinHash, salt: existing.pinSalt }
  const permissions =
    nextRole === "admin"
      ? adminPermissions()
      : normalizeProfilePermissions(
          input.permissions ?? existing.permissions,
          nextRole
        )

  getControlDb()
    .prepare(
      `
        UPDATE profiles
        SET name = @name,
            role = @role,
            color = @color,
            avatar = @avatar,
            pinHash = @pinHash,
            pinSalt = @pinSalt,
            permissions = @permissions,
            disabledAt = @disabledAt,
            updatedAt = @updatedAt
        WHERE id = @id
      `
    )
    .run({
      id: existing.id,
      name:
        input.name !== undefined ? normalizeName(input.name) : existing.name,
      role: nextRole,
      color:
        input.color !== undefined
          ? normalizeColor(input.color)
          : existing.color,
      avatar: input.avatar !== undefined ? input.avatar : existing.avatar,
      pinHash: pinData.hash,
      pinSalt: pinData.salt,
      permissions: JSON.stringify(permissions),
      disabledAt:
        input.disabledAt !== undefined ? input.disabledAt : existing.disabledAt,
      updatedAt: now,
    })

  recordProfileAudit({
    actorProfileId,
    targetProfileId: existing.id,
    type: "profile.updated",
    summary: `Updated profile ${existing.name}`,
    payload: {
      role: nextRole,
      disabledAt:
        input.disabledAt !== undefined ? input.disabledAt : existing.disabledAt,
      passwordChanged: input.pin !== undefined || input.clearPin === true,
    },
  })
  return getProfile(existing.id)
}

export function deleteProfile(
  profileId: string,
  actorProfileId: string | null = null,
  options?: { deleteState?: boolean }
): boolean {
  const id = normalizeStoredProfileId(profileId)
  if (id === ADMIN_PROFILE_ID) {
    throw new Error("The built-in admin profile cannot be deleted.")
  }
  const existing = getProfile(id)
  if (!existing) return false
  const result = getControlDb()
    .prepare(`DELETE FROM profiles WHERE id = ?`)
    .run(id)
  if (result.changes > 0) {
    recordProfileAudit({
      actorProfileId,
      targetProfileId: id,
      type: "profile.deleted",
      summary: `Deleted profile ${existing.name}`,
      payload: {},
    })
    if (options?.deleteState) deleteProfileStateDirectory(id)
  }
  return result.changes > 0
}

export function verifyProfilePin(
  profile: ProfileRecord,
  pin: string | null | undefined
): boolean {
  if (!profile.pinHash || !profile.pinSalt) return true
  const normalized = normalizePin(pin)
  if (!normalized) return false
  const expected = Buffer.from(profile.pinHash, "hex")
  const actual = Buffer.from(hashPin(normalized, profile.pinSalt).hash, "hex")
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  )
}

export function setProfilePinIfUnset(
  profileId: string,
  pin: string,
  actorProfileId: string | null = null
): ProfileRecord | null {
  const profile = getProfile(profileId)
  if (!profile || profile.pinHash) return profile
  return updateProfile(profile.id, { pin }, actorProfileId)
}

export function createProfileSession(input: CreateSessionInput): {
  token: string
  session: ProfileSessionRecord
} {
  const profile = getProfile(input.profileId)
  if (!profile || profile.disabledAt) {
    throw new Error("Profile is not available.")
  }
  const token = crypto.randomBytes(32).toString("base64url")
  const tokenHash = hashSessionToken(token)
  const now = Date.now()
  const expiresAt =
    now + (input.maxAgeSeconds ?? PROFILE_SESSION_MAX_AGE_SECONDS) * 1000
  getControlDb()
    .prepare(
      `
        INSERT INTO profile_sessions (
          tokenHash, profileId, deviceLabel, userAgent, createdAt, lastSeenAt,
          expiresAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      tokenHash,
      profile.id,
      input.deviceLabel ?? null,
      input.userAgent ?? null,
      now,
      now,
      expiresAt
    )
  recordProfileAudit({
    actorProfileId: profile.id,
    targetProfileId: profile.id,
    type: "profile.session.created",
    summary: `Signed in as ${profile.name}`,
    payload: { deviceLabel: input.deviceLabel ?? null },
  })
  const session = getProfileSessionByToken(token)
  if (!session) throw new Error("Failed to create profile session.")
  return { token, session }
}

export function getProfileSessionByToken(
  token: string | null | undefined
): ProfileSessionRecord | null {
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const row = getControlDb()
    .prepare(`SELECT * FROM profile_sessions WHERE tokenHash = ?`)
    .get(tokenHash) as SessionRow | undefined
  if (!row) return null
  if (row.expiresAt <= Date.now()) {
    deleteProfileSession(token)
    return null
  }
  getControlDb()
    .prepare(`UPDATE profile_sessions SET lastSeenAt = ? WHERE tokenHash = ?`)
    .run(Date.now(), tokenHash)
  return sessionFromRow({ ...row, lastSeenAt: Date.now() })
}

export function deleteProfileSession(token: string | null | undefined): void {
  if (!token) return
  getControlDb()
    .prepare(`DELETE FROM profile_sessions WHERE tokenHash = ?`)
    .run(hashSessionToken(token))
}

export function listProfileAuditEvents(options?: {
  profileId?: string
  limit?: number
}): ProfileAuditEvent[] {
  const limit = Math.max(1, Math.min(options?.limit ?? 200, 1000))
  const rows = options?.profileId
    ? (getControlDb()
        .prepare(
          `
            SELECT * FROM profile_audit_events
            WHERE actorProfileId = ? OR targetProfileId = ?
            ORDER BY createdAt DESC
            LIMIT ?
          `
        )
        .all(options.profileId, options.profileId, limit) as AuditRow[])
    : (getControlDb()
        .prepare(
          `SELECT * FROM profile_audit_events ORDER BY createdAt DESC LIMIT ?`
        )
        .all(limit) as AuditRow[])
  return rows.map(auditFromRow)
}

export function recordProfileAudit(input: {
  actorProfileId: string | null
  targetProfileId: string | null
  type: string
  summary: string
  payload?: Record<string, unknown>
}): void {
  getControlDb()
    .prepare(
      `
        INSERT INTO profile_audit_events (
          id, actorProfileId, targetProfileId, type, summary, payload, createdAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      crypto.randomUUID(),
      input.actorProfileId,
      input.targetProfileId,
      input.type,
      input.summary,
      JSON.stringify(input.payload ?? {}),
      Date.now()
    )
}

export function getProfileWebhookSlugOwner(
  slug: string
): ProfileWebhookSlugOwner | null {
  const normalizedSlug = normalizeStoredWebhookSlug(slug)
  const row = getControlDb()
    .prepare(`SELECT * FROM profile_webhook_slugs WHERE slug = ?`)
    .get(normalizedSlug) as WebhookSlugOwnerRow | undefined
  return row ? webhookSlugOwnerFromRow(row) : null
}

export function assertProfileWebhookSlugAvailable(
  slug: string,
  profileId: string,
  endpointId: string
): void {
  const existing = getProfileWebhookSlugOwner(slug)
  if (
    existing &&
    (existing.profileId !== normalizeStoredProfileId(profileId) ||
      existing.endpointId !== endpointId)
  ) {
    throw new Error(
      `Webhook slug "${slug}" is already owned by another profile.`
    )
  }
}

export function registerProfileWebhookSlugOwner(input: {
  slug: string
  profileId: string
  endpointId: string
}): ProfileWebhookSlugOwner {
  const slug = normalizeStoredWebhookSlug(input.slug)
  const profileId = normalizeStoredProfileId(input.profileId)
  const now = Date.now()
  const existing = getProfileWebhookSlugOwner(slug)
  if (
    existing &&
    (existing.profileId !== profileId ||
      existing.endpointId !== input.endpointId)
  ) {
    throw new Error(
      `Webhook slug "${slug}" is already owned by another profile.`
    )
  }
  if (existing) {
    getControlDb()
      .prepare(
        `
          UPDATE profile_webhook_slugs
          SET updatedAt = ?
          WHERE slug = ?
        `
      )
      .run(now, slug)
  } else {
    getControlDb()
      .prepare(
        `
          INSERT INTO profile_webhook_slugs (
            slug, profileId, endpointId, createdAt, updatedAt
          )
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(slug, profileId, input.endpointId, now, now)
  }
  const owner = getProfileWebhookSlugOwner(slug)
  if (!owner) throw new Error(`Failed to register webhook slug "${slug}".`)
  return owner
}

export function unregisterProfileWebhookSlugOwner(
  slug: string,
  endpointId?: string
): void {
  const normalizedSlug = normalizeStoredWebhookSlug(slug)
  if (endpointId) {
    getControlDb()
      .prepare(
        `DELETE FROM profile_webhook_slugs WHERE slug = ? AND endpointId = ?`
      )
      .run(normalizedSlug, endpointId)
    return
  }
  getControlDb()
    .prepare(`DELETE FROM profile_webhook_slugs WHERE slug = ?`)
    .run(normalizedSlug)
}

function initializeControlSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar TEXT,
      pinHash TEXT,
      pinSalt TEXT,
      permissions TEXT NOT NULL,
      disabledAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_sessions (
      tokenHash TEXT PRIMARY KEY,
      profileId TEXT NOT NULL,
      deviceLabel TEXT,
      userAgent TEXT,
      createdAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_profile_sessions_profile
      ON profile_sessions(profileId, lastSeenAt DESC);
    CREATE INDEX IF NOT EXISTS idx_profile_sessions_expiry
      ON profile_sessions(expiresAt);

    CREATE TABLE IF NOT EXISTS profile_audit_events (
      id TEXT PRIMARY KEY,
      actorProfileId TEXT,
      targetProfileId TEXT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_audit_created
      ON profile_audit_events(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_profile_audit_target
      ON profile_audit_events(targetProfileId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS profile_webhook_slugs (
      slug TEXT PRIMARY KEY,
      profileId TEXT NOT NULL,
      endpointId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_profile_webhook_slugs_profile
      ON profile_webhook_slugs(profileId, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS owner_agent_requests (
      id TEXT PRIMARY KEY,
      requesterProfileId TEXT NOT NULL,
      requesterConversationId TEXT NOT NULL,
      requesterAgentId TEXT NOT NULL,
      ownerProfileId TEXT NOT NULL,
      ownerConversationId TEXT,
      ownerAgentThreadId TEXT,
      title TEXT NOT NULL,
      request TEXT NOT NULL,
      status TEXT NOT NULL,
      response TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      completedAt INTEGER,
      FOREIGN KEY (requesterProfileId) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (ownerProfileId) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_owner_agent_requests_requester
      ON owner_agent_requests(requesterProfileId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_owner_agent_requests_status
      ON owner_agent_requests(status, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS control_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `)
}

function ensureDefaultAdminProfile(database: Database.Database): void {
  const existing = database
    .prepare(`SELECT id FROM profiles WHERE id = ?`)
    .get(ADMIN_PROFILE_ID)
  if (existing) return
  const now = Date.now()
  const initialPin = normalizePin(
    process.env.ORCHESTRATOR_ADMIN_PASSWORD ??
      process.env.ORCHESTRATOR_ADMIN_PIN
  )
  const pinData = initialPin ? hashPin(initialPin) : null
  database
    .prepare(
      `
        INSERT INTO profiles (
          id, name, role, color, avatar, pinHash, pinSalt, permissions,
          disabledAt, createdAt, updatedAt
        )
        VALUES (?, ?, 'admin', ?, NULL, ?, ?, ?, NULL, ?, ?)
      `
    )
    .run(
      ADMIN_PROFILE_ID,
      "Horia",
      "#2f6f73",
      pinData?.hash ?? null,
      pinData?.salt ?? null,
      JSON.stringify(adminPermissions()),
      now,
      now
    )
}

// Home Assistant credentials no longer ride the shared provider-key inheritance
// (they moved to a per-profile private store), so the `allowedProviderApiKeys`
// wildcard is safe again. Restore full admin API-key sharing (`["*"]`) for
// member profiles that were narrowed by the interim HA-leak mitigation. Runs
// exactly once (guarded by a control_meta marker) so it never clobbers an
// intentional narrowing an admin sets later.
function restoreMemberApiKeySharingAfterHaDecouple(
  database: Database.Database
): void {
  const MARKER = "ha_env_decouple_restore_sharing_v1"
  const already = database
    .prepare(`SELECT 1 FROM control_meta WHERE key = ?`)
    .get(MARKER)
  if (already) return

  const rows = database
    .prepare(`SELECT id, permissions FROM profiles WHERE role = 'member'`)
    .all() as Array<{ id: string; permissions: string }>
  const update = database.prepare(
    `UPDATE profiles SET permissions = ?, updatedAt = ? WHERE id = ?`
  )
  const now = Date.now()
  for (const row of rows) {
    let perms: Record<string, unknown>
    try {
      const parsed = row.permissions ? JSON.parse(row.permissions) : null
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      perms = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (perms.inheritAdminApiKeys !== true) continue
    const allowed = Array.isArray(perms.allowedProviderApiKeys)
      ? (perms.allowedProviderApiKeys as unknown[])
      : []
    if (allowed.includes("*")) continue
    perms.allowedProviderApiKeys = ["*"]
    update.run(JSON.stringify(perms), now, row.id)
  }

  database
    .prepare(
      `INSERT OR IGNORE INTO control_meta (key, value, updatedAt) VALUES (?, ?, ?)`
    )
    .run(MARKER, "applied", now)
}

function migrateLegacyMemberProfileDefaults(database: Database.Database): void {
  const rows = database
    .prepare(`SELECT * FROM profiles WHERE role = 'member'`)
    .all() as ProfileRow[]
  if (rows.length === 0) return

  const update = database.prepare(
    `UPDATE profiles SET permissions = ?, updatedAt = ? WHERE id = ?`
  )
  for (const row of rows) {
    let raw: Record<string, unknown>
    try {
      const parsed = row.permissions ? JSON.parse(row.permissions) : null
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue
      }
      raw = parsed as Record<string, unknown>
    } catch {
      continue
    }

    if (!isLegacyMemberDefaultPermissionShape(raw)) continue

    const permissions = normalizeProfilePermissions(raw, "member")
    permissions.surfaces.monitor = true
    permissions.surfaces.settings = true
    permissions.tools.monitoring = true
    permissions.inheritAdminApiKeys = true
    permissions.allowedProviderApiKeys = ["*"]

    update.run(JSON.stringify(permissions), Date.now(), row.id)
  }
}

function isLegacyMemberDefaultPermissionShape(
  raw: Record<string, unknown>
): boolean {
  const surfaces =
    raw.surfaces &&
    typeof raw.surfaces === "object" &&
    !Array.isArray(raw.surfaces)
      ? (raw.surfaces as Record<string, unknown>)
      : {}
  const tools =
    raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools)
      ? (raw.tools as Record<string, unknown>)
      : {}
  const integrations =
    raw.integrations &&
    typeof raw.integrations === "object" &&
    !Array.isArray(raw.integrations)
      ? (raw.integrations as Record<string, unknown>)
      : {}
  const allowedProviderApiKeys = raw.allowedProviderApiKeys

  return (
    surfaces.monitor === false &&
    tools.monitoring === false &&
    raw.inheritAdminApiKeys === false &&
    Array.isArray(allowedProviderApiKeys) &&
    allowedProviderApiKeys.length === 0 &&
    integrations.watchlist === "write"
  )
}

function migrateMemberBasicSettingsAccess(database: Database.Database): void {
  const rows = database
    .prepare(`SELECT * FROM profiles WHERE role = 'member'`)
    .all() as ProfileRow[]
  if (rows.length === 0) return

  const update = database.prepare(
    `UPDATE profiles SET permissions = ?, updatedAt = ? WHERE id = ?`
  )
  for (const row of rows) {
    let raw: unknown
    try {
      raw = row.permissions ? JSON.parse(row.permissions) : null
    } catch {
      continue
    }
    const permissions = normalizeProfilePermissions(raw, "member")
    if (permissions.surfaces.settings) continue
    permissions.surfaces.settings = true
    update.run(JSON.stringify(permissions), Date.now(), row.id)
  }
}

const PERSONAL_SELF_SERVICE_INTEGRATIONS: IntegrationPermissionId[] = [
  "gmail",
  "google_calendar",
  "google_drive",
  "whatsapp",
  "home_assistant",
  "maps",
]

function migrateMemberPersonalIntegrationSelfService(
  database: Database.Database
): void {
  const MARKER = "member_personal_integration_self_service_v1"
  const already = database
    .prepare(`SELECT 1 FROM control_meta WHERE key = ?`)
    .get(MARKER)
  if (already) return

  const rows = database
    .prepare(`SELECT * FROM profiles WHERE role = 'member'`)
    .all() as ProfileRow[]
  const update = database.prepare(
    `UPDATE profiles SET permissions = ?, updatedAt = ? WHERE id = ?`
  )
  const now = Date.now()
  for (const row of rows) {
    let raw: Record<string, unknown>
    try {
      const parsed = row.permissions ? JSON.parse(row.permissions) : null
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue
      }
      raw = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (!isPreSelfServiceIntegrationDefaultShape(raw)) continue

    const permissions = normalizeProfilePermissions(raw, "member")
    for (const integration of PERSONAL_SELF_SERVICE_INTEGRATIONS) {
      permissions.integrations[integration] = "setup"
    }
    update.run(JSON.stringify(permissions), now, row.id)
  }

  database
    .prepare(
      `INSERT OR IGNORE INTO control_meta (key, value, updatedAt) VALUES (?, ?, ?)`
    )
    .run(MARKER, "applied", now)
}

function isPreSelfServiceIntegrationDefaultShape(
  raw: Record<string, unknown>
): boolean {
  const integrations =
    raw.integrations &&
    typeof raw.integrations === "object" &&
    !Array.isArray(raw.integrations)
      ? (raw.integrations as Record<string, unknown>)
      : {}

  const expected: Partial<Record<IntegrationPermissionId, IntegrationAccess>> = {
    gmail: "none",
    google_calendar: "none",
    google_drive: "none",
    whatsapp: "none",
    home_assistant: "none",
    maps: "read",
    weather: "read",
  }

  return Object.entries(expected).every(
    ([integration, access]) => integrations[integration] === access
  )
}

function profileFromRow(row: ProfileRow): ProfileRecord {
  let parsed: unknown = null
  try {
    parsed = row.permissions ? JSON.parse(row.permissions) : null
  } catch {
    parsed = null
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role === "admin" ? "admin" : "member",
    color: row.color,
    avatar: row.avatar,
    pinHash: row.pinHash,
    pinSalt: row.pinSalt,
    permissions: normalizeProfilePermissions(
      parsed,
      row.role === "admin" ? "admin" : "member"
    ),
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function sessionFromRow(row: SessionRow): ProfileSessionRecord {
  return {
    tokenHash: row.tokenHash,
    profileId: row.profileId,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  }
}

function auditFromRow(row: AuditRow): ProfileAuditEvent {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = row.payload ? JSON.parse(row.payload) : {}
    payload =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    actorProfileId: row.actorProfileId,
    targetProfileId: row.targetProfileId,
    type: row.type,
    summary: row.summary,
    payload,
    createdAt: row.createdAt,
  }
}

function webhookSlugOwnerFromRow(
  row: WebhookSlugOwnerRow
): ProfileWebhookSlugOwner {
  return {
    slug: row.slug,
    profileId: row.profileId,
    endpointId: row.endpointId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function normalizeStoredProfileId(value: string): string {
  const clean = value.trim().toLowerCase()
  if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clean)) return clean
  throw new Error(`Invalid profile id: ${value}`)
}

function normalizeStoredWebhookSlug(value: string): string {
  const clean = value.trim().toLowerCase()
  if (/^[a-z0-9][a-z0-9_-]{0,79}$/.test(clean)) return clean
  throw new Error(`Invalid webhook slug: ${value}`)
}

function deleteProfileStateDirectory(profileId: string): void {
  const profileRoot = path.resolve(
    /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
    "profiles"
  )
  const target = path.resolve(runtimePathsForProfile(profileId).stateDir)
  if (
    target === profileRoot ||
    !target.startsWith(`${profileRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing to delete unsafe profile state path: ${target}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

function uniqueProfileId(name: string): string {
  const base = slugifyProfileName(name)
  const database = getControlDb()
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `_${i + 1}`
    const id = normalizeStoredProfileId(`${base}${suffix}`)
    const existing = database
      .prepare(`SELECT 1 FROM profiles WHERE id = ?`)
      .get(id)
    if (!existing) return id
  }
  return normalizeStoredProfileId(
    `${base}_${crypto.randomBytes(4).toString("hex")}`
  )
}

function slugifyProfileName(name: string): string {
  const clean = normalizeName(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
  return clean || `profile_${crypto.randomBytes(3).toString("hex")}`
}

function normalizeName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim()
  if (clean.length < 1 || clean.length > 80) {
    throw new Error("Profile name must be between 1 and 80 characters.")
  }
  return clean
}

function normalizeColor(color: string | undefined): string {
  const fallback = "#2f6f73"
  if (!color) return fallback
  const clean = color.trim()
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean.toLowerCase() : fallback
}

function normalizePin(pin: string | null | undefined): string | null {
  if (typeof pin !== "string") return null
  const clean = pin.trim()
  if (!clean) return null
  if (clean.length < 4 || clean.length > 128) {
    throw new Error("Profile password must be between 4 and 128 characters.")
  }
  return clean
}

function hashPin(
  pin: string,
  salt = crypto.randomBytes(16).toString("hex")
): {
  hash: string
  salt: string
} {
  const hash = crypto
    .pbkdf2Sync(pin, salt, 210_000, 32, "sha256")
    .toString("hex")
  return { hash, salt }
}

function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}
