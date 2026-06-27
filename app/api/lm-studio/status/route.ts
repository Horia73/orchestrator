import { NextResponse } from "next/server"

import { getApiKey, getEnvValue } from "@/lib/config"
import {
  checkLMStudioServer,
  LM_STUDIO_API_KEY_ENV,
  type LMStudioStatus,
} from "@/lib/lm-studio"
import { requireAdminRequestProfile } from "@/lib/profiles/server"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export function GET(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    const baseUrl = getApiKey("lm-studio")
    const apiKey = getEnvValue(LM_STUDIO_API_KEY_ENV)
    if (!baseUrl) {
      return NextResponse.json({
        configured: false,
        apiKeyConfigured: Boolean(apiKey),
        baseUrl: "",
        online: false,
        checkedAt: Date.now(),
        latencyMs: null,
        modelCount: null,
        models: [],
        endpoint: null,
        error: null,
      } satisfies LMStudioStatus, { headers: JSON_HEADERS })
    }

    const health = await checkLMStudioServer(baseUrl, apiKey, { timeoutMs: 1200 })
    return NextResponse.json({
      ...health,
      configured: true,
      apiKeyConfigured: Boolean(apiKey),
    } satisfies LMStudioStatus, { headers: JSON_HEADERS })
  })
}
