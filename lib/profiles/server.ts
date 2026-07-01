import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import {
  PROFILE_SESSION_COOKIE,
  PROFILE_SESSION_MAX_AGE_SECONDS,
} from "./constants"
import { runWithProfileContext } from "./context"
import {
  createProfile,
  createProfileSession,
  deleteProfile,
  deleteProfileSession,
  getProfile,
  getProfileSessionByToken,
  listProfileAuditEvents,
  listProfiles,
  updateProfile,
  verifyProfilePin,
  type CreateProfileInput,
  type UpdateProfileInput,
} from "./store"
import {
  normalizeProfilePermissions,
  type IntegrationAccess,
  type IntegrationPermissionId,
  type ProfileAuditEvent,
  type ProfilePermissions,
  type ProfileRecord,
  type ProfileRole,
  type ProfileSurface,
} from "./types"
import { hasIntegrationAccess } from "./permissions"

export interface CurrentProfile {
  profile: ProfileRecord
  sessionToken: string
  isAdmin: boolean
}

export interface PublicProfile {
  id: string
  name: string
  role: ProfileRole
  color: string
  avatar: string | null
  locked: boolean
  disabledAt: number | null
  createdAt: number
}

export interface AdminProfileView extends PublicProfile {
  permissions: ProfilePermissions
  updatedAt: number
}

export async function getCurrentProfileFromCookies(): Promise<CurrentProfile | null> {
  const cookieStore = await cookies()
  return currentProfileFromToken(cookieStore.get(PROFILE_SESSION_COOKIE)?.value)
}

export function getCurrentProfileFromRequest(
  request: Request
): CurrentProfile | null {
  return currentProfileFromToken(readCookie(request, PROFILE_SESSION_COOKIE))
}

export async function requireAdminProfile(): Promise<
  CurrentProfile | NextResponse
