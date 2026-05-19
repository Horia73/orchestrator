import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const HTTPS_UPGRADE_HOSTS = new Set(["orchestrator.lan"])

export function proxy(request: NextRequest) {
  const upgrade = httpsUpgradeResponse(request)
  if (upgrade) return upgrade

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method.toUpperCase())
  ) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard
  }

  return NextResponse.next()
}

function httpsUpgradeResponse(request: NextRequest): NextResponse | null {
  const hostname = request.nextUrl.hostname.trim().toLowerCase()
  if (!HTTPS_UPGRADE_HOSTS.has(hostname)) return null

  const proto =
    firstHeaderValue(request.headers.get("x-forwarded-proto")) ??
    request.nextUrl.protocol.replace(":", "")
  if (proto.toLowerCase() === "https") return null

  const url = request.nextUrl.clone()
  url.protocol = "https:"
  url.hostname = hostname
  url.port = ""

  return NextResponse.redirect(url, 308)
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null
}

export const config = {
  matcher: ["/:path*"],
}
