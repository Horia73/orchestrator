import { NextResponse } from "next/server"

import { getApiKey, getEnvValue } from "@/lib/config"
import {
  LM_STUDIO_API_KEY_ENV,
  scanForLMStudioServers,
} from "@/lib/lm-studio"
import { requireAdminRequestProfile } from "@/lib/profiles/server"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export function POST(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    const body = await request.json().catch(() => ({})) as {
      baseUrl?: unknown
      apiKey?: unknown
    }
    const includeBaseUrl =
      typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : getApiKey("lm-studio")
    const apiKey =
      typeof body.apiKey === "string"
        ? body.apiKey
        : getEnvValue(LM_STUDIO_API_KEY_ENV)
    const results = await scanForLMStudioServers({
      includeBaseUrl,
      apiKey,
      timeoutMs: 650,
      concurrency: 32,
    })
    return NextResponse.json({
      results,
      scannedAt: Date.now(),
    }, { headers: JSON_HEADERS })
  })
}
