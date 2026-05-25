import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"

const API_GUARD_EXEMPT_PATHS = new Set([
  "/api/cli/mcp-exec",
  "/api/integrations/gmail/oauth/callback",
  "/api/integrations/google/oauth/callback",
  "/api/update/host-result",
])

export function proxy(request: NextRequest) {
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

export const config = {
  matcher: ["/:path*"],
}
