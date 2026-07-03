import { NextResponse } from "next/server"

import { TTS_VOICE_NAMES } from "@/lib/ai/providers/google"
import { getApiKey, getConfig, updateConfig } from "@/lib/config"
import {
  requireAdminRequestProfile,
  runWithRequestProfile,
} from "@/lib/profiles/server"
import { VOICE_DEV_PORT, VOICE_WS_PATH } from "@/lib/voice/gateway"
import { listLiveCapableModels } from "@/lib/voice/model"
import {
  defaultVoiceSettings,
  normalizeVoiceSettings,
} from "@/lib/voice/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
    const settings = getConfig().voice ?? defaultVoiceSettings()
    const configured = !!getApiKey("google")
    return NextResponse.json({
      enabled: settings.enabled,
      configured,
      wsPath: VOICE_WS_PATH,
      devPort: process.env.NODE_ENV === "development" ? VOICE_DEV_PORT : null,
      model: settings.model,
      voiceName: settings.voiceName,
      languageCode: settings.languageCode,
      homeAssistant: settings.homeAssistant,
      rooms: settings.rooms,
      voiceOptions: TTS_VOICE_NAMES,
      liveModels: configured ? await listLiveCapableModels() : [],
    })
  })
}

export async function PATCH(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const current = getConfig().voice ?? defaultVoiceSettings()
    const next = normalizeVoiceSettings({ ...current, ...body })
    updateConfig({ voice: next })
    return NextResponse.json({ voice: next })
  })
}
