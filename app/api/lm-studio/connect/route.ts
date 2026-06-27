import { NextResponse } from "next/server"

import { getEnvValue } from "@/lib/config"
import { fetchLMStudioModels } from "@/lib/models/fetcher"
import { readLiveRegistry, writeLiveRegistry } from "@/lib/models/store"
import { invalidateRegistryCache } from "@/lib/models/registry"
import {
  checkLMStudioServer,
  clearLMStudioConfig,
  LM_STUDIO_API_KEY_ENV,
  saveLMStudioConfig,
} from "@/lib/lm-studio"
import { requireAdminRequestProfile } from "@/lib/profiles/server"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export function POST(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    const body = await request.json().catch(() => ({})) as {
      baseUrl?: unknown
      apiKey?: unknown
    }
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : ""
    const providedApiKey = typeof body.apiKey === "string" ? body.apiKey : undefined
    const apiKey = providedApiKey ?? getEnvValue(LM_STUDIO_API_KEY_ENV)
    if (!baseUrl) {
      return NextResponse.json({ error: "LM Studio URL is required." }, { status: 400, headers: JSON_HEADERS })
    }

    const health = await checkLMStudioServer(baseUrl, apiKey, { timeoutMs: 1500 })
    if (!health.online) {
      return NextResponse.json({
        error: health.error ?? "LM Studio is not reachable.",
        status: health,
      }, { status: 400, headers: JSON_HEADERS })
    }

    const normalizedBaseUrl = saveLMStudioConfig({
      baseUrl: health.baseUrl,
      apiKey: providedApiKey,
    })
    const live = readLiveRegistry()
    const entry = await fetchLMStudioModels(normalizedBaseUrl, apiKey)
    live.providers["lm-studio"] = entry
    writeLiveRegistry(live)
    invalidateRegistryCache()

    return NextResponse.json({
      success: true,
      status: {
        ...health,
        baseUrl: normalizedBaseUrl,
        configured: true,
        apiKeyConfigured: Boolean(apiKey),
      },
      fetched: Object.keys(entry.models).length,
    }, { headers: JSON_HEADERS })
  })
}

export function DELETE(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    clearLMStudioConfig()
    const live = readLiveRegistry()
    if (live.providers["lm-studio"]) {
      delete live.providers["lm-studio"]
      writeLiveRegistry(live)
      invalidateRegistryCache()
    }
    return NextResponse.json({ success: true }, { headers: JSON_HEADERS })
  })
}
