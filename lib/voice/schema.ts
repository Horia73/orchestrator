import { normalizeTimezone } from "@/lib/timezone"

// Voice mode domain schema: settings stored in config.json under `voice`,
// the client<->gateway wire protocol, and the pure policy helpers (Home
// Assistant guardrails, live-model ranking). Everything here must stay free
// of I/O and Node-only imports so both the smoke test and client bundles can
// use the types.

export interface VoiceRoomConfig {
  id: string
  name: string
  /** Where audio comes from. `browser` is the PWA voice mode; `esphome`
   *  satellites (HA Voice PE / ReSpeaker Lite) arrive with the hardware
   *  phase and are accepted in config now so drivers can plug in later. */
  input: "browser" | "esphome"
  /** Where responses play. `self` = the input device's own speaker (browser
   *  or satellite line-out, which may be wired into a Sonos line-in).
   *  `sonos-audioclip` = LAN audioClip fallback for announcements. */
  output: "self" | "sonos-audioclip"
  /** Sonos player IP/host for the audioclip output. */
  sonosHost?: string
}

export interface VoiceHomeAssistantPolicy {
  /** Domains the live voice agent may control via service calls. */
  allowedDomains: string[]
  /** Domains that are always refused from voice, even if listed above. */
  blockedDomains: string[]
}

export interface VoiceSettings {
  enabled: boolean
  /** Live model id, or "auto" to discover the newest bidi-capable flash. */
  model: string
  /** Prebuilt voice name (same catalog the TTS generator uses). */
  voiceName: string
  /** Optional BCP-47 language hint for output audio; empty = automatic. */
  languageCode: string
  homeAssistant: VoiceHomeAssistantPolicy
  rooms: VoiceRoomConfig[]
}

export const VOICE_DEFAULT_ALLOWED_HA_DOMAINS = [
  "light",
  "switch",
  "media_player",
  "climate",
  "cover",
  "fan",
  "scene",
  "script",
  "vacuum",
  "input_boolean",
]

// Security-relevant domains stay out of the voice surface by default: a voice
// session has no PIN and anyone in the room "is" the user.
export const VOICE_DEFAULT_BLOCKED_HA_DOMAINS = ["lock", "alarm_control_panel"]

export const VOICE_DEFAULT_VOICE_NAME = "Kore"

export function defaultVoiceSettings(): VoiceSettings {
  return {
    enabled: true,
    model: "auto",
    voiceName: VOICE_DEFAULT_VOICE_NAME,
    languageCode: "",
    homeAssistant: {
      allowedDomains: [...VOICE_DEFAULT_ALLOWED_HA_DOMAINS],
      blockedDomains: [...VOICE_DEFAULT_BLOCKED_HA_DOMAINS],
    },
    rooms: [],
  }
}

export function formatVoiceConversationFallbackTitle(
  date: Date | number = new Date(),
  timezone = "UTC"
): string {
  const d = typeof date === "number" ? new Date(date) : date
  const timeLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeTimezone(timezone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d)
  return `Voice chat ${timeLabel}`
}

export function normalizeVoiceSettings(value: unknown): VoiceSettings {
  const defaults = defaultVoiceSettings()
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults
  }
  const parsed = value as Record<string, unknown>
  const ha =
    parsed.homeAssistant && typeof parsed.homeAssistant === "object"
      ? (parsed.homeAssistant as Record<string, unknown>)
      : {}
  return {
    enabled: parsed.enabled !== false,
    model: normalizeToken(parsed.model, defaults.model),
    voiceName: normalizeToken(parsed.voiceName, defaults.voiceName),
    languageCode: normalizeToken(parsed.languageCode, ""),
    homeAssistant: {
      allowedDomains: normalizeDomainList(
        ha.allowedDomains,
        defaults.homeAssistant.allowedDomains
      ),
      // Blocked domains merge with the defaults instead of replacing them so
      // a stale config can never re-open the security domains by omission.
      blockedDomains: Array.from(
        new Set([
          ...defaults.homeAssistant.blockedDomains,
          ...normalizeDomainList(ha.blockedDomains, []),
        ])
      ),
    },
    rooms: normalizeRooms(parsed.rooms),
  }
}

export type VoiceHaVerdict =
  | { allowed: true; domain: string }
  | { allowed: false; domain: string; reason: string }

/** Decide whether the live voice agent may execute a Home Assistant service
 *  call. Domain is taken from the explicit service domain and every entity id
 *  must agree with it — a `light.turn_on` aimed at `lock.front_door` is
 *  refused, not silently forwarded. */
