import { NextResponse, type NextRequest } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method.toUpperCase())
  ) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/:path*"],
}
