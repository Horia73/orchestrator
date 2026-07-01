import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { PROFILE_SESSION_COOKIE } from "@/lib/profiles/constants"

const API_GUARD_EXEMPT_PATHS = new Set([
  "/api/cli/mcp-exec",
  "/api/integrations/gmail/oauth/callback",
  "/api/integrations/google/oauth/callback",
  "/api/integrations/mcp/oauth/callback",
  "/api/update/host-result",
])

const PROFILE_EXEMPT_PATH_PREFIXES = [
  "/profiles",
  "/api/profiles",
  "/api/push/vapid-public-key",
  "/api/update/host-result",
  "/published-apps",
  "/_next",
]

const PROFILE_EXEMPT_EXACT_PATHS = new Set([
  "/api/cli/mcp-exec",
  "/favicon.ico",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/manifest.json",
  "/sw.js",
  "/pdf.worker.min.mjs",
])

export function proxy(request: NextRequest) {
  const previewRewrite = maybeRewritePreviewSubrequest(request)
  if (previewRewrite) return previewRewrite

  const publishedAppApiBlock = maybeBlockPublishedAppApiRequest(request)
  if (publishedAppApiBlock) return publishedAppApiBlock

  const publishedAppRewrite = maybeRewritePublishedAppSubrequest(request)
  if (publishedAppRewrite) return publishedAppRewrite

  const profileGate = maybeGateProfileRequest(request)
  if (profileGate) return profileGate

  if (shouldGuardApiRequest(request.nextUrl.pathname, request.method)) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard
  }

  // Expose the pathname to server components (the root layout reads it to decide
  // the first-run onboarding redirect — middleware runs in the Edge runtime and
  // can't read the workspace state file itself, so the layout does that with the
  // pathname this header carries).
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-pathname", request.nextUrl.pathname)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export function shouldGuardApiRequest(pathname: string, method = "GET"): boolean {
  if (!pathname.startsWith("/api/")) return false
  if (isPublicWebhookIngress(pathname, method)) return false
  return !API_GUARD_EXEMPT_PATHS.has(pathname)
}

function isPublicWebhookIngress(pathname: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false

  const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean)
  return segments.length === 3 && segments[0] === "api" && segments[1] === "webhooks"
}

function maybeGateProfileRequest(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname
  if (isProfileExemptPath(pathname)) return null
  if (isPublicWebhookIngress(pathname, request.method)) return null
  if (request.cookies.get(PROFILE_SESSION_COOKIE)?.value) return null

  // A file download must only ever resolve to file bytes or an honest error —
  // never HTML. Redirecting an unauthenticated /files/* (or /api/*) request to
  // the /profiles picker made the browser save that HTML page under the
  // requested name (e.g. site_plan.pdf), which every PDF reader then reports as
  // a damaged/corrupt file. Answer those with a JSON 401 instead; only real
  // page navigations fall through to the profile picker.
  if (profileGateRespondsWithJson(pathname)) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }

  const url = request.nextUrl.clone()
  url.pathname = "/profiles"
  url.searchParams.set("next", `${pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(url)
}

// Unauthenticated requests to these paths get a JSON 401 rather than an HTML
// redirect to the profile picker. Direct workspace file downloads (/files/*)
// belong here alongside the API: a browser that saves the /profiles HTML under
// the requested filename produces a file that PDF/Office readers report as
// damaged, so a file URL must only ever yield file bytes or an honest error.
export function profileGateRespondsWithJson(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/files/")
}

export function isProfileExemptPath(pathname: string): boolean {
  if (PROFILE_EXEMPT_EXACT_PATHS.has(pathname)) return true
  return PROFILE_EXEMPT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function maybeRewritePreviewSubrequest(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname
  if (pathname.startsWith("/dev-preview/")) return null

  const runId = previewRunIdFromReferer(request.headers.get("referer"))
  if (!runId) return null

  const url = request.nextUrl.clone()
  url.pathname = `/dev-preview/${encodeURIComponent(runId)}${pathname}`
  return NextResponse.rewrite(url)
}

function maybeBlockPublishedAppApiRequest(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname
  if (!pathname.startsWith("/api/")) return null
  if (!publishedAppSlugFromReferer(request.headers.get("referer"))) return null

  return NextResponse.json(
    { error: "Published static apps cannot call Orchestrator API routes." },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  )
}

function maybeRewritePublishedAppSubrequest(request: NextRequest): NextResponse | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null

  const pathname = request.nextUrl.pathname
  if (pathname.startsWith("/published-apps/")) return null
  if (pathname.startsWith("/api/")) return null

  const slug = publishedAppSlugFromReferer(request.headers.get("referer"))
  if (!slug) return null

  const url = request.nextUrl.clone()
  url.pathname = `/published-apps/${encodeURIComponent(slug)}${pathname}`
  return NextResponse.rewrite(url)
}

function previewRunIdFromReferer(value: string | null): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/dev-preview\/([^/?#]+)/)
    if (!match) return null
    const runId = decodeURIComponent(match[1] ?? "")
    return /^[A-Za-z0-9._-]{1,80}$/.test(runId) ? runId : null
  } catch {
    return null
  }
}

function publishedAppSlugFromReferer(value: string | null): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/published-apps\/([^/?#]+)/)
    if (!match) return null
    const slug = decodeURIComponent(match[1] ?? "")
    return /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) ? slug : null
  } catch {
    return null
  }
}

export const config = {
  matcher: ["/((?!api/upload(?:/|$)).*)"],
}
