import { NextResponse } from "next/server"

import { getEnvValue } from "@/lib/config"
import { checkLMStudioServer, LM_STUDIO_API_KEY_ENV } from "@/lib/lm-studio"
import { requireAdminRequestProfile } from "@/lib/profiles/server"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export function POST(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    const body = await request.json().catch(() => ({})) as {
      baseUrl?: unknown
      apiKey?: unknown
    }
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
    const apiKey =
      typeof body.apiKey === "string"
        ? body.apiKey
        : getEnvValue(LM_STUDIO_API_KEY_ENV)
    if (!baseUrl) {
      return NextResponse.json({ error: "LM Studio URL is required." }, { status: 400, headers: JSON_HEADERS })
    }
    const health = await checkLMStudioServer(baseUrl, apiKey, { timeoutMs: 1500 })
    return NextResponse.json(health, { status: health.online ? 200 : 400, headers: JSON_HEADERS })
  })
}