export function evaluateVoiceHaCall(
  policy: VoiceHomeAssistantPolicy,
  domain: string,
  entityIds: string[]
): VoiceHaVerdict {
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain) {
    return { allowed: false, domain: "", reason: "Missing service domain." }
  }
  const domains = new Set([normalizedDomain])
  for (const entityId of entityIds) {
    const entityDomain = entityId.split(".")[0]?.trim().toLowerCase()
    if (entityDomain) domains.add(entityDomain)
  }
  for (const candidate of domains) {
    if (policy.blockedDomains.includes(candidate)) {
      return {
        allowed: false,
        domain: candidate,
        reason: `Domain "${candidate}" is blocked for voice control. Ask the user to do it from the app.`,
      }
    }
  }
  for (const candidate of domains) {
    if (!policy.allowedDomains.includes(candidate)) {
      return {
        allowed: false,
        domain: candidate,
        reason: `Domain "${candidate}" is not in the voice allowlist (Settings → Voice).`,
      }
    }
  }
  return { allowed: true, domain: normalizedDomain }
}

/** Rank live-capable model ids and pick the best default for spoken dialog.
 *  Specialized live variants (translate, transcription, TTS-only) are
 *  excluded — Google's catalog exposes them via the same bidi capability but
 *  they do not hold an assistant conversation. Prefers the highest model
 *  version, then flash variants (latency), then shorter ids (usually the
 *  canonical alias). Pure so the smoke test can pin behavior. */
export function pickBestLiveModel(modelIds: string[]): string | null {
  const candidates = modelIds
    .map((id) => id.replace(/^models\//, "").trim())
    .filter((id) => id && /live|native-audio/i.test(id))
    .filter((id) => !/translate|transcri|tts|image|music|embed/i.test(id))
  if (!candidates.length) return null
  const scored = candidates.map((id) => {
    // The model generation is the number right after "gemini-" (or the first
    // x.y token). Ids also embed dates ("preview-09-2025"), so a global
    // max-of-all-numbers would rank a dated preview above a newer family.
    const family = id.match(/gemini-(\d+(?:\.\d+)?)/i) ?? id.match(/(\d+\.\d+)/)
    return {
      id,
      version: family ? Number.parseFloat(family[1]) : 0,
      flash: /flash/i.test(id) ? 1 : 0,
      native: /native-audio|dialog/i.test(id) ? 1 : 0,
    }
  })
  scored.sort(
    (a, b) =>
      b.version - a.version ||
      b.flash - a.flash ||
      b.native - a.native ||
      a.id.length - b.id.length ||
      a.id.localeCompare(b.id)
  )
  return scored[0].id
}

/** Ordered fallbacks used only when the models listing is unreachable. */
export const VOICE_LIVE_MODEL_FALLBACKS = [
  "gemini-3.1-flash-live-preview",
  "gemini-live-2.5-flash-preview",
  "gemini-2.0-flash-live-001",
]

// --- Client <-> gateway wire protocol -------------------------------------
// Binary WebSocket frames carry raw PCM16 mono audio: client -> gateway at
// 16 kHz, gateway -> client at 24 kHz. JSON text frames carry control.

export interface VoiceClientStart {
  type: "start"
  roomId?: string
}

export interface VoiceClientEnd {
  type: "end"
}

export type VoiceClientMessage = VoiceClientStart | VoiceClientEnd

export type VoiceServerMessage =
  | { type: "ready"; model: string; voiceName: string; conversationId: string }
  | { type: "listening" }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | {
      type: "transcript"
      role: "user" | "assistant"
      text: string
      final: boolean
    }
  | { type: "tool"; name: string; status: "running" | "done" | "error" }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "closed"; reason: string }

export function parseVoiceClientMessage(raw: string): VoiceClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed?.type === "start") {
      return {
        type: "start",
        roomId:
          typeof parsed.roomId === "string" && parsed.roomId.trim()
            ? parsed.roomId.trim()
            : undefined,
      }
    }
    if (parsed?.type === "end") return { type: "end" }
    return null
  } catch {
    return null
  }
}

function normalizeToken(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function normalizeDomainList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => /^[a-z_][a-z0-9_]*$/.test(item))
  return cleaned.length ? Array.from(new Set(cleaned)) : [...fallback]
}

function normalizeRooms(value: unknown): VoiceRoomConfig[] {
  if (!Array.isArray(value)) return []
  const rooms: VoiceRoomConfig[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const parsed = item as Record<string, unknown>
    const id = normalizeToken(parsed.id, "")
    const name = normalizeToken(parsed.name, "")
    if (!id || !name) continue
    rooms.push({
      id,
      name,
      input: parsed.input === "esphome" ? "esphome" : "browser",
      output: parsed.output === "sonos-audioclip" ? "sonos-audioclip" : "self",
      sonosHost:
        typeof parsed.sonosHost === "string" && parsed.sonosHost.trim()
          ? parsed.sonosHost.trim()
          : undefined,
    })
  }
  return rooms
}
