import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"

const API_GUARD_EXEMPT_PATHS = new Set([
  "/api/cli/mcp-exec",
  "/api/integrations/gmail/oauth/callback",
  "/api/integrations/google/oauth/callback",
  "/api/update/host-result",
])

export function proxy(request: NextRequest) {
  const previewRewrite = maybeRewritePreviewSubrequest(request)
  if (previewRewrite) return previewRewrite

  if (shouldGuardApiRequest(request.nextUrl.pathname, request.method)) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard
  }

  return NextResponse.next()
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

function maybeRewritePreviewSubrequest(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname
  if (pathname.startsWith("/dev-preview/")) return null

  const runId = previewRunIdFromReferer(request.headers.get("referer"))
  if (!runId) return null

  const url = request.nextUrl.clone()
  url.pathname = `/dev-preview/${encodeURIComponent(runId)}${pathname}`
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

export const config = {
  matcher: ["/:path*"],
}