> {
  const current = await getCurrentProfileFromCookies()
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (!current.isAdmin) {
    return NextResponse.json(
      { error: "Admin profile required", code: "admin_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }
  return current
}

export function runWithRequestProfile<T extends Response | Promise<Response>>(
  request: Request,
  fn: (current: CurrentProfile) => T
): T | NextResponse {
  const current = getCurrentProfileFromRequest(request)
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (
    isAdminOnlyApiPath(new URL(request.url).pathname, request.method) &&
    !current.isAdmin
  ) {
    return NextResponse.json(
      { error: "Admin profile required", code: "admin_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }
  const permissionGuard = guardProfileApiPermission(request, current)
  if (permissionGuard) return permissionGuard
  return runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    () => fn(current)
  )
}

export function requireAdminRequestProfile<
  T extends Response | Promise<Response>,
>(request: Request, fn: (current: CurrentProfile) => T): T | NextResponse {
  const current = getCurrentProfileFromRequest(request)
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (!current.isAdmin) {
    return NextResponse.json(
      { error: "Admin profile required", code: "admin_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }
  return runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    () => fn(current)
  )
}

export async function runWithCookieProfile<
  T extends Response | Promise<Response>,
>(fn: (current: CurrentProfile) => T): Promise<Response> {
  const current = await getCurrentProfileFromCookies()
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  return await runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    () => fn(current)
  )
}

export async function runWithAdminCookieProfile<
  T extends Response | Promise<Response>,
>(fn: (current: CurrentProfile) => T): Promise<Response> {
  const current = await getCurrentProfileFromCookies()
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (!current.isAdmin) {
    return NextResponse.json(
      { error: "Admin profile required", code: "admin_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }
  return await runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    () => fn(current)
  )
}

export function runWithOptionalRequestProfile<T>(
  request: Request,
  fn: (current: CurrentProfile | null) => T
): T {
  const current = getCurrentProfileFromRequest(request)
  if (!current) return fn(null)
  return runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    () => fn(current)
  )
}

export function setProfileCookie(response: NextResponse, token: string): void {
  response.cookies.set(PROFILE_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PROFILE_SESSION_MAX_AGE_SECONDS,
  })
}

export function clearProfileCookie(response: NextResponse): void {
  response.cookies.set(PROFILE_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  })
}

export function publicProfile(profile: ProfileRecord): PublicProfile {
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    color: profile.color,
    avatar: profile.avatar,
    locked: Boolean(profile.pinHash),
    disabledAt: profile.disabledAt,
    createdAt: profile.createdAt,
  }
}

export function adminProfileView(profile: ProfileRecord): AdminProfileView {
  return {
    ...publicProfile(profile),
    permissions: profile.permissions,
    updatedAt: profile.updatedAt,
  }
}

export function listPublicProfiles(): PublicProfile[] {
  return listProfiles().map(publicProfile)
}

export function listAdminProfiles(): AdminProfileView[] {
  return listProfiles({ includeDisabled: true }).map(adminProfileView)
}

export function listAdminProfileAuditEvents(options?: {
  profileId?: string
  limit?: number
}): ProfileAuditEvent[] {
  return listProfileAuditEvents(options)
}

export function selectProfileFromBody(
  request: Request,
  body: unknown
): { response: NextResponse; current?: CurrentProfile } {
  const parsed = parseObject(body)
  const profileId =
    typeof parsed.profileId === "string" ? parsed.profileId.trim() : ""
  const password =
    typeof parsed.password === "string"
      ? parsed.password
      : typeof parsed.pin === "string"
        ? parsed.pin
        : null
  const deviceLabel =
    typeof parsed.deviceLabel === "string" ? parsed.deviceLabel.trim() : null
  if (!profileId) {
    return {
      response: NextResponse.json(
        { error: "profileId is required" },
        { status: 400 }
      ),
    }
  }
  const profile = getProfile(profileId)
  if (!profile || profile.disabledAt) {
    return {
      response: NextResponse.json(
        { error: "Profile not found", code: "profile_not_found" },
        { status: 404 }
      ),
    }
  }
  const updated = getProfile(profile.id) ?? profile
  if (!verifyProfilePin(updated, password)) {
    return {
      response: NextResponse.json(
        { error: "Invalid password", code: "invalid_password" },
        { status: 401 }
      ),
    }
  }
  const { token } = createProfileSession({
    profileId: updated.id,
    deviceLabel,
    userAgent: request.headers.get("user-agent"),
  })
  const response = NextResponse.json({
    profile: publicProfile(updated),
    isAdmin: updated.role === "admin",
  })
  setProfileCookie(response, token)
  return {
    response,
    current: {
      profile: updated,
      sessionToken: token,
      isAdmin: updated.role === "admin",
    },
  }
}

export function logoutProfileFromRequest(request: Request): NextResponse {
  deleteProfileSession(readCookie(request, PROFILE_SESSION_COOKIE))
  const response = NextResponse.json({ success: true })
  clearProfileCookie(response)
  return response
}

export function createProfileInputFromBody(
  body: unknown,
  roleOverride?: ProfileRole
): CreateProfileInput {
  const parsed = parseObject(body)
  const role =
    roleOverride ??
    (parsed.role === "admin" || parsed.role === "member"
      ? parsed.role
      : "member")
  return {
    name: typeof parsed.name === "string" ? parsed.name : "",
    role,
    color: typeof parsed.color === "string" ? parsed.color : undefined,
    avatar:
      typeof parsed.avatar === "string" || parsed.avatar === null
        ? parsed.avatar
        : undefined,
    pin:
      typeof parsed.password === "string"
        ? parsed.password
        : typeof parsed.pin === "string"
          ? parsed.pin
          : null,
    permissions: normalizeProfilePermissions(parsed.permissions, role),
  }
}

export function updateProfileInputFromBody(body: unknown): UpdateProfileInput {
  const parsed = parseObject(body)
  const role =
    parsed.role === "admin" || parsed.role === "member"
      ? parsed.role
      : undefined
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    role,
    color: typeof parsed.color === "string" ? parsed.color : undefined,
    avatar:
      typeof parsed.avatar === "string" || parsed.avatar === null
        ? parsed.avatar
        : undefined,
    pin:
      typeof parsed.password === "string"
        ? parsed.password
        : typeof parsed.pin === "string"
          ? parsed.pin
          : undefined,
    clearPin: parsed.clearPassword === true || parsed.clearPin === true,
    permissions: parsed.permissions
      ? normalizeProfilePermissions(parsed.permissions, role ?? "member")
      : undefined,
    disabledAt:
      typeof parsed.disabledAt === "number" || parsed.disabledAt === null
        ? parsed.disabledAt
        : undefined,
  }
}

export const profileStore = {
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
}

function currentProfileFromToken(
  token: string | null | undefined
): CurrentProfile | null {
  const session = getProfileSessionByToken(token)
  if (!session || !token) return null
  const profile = getProfile(session.profileId)
  if (!profile || profile.disabledAt) return null
  return {
    profile,
    sessionToken: token,
    isAdmin: profile.role === "admin",
  }
}

function isAdminOnlyApiPath(pathname: string, method: string): boolean {
  const readOnly = method === "GET" || method === "HEAD"
  return (
    (pathname.startsWith("/api/settings") &&
      pathname !== "/api/settings/bootstrap" &&
      !pathname.startsWith("/api/settings/files") &&
      !pathname.startsWith("/api/settings/skills")) ||
    (pathname.startsWith("/api/config") &&
      !readOnly &&
      !isModelSettingsApiPath(pathname)) ||
    pathname.startsWith("/api/logs") ||
    pathname.startsWith("/api/update") ||
    pathname.startsWith("/api/models") ||
    pathname.startsWith("/api/cli")
  )
}

function isModelSettingsApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/config/agent/") ||
    pathname === "/api/config/agent-order" ||
    pathname === "/api/config/favorites" ||
    pathname === "/api/config/browser-agent" ||
    pathname === "/api/config/browser-agent/pro-enabled"
  )
}

function guardProfileApiPermission(
  request: Request,
  current: CurrentProfile
): NextResponse | null {
  if (current.isAdmin) return null
  const pathname = new URL(request.url).pathname
  const surface = surfaceForApiPath(pathname)
  if (surface && !current.profile.permissions.surfaces[surface]) {
    return NextResponse.json(
      {
        error: "Profile is not allowed to access this surface.",
        code: "profile_surface_denied",
        surface,
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }

  const readOnly = request.method === "GET" || request.method === "HEAD"
  if (
    !readOnly &&
    isModelSettingsApiPath(pathname) &&
    !current.profile.permissions.tools.models
  ) {
    return NextResponse.json(
      {
        error: "Profile is not allowed to change model settings.",
        code: "profile_models_denied",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }

  if (
    pathname.startsWith("/api/settings/files") &&
    !readOnly &&
    !current.profile.permissions.tools.settings_files
  ) {
    return NextResponse.json(
      {
        error: "Profile is not allowed to change settings files.",
        code: "profile_settings_files_denied",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }

  if (
    pathname.startsWith("/api/settings/skills") &&
    !readOnly &&
    !current.profile.permissions.tools.skills
  ) {
    return NextResponse.json(
      {
        error: "Profile is not allowed to manage skills.",
        code: "profile_skills_denied",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }

  const needed = integrationAccessForApiPath(pathname, request.method)
  if (!needed) return null
  if (
    hasIntegrationAccess(
      current.profile.permissions,
      needed.integration,
      needed.access
    )
  ) {
    return null
  }
  return NextResponse.json(
    {
      error: "Profile is not allowed to access this integration.",
      code: "profile_permission_denied",
      integration: needed.integration,
      requiredAccess: needed.access,
    },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  )
}

function surfaceForApiPath(pathname: string): ProfileSurface | null {
  if (
    pathname.startsWith("/api/settings") ||
    pathname.startsWith("/api/usage") ||
    pathname === "/api/integrations/status"
  ) {
    return "settings"
  }
  if (pathname.startsWith("/api/watchlist")) return "watchlist"
  return null
}

function integrationAccessForApiPath(
  pathname: string,
  method: string
): { integration: IntegrationPermissionId; access: IntegrationAccess } | null {
  const writeAccess: IntegrationAccess =
    method === "GET" || method === "HEAD" ? "read" : "write"
  const setupAccess: IntegrationAccess = "setup"

  if (pathname.startsWith("/api/integrations/gmail")) {
    return {
      integration: "gmail",
      access: setupOrRead(pathname, writeAccess, setupAccess),
    }
  }
  if (pathname.startsWith("/api/integrations/google-calendar")) {
    return {
      integration: "google_calendar",
      access: setupOrRead(pathname, writeAccess, setupAccess),
    }
  }
  if (pathname.startsWith("/api/integrations/google-drive")) {
    return {
      integration: "google_drive",
      access: setupOrRead(pathname, writeAccess, setupAccess),
    }
  }
  if (pathname.startsWith("/api/integrations/whatsapp")) {
    return {
      integration: "whatsapp",
      access: setupOrRead(pathname, writeAccess, setupAccess),
    }
  }
  if (pathname.startsWith("/api/integrations/home-assistant")) {
    return {
      integration: "home_assistant",
      access: setupOrRead(pathname, writeAccess, setupAccess),
    }
  }
  if (
    pathname.startsWith("/api/integrations/maps") ||
    pathname.startsWith("/api/maps")
  ) {
    return { integration: "maps", access: writeAccess }
  }
  if (
    pathname.startsWith("/api/library/maps") ||
    pathname.startsWith("/api/library/places")
  ) {
    return { integration: "maps", access: "read" }
  }
  return null
}

function setupOrRead(
  pathname: string,
  fallback: IntegrationAccess,
  setup: IntegrationAccess
): IntegrationAccess {
  return /\/(config|oauth|disconnect|start|qr)(\/|$)/.test(pathname)
    ? setup
    : fallback
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  const parts = header.split(";")
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.trim().split("=")
    if (rawKey !== name) continue
    return decodeURIComponent(rawValue.join("="))
  }
  return null
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
