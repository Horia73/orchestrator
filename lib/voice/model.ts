// Live-model discovery for voice mode. "auto" resolves against the Gemini
// models listing (filtered to bidiGenerateContent-capable ids) so new live
// model generations are picked up without a code change; the hardcoded
// fallbacks only matter when the listing itself is unreachable.

import { getApiKey, getConfig } from "@/lib/config"
import {
  pickBestLiveModel,
  VOICE_LIVE_MODEL_FALLBACKS,
  defaultVoiceSettings,
} from "@/lib/voice/schema"

const MODELS_LIST_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000
const DISCOVERY_TIMEOUT_MS = 7_000

interface DiscoveryCache {
  fetchedAt: number
  liveModelIds: string[]
}

let discoveryCache: DiscoveryCache | null = null

export async function resolveVoiceLiveModel(): Promise<string> {
  const settings = getConfig().voice ?? defaultVoiceSettings()
  if (settings.model && settings.model !== "auto") return settings.model

  const discovered = await listLiveCapableModels()
  const best = pickBestLiveModel(discovered)
  if (best) return best
  return VOICE_LIVE_MODEL_FALLBACKS[0]
}

export async function listLiveCapableModels(): Promise<string[]> {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.liveModelIds
  }
  const apiKey = getApiKey("google")
  if (!apiKey) return discoveryCache?.liveModelIds ?? []
  try {
    const ids: string[] = []
    let pageToken = ""
    // The listing is paginated; two pages cover the catalog comfortably and
    // keep the worst case bounded.
    for (let page = 0; page < 3; page += 1) {
      const url = new URL(MODELS_LIST_ENDPOINT)
      url.searchParams.set("key", apiKey)
      url.searchParams.set("pageSize", "200")
      if (pageToken) url.searchParams.set("pageToken", pageToken)
      const response = await fetch(url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`models list ${response.status}`)
      const body = (await response.json()) as {
        models?: Array<{
          name?: string
          supportedGenerationMethods?: string[]
        }>
        nextPageToken?: string
      }
      for (const model of body.models ?? []) {
        const name = model.name?.replace(/^models\//, "") ?? ""
        if (!name) continue
        if (model.supportedGenerationMethods?.includes("bidiGenerateContent")) {
          ids.push(name)
        }
      }
      pageToken = body.nextPageToken ?? ""
      if (!pageToken) break
    }
    discoveryCache = { fetchedAt: now, liveModelIds: ids }
    return ids
  } catch (err) {
    console.error("[voice] live model discovery failed", err)
    return discoveryCache?.liveModelIds ?? []
  }
}
