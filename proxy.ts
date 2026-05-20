import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"

const API_GUARD_EXEMPT_PATHS = new Set([
  "/api/cli/mcp-exec",
  "/api/integrations/gmail/oauth/callback",
  "/api/integrations/google/oauth/callback",
  "/api/update/host-result",
])

export function proxy(request: NextRequest) {
  if (shouldGuardApiRequest(request.nextUrl.pathname)) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard
  }

  return NextResponse.next()
}

function shouldGuardApiRequest(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false
  return !API_GUARD_EXEMPT_PATHS.has(pathname)
}

export const config = {
  matcher: ["/:path*"],
}
