import path from "path"
import fs from "fs"

import {
  type ThinkingLevel,
  type ModelPricing,
  type ModelFeatureValue,
  type EffectiveProviderEntry,
  type EffectiveModelEntry,
} from "@/lib/models/schema"
import {
  getEffectiveRegistry,
  getEffectiveProvider,
  getEffectiveModel,
  effectiveModelExists,
} from "@/lib/models/registry"
import {
  parseBrowserBackendPreference,
  resolveBrowserBackend,
  type BrowserBackendResolution,
} from "@/lib/browser-agent-backend"
import type { BrowserBackendPreference } from "@/lib/browser-agent-runtime/config"
import { emitAppEvent } from "@/lib/events"
import { normalizeVoiceSettings, type VoiceSettings } from "@/lib/voice/schema"
import {
  getActiveProfileId,
  isAdminProfileId,
  runWithProfileContext,
} from "@/lib/profiles/context"
import { ADMIN_PROFILE_ID } from "@/lib/profiles/constants"
import { getProfile, listProfiles } from "@/lib/profiles/store"
import {
  activeRuntimePaths,
  ORCHESTRATOR_STATE_DIR,
  PROJECT_DIR,
  runtimePathsForProfile,
} from "@/lib/runtime-paths"
import { normalizeTimezone, systemTimezone } from "@/lib/timezone"

export {
  AGENT_WORKSPACE_DIR,
  ARTIFACTS_DIR,
  ORCHESTRATOR_STATE_DIR,
  PRIVATE_STATE_DIR,
  PROJECT_DIR,
  UPLOADS_DIR,
  WORKSPACE_DIR,
  WORKSPACE_ENV_PATH,
} from "@/lib/runtime-paths"

function legacyConfigPath(): string {
  return path.join(
    /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
    "config.json"
  )
}

function activeConfigPath(): string {
  return configPathForProfile(getActiveProfileId())
}

function configPathForProfile(profileId: string): string {
  return path.join(
    /* turbopackIgnore: true */ runtimePathsForProfile(profileId).workspaceDir,
    "config.json"
  )
}
const PROJECT_ENV_PATHS = [
  path.join(/* turbopackIgnore: true */ PROJECT_DIR, ".env.local"),
  path.join(/* turbopackIgnore: true */ PROJECT_DIR, ".env"),
]
const PROVIDER_API_KEY_ALIASES: Record<string, string[]> = {
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
}

// ---------------------------------------------------------------------------
// Re-exports from the canonical schema in lib/models/schema.ts
// Older code referenced these via @/lib/config; keep the imports alive.
// ---------------------------------------------------------------------------

export type { ThinkingLevel, ModelPricing, ModelFeatureValue }
/** @deprecated import EffectiveModelEntry from @/lib/models/schema instead */
export type ModelDef = EffectiveModelEntry
/** @deprecated import EffectiveProviderEntry from @/lib/models/schema instead */
export type ProviderDef = EffectiveProviderEntry

/**
 * @deprecated prefer `getEffectiveRegistry()` from `@/lib/models/registry`.
 *
 * Kept for incremental migration of consumers that still expect a static
 * record-shaped object. Each top-level key access proxies to the live
 * effective registry, so reads always reflect the latest curated/live state.
 */
export const PROVIDERS = new Proxy(
  {} as Record<string, EffectiveProviderEntry>,
  {
    get(_target, key) {
      if (typeof key !== "string") return undefined
      return getEffectiveRegistry()[key]
    },
    has(_target, key) {
      if (typeof key !== "string") return false
      return key in getEffectiveRegistry()
    },
    ownKeys() {
      return Object.keys(getEffectiveRegistry())
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string") return undefined
      const reg = getEffectiveRegistry()
      if (!(key in reg)) return undefined
      return {
        configurable: true,
        enumerable: true,
        value: reg[key],
        writable: false,
      }
    },
  }
)

// ---------------------------------------------------------------------------
// App config (persisted in workspace/config.json)
// ---------------------------------------------------------------------------

export interface AgentOverride {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
  modelOptions?: Record<string, ModelFeatureValue>
  fallbacks?: AgentFallback[]
}

export interface AgentFallback {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
}

export type BrowserAgentModelSlot = "light" | "pro"

export interface BrowserAgentModelSettings {
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  modelOptions?: Record<string, ModelFeatureValue>
}

export interface BrowserAgentSettings {
  backend: BrowserBackendPreference
  light: BrowserAgentModelSettings
  pro: BrowserAgentModelSettings
  /**
   * When false (default), the browser agent runs solo on the light model with
   * no escalation path ("single mode"). When true, the light model can escalate
   * to the pro model on hard blockers ("multi mode").
   */
  proEnabled: boolean
}

export interface SmartMonitorQuietHours {
  from: string // "HH:MM"
  to: string // "HH:MM"
  timezone: string // IANA, e.g. "Europe/Bucharest"
}

export interface SmartMonitorLiveLocationSource {
  provider: "home-assistant"
  entityId: string
  label?: string
  confirmedAt: number
}

export interface SmartMonitorSettings {
  /** Global default quiet hours for Smart Monitor wakes. Per-watch
   *  notify.quietHours overrides this when set. */
  quietHours?: SmartMonitorQuietHours
  /** Confirmed live location source used by Smart Maps and location-aware monitors. */
  liveLocationSource?: SmartMonitorLiveLocationSource
}

export type LocationIntelligenceSourceType =
  | "home-assistant-webhook"
  | "home-assistant"
  | "manual"
  | "unknown"

export type LocationIntelligenceMapsMode = "strict" | "balanced" | "relaxed"

export interface LocationIntelligenceSettings {
  /** User opt-in gate. When false or absent, no location journal is read. */
  enabled: boolean
  /** Non-secret upstream source metadata. */
  source: {
    type: LocationIntelligenceSourceType
    entityId?: string
    label?: string
  }
  /** Microscript whose workspace contains files/location/*. */
  journalScriptId?: string
  /** Optional scheduled agent task that analyzes the journal daily. */
  dailyTaskId?: string
  /** Use "forever" to keep everything; otherwise use retentionDays. */
  retention?: "forever"
  retentionDays?: number
  mapsMode: LocationIntelligenceMapsMode
}

/** Semantic-memory embedding configuration, editable from Settings. */
export interface MemoryEmbeddingSettings {
  /** Master switch for automatic recall + the memory_search tool. */
  enabled: boolean
  /** Embedding provider. */
  provider: "google" | "openai"
  /** Model id, e.g. "gemini-embedding-2". */
  model: string
  /** Output dimensionality (768 | 1536 | 3072 — Matryoshka truncation). */
  dim: number
  /** Cosine threshold (0..1) for the automatic per-turn recall pass. */
  threshold: number
}

export interface AppConfig {
  assistantName: string
  userName: string
  /** App-wide IANA timezone used for relative dates, daily memory, and default schedules. */
  timezone: string
  /** Global default — used when an agent has no override */
  activeProvider: string
  activeModel: string
  thinkingLevel: ThinkingLevel
  /** Per-agent model/thinking overrides. Keyed by agent id. */
  agentOverrides: Record<string, AgentOverride>
  /** Agent settings display order. Unknown/new agents are reconciled by the UI. */
  agentOrder: string[]
  /** Browser automation uses a light model first and escalates to the pro model when stuck. */
  browserAgent: BrowserAgentSettings
  /** Favorite models, in display order. Each entry is "providerId:modelId". */
  favorites: string[]
  /** Smart Monitor app-wide settings (quiet hours, future flags). */
  smartMonitor?: SmartMonitorSettings
  /** Semantic memory embedding settings. Absent => env/defaults apply. */
  memoryEmbedding?: MemoryEmbeddingSettings
  /** Optional location history intelligence. Absent by default; user opt-in only. */
  locationIntelligence?: LocationIntelligenceSettings
  /** Live voice mode (Gemini Live gateway). Absent => defaults apply. */
  voice?: VoiceSettings
  updatedAt: number
}

// --- Full runtime config (config.json + env-derived) ---

export interface RuntimeConfig extends AppConfig {
  /** Whether the active provider's API key is set in the environment */
  apiKeyConfigured: boolean
  /** Masked API key for display, e.g. "sk-...abc" */
  apiKeyMasked: string | null
  /** The active model definition */
  model: ModelDef | null
  /** The active provider definition */
  provider: ProviderDef | null
  /** Browser backend preference and effective backend. */
  browserAgentBackend: BrowserBackendResolution
}

// ---------------------------------------------------------------------------
// File support metadata — stays here for now (not part of the registry).
// Will move to the registry once Anthropic/etc are added with their own
// supported MIME sets.
// ---------------------------------------------------------------------------

interface ProviderFileSupport {
  /** All supported MIME types grouped by category */
  supportedMimeTypes: {
    image: string[]
    audio: string[]
    video: string[]
    document: string[]
  }
  /** Limits for file uploads */
  limits: {
    /** Max bytes for inline base64 per request */
    inlineMaxBytes: number
    /** Max bytes per PDF */
    pdfMaxBytes: number
    /** Max pages per PDF */
    pdfMaxPages: number
    /** Max images per request */
    maxImagesPerRequest: number
    /** Max videos per request */
    maxVideosPerRequest: number
    /** Max total audio seconds per request */
    maxAudioTotalSeconds: number
  }
}

const PROVIDER_FILE_SUPPORT: Record<string, ProviderFileSupport> = {
  google: {
    supportedMimeTypes: {
      image: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/heic",
        "image/heif",
      ],
      audio: [
        "audio/wav",
        "audio/mp3",
        "audio/mpeg",
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/l16",
        "audio/s16le",
        "audio/opus",
        "audio/alaw",
        "audio/mulaw",
      ],
      video: [
        "video/mp4",
        "video/mpeg",
        "video/mpg",
        "video/mov",
        "video/avi",
        "video/x-flv",
        "video/webm",
        "video/wmv",
        "video/3gpp",
      ],
      document: ["application/pdf", "text/plain"],
    },
    limits: {
      inlineMaxBytes: 20 * 1024 * 1024,
      pdfMaxBytes: 50 * 1024 * 1024,
      pdfMaxPages: 1000,
      maxImagesPerRequest: 3600,
      maxVideosPerRequest: 10,
      maxAudioTotalSeconds: 9.5 * 60 * 60,
    },
  },
  // Future: anthropic, openai, etc.
}

/** Check if a MIME type is natively supported by a provider */
export function isFileSupportedByProvider(
  provider: string,
  mimeType: string
): boolean {
  const support = PROVIDER_FILE_SUPPORT[provider]
  if (!support) return false
  const all = [
    ...support.supportedMimeTypes.image,
    ...support.supportedMimeTypes.audio,
    ...support.supportedMimeTypes.video,
    ...support.supportedMimeTypes.document,
  ]
  // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm")
  const baseMime = mimeType.split(";")[0].trim().toLowerCase()
  return all.includes(baseMime)
}

// ---------------------------------------------------------------------------
// Defaults + persistence for AppConfig
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_AGENT_SETTINGS: BrowserAgentSettings = {
  backend: "patchright",
  light: {
    provider: "google",
    model: "gemini-3-flash-preview",
    thinkingLevel: "low",
    modelOptions: {
      media_resolution: "media_resolution_high",
    },
  },
  pro: {
    provider: "google",
    model: "gemini-3.1-pro-preview",
    thinkingLevel: "high",
    modelOptions: {
      media_resolution: "media_resolution_high",
    },
  },
  proEnabled: false,
}

const ADMIN_DEFAULT_USER_NAME = "Horia"
const MEMBER_DEFAULT_USER_NAME = "User"

const DEFAULT_CONFIG: AppConfig = {
  assistantName: "Orchestrator",
  userName: ADMIN_DEFAULT_USER_NAME,
  timezone: systemTimezone(),
  activeProvider: "google",
  activeModel: "gemini-3-flash-preview",
  thinkingLevel: "high",
  agentOverrides: {},
  agentOrder: [],
  browserAgent: DEFAULT_BROWSER_AGENT_SETTINGS,
  favorites: [],
  // smartMonitor stays undefined by default — users opt into quiet hours;
  // we never invent them on their behalf.
  updatedAt: Date.now(),
}

function defaultConfigForProfile(profileId = getActiveProfileId()): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    userName: isAdminProfileId(profileId)
      ? ADMIN_DEFAULT_USER_NAME
      : MEMBER_DEFAULT_USER_NAME,
    updatedAt: Date.now(),
  }
}

function ensureRuntimeFiles(): void {
  const paths = activeRuntimePaths()

  if (!fs.existsSync(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR)) {
    fs.mkdirSync(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, {
      recursive: true,
    })
  }

  for (const dir of [paths.uploadsDir, paths.workspaceDir]) {
    if (!fs.existsSync(/* turbopackIgnore: true */ dir)) {
      fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true })
    }
  }

  if (!fs.existsSync(/* turbopackIgnore: true */ paths.privateStateDir)) {
    fs.mkdirSync(/* turbopackIgnore: true */ paths.privateStateDir, {
      recursive: true,
    })
    try {
      fs.chmodSync(/* turbopackIgnore: true */ paths.privateStateDir, 0o700)
    } catch {
      // Some filesystems ignore chmod; the directory remains inside .orchestrator.
    }
  }

  const configPath = activeConfigPath()
  const legacy = legacyConfigPath()
  if (
    paths.profileId === ADMIN_PROFILE_ID &&
    !fs.existsSync(/* turbopackIgnore: true */ configPath) &&
    fs.existsSync(/* turbopackIgnore: true */ legacy)
  ) {
    fs.copyFileSync(/* turbopackIgnore: true */ legacy, configPath)
  }

  if (!fs.existsSync(/* turbopackIgnore: true */ configPath)) {
    fs.writeFileSync(
      /* turbopackIgnore: true */ configPath,
      JSON.stringify(seedConfigForProfile(paths.profileId), null, 2),
      "utf-8"
    )
  } else {
    migrateLegacyMemberConfigFile(paths.profileId, configPath)
  }
}

ensureRuntimeFiles()

export function getConfig(): AppConfig {
  try {
    ensureRuntimeFiles()
    const data = fs.readFileSync(activeConfigPath(), "utf-8")
    const parsed = JSON.parse(data)
    // Merge with defaults so new fields get their default values
    return normalizeAppConfig(parsed)
  } catch (e) {
    console.error("Failed to read config, returning default", e)
    return defaultConfigForProfile()
  }
}

function getAdminConfig(): AppConfig {
  const raw = readRawConfigForProfile(ADMIN_PROFILE_ID)
  return normalizeAppConfigForProfile(raw ?? defaultConfigForProfile(ADMIN_PROFILE_ID), ADMIN_PROFILE_ID)
}

function normalizeAppConfig(parsed: Partial<AppConfig>): AppConfig {
  return normalizeAppConfigForProfile(parsed, getActiveProfileId())
}

function normalizeAppConfigForProfile(
  parsed: Partial<AppConfig>,
  profileId: string
): AppConfig {
  const defaults = defaultConfigForProfile(profileId)
  const timezone = normalizeTimezone(
    (parsed as { timezone?: unknown }).timezone,
    defaults.timezone
  )
  const active = normalizeModelSelection(
    parsed.activeProvider,
    parsed.activeModel,
    defaults.activeProvider,
    defaults.activeModel
  )
  return {
    ...defaults,
    ...parsed,
    activeProvider: active.provider,
    activeModel: active.model,
    userName: normalizeUserName(parsed.userName, defaults.userName, profileId),
    timezone,
    agentOverrides: normalizeAgentOverrides(parsed.agentOverrides),
    agentOrder: normalizeStringList(
      (parsed as { agentOrder?: unknown }).agentOrder
    ),
    browserAgent: normalizeBrowserAgentSettings(parsed.browserAgent),
    smartMonitor: normalizeSmartMonitorSettings(parsed.smartMonitor),
    locationIntelligence: normalizeLocationIntelligenceSettings(
      (parsed as { locationIntelligence?: unknown }).locationIntelligence
    ),
    memoryEmbedding: normalizeMemoryEmbeddingSettings(
      (parsed as { memoryEmbedding?: unknown }).memoryEmbedding
    ),
    voice: normalizeVoiceSettings((parsed as { voice?: unknown }).voice),
  }
}

function seedConfigForProfile(profileId: string): AppConfig {
  const defaults = defaultConfigForProfile(profileId)
  if (isAdminProfileId(profileId)) return defaults

  const adminConfig = readRawConfigForProfile(ADMIN_PROFILE_ID)
  if (!adminConfig) return defaults
  const admin = normalizeAppConfigForProfile(adminConfig, ADMIN_PROFILE_ID)

  return normalizeAppConfigForProfile(
    {
      ...defaults,
      assistantName: admin.assistantName,
      timezone: admin.timezone,
      activeProvider: admin.activeProvider,
      activeModel: admin.activeModel,
      thinkingLevel: admin.thinkingLevel,
      agentOverrides: admin.agentOverrides,
      agentOrder: admin.agentOrder,
      browserAgent: admin.browserAgent,
      favorites: admin.favorites,
      memoryEmbedding: admin.memoryEmbedding,
      updatedAt: Date.now(),
    },
    profileId
  )
}

function readRawConfigForProfile(profileId: string): Partial<AppConfig> | null {
  const candidates = [configPathForProfile(profileId)]
  if (isAdminProfileId(profileId)) candidates.push(legacyConfigPath())
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(/* turbopackIgnore: true */ candidate)) continue
      const parsed = JSON.parse(
        fs.readFileSync(/* turbopackIgnore: true */ candidate, "utf-8")
      )
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Partial<AppConfig>
      }
    } catch {
      continue
    }
  }
  return null
}

function migrateLegacyMemberConfigFile(
  profileId: string,
  configPath: string
): void {
  if (isAdminProfileId(profileId)) return
  let parsed: Partial<AppConfig>
  try {
    parsed = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ configPath, "utf-8")
    ) as Partial<AppConfig>
  } catch {
    return
  }
  if (!isLegacyMemberDefaultConfig(parsed)) return

  const seed = seedConfigForProfile(profileId)
  const next = normalizeAppConfigForProfile(
    {
      ...parsed,
      userName: MEMBER_DEFAULT_USER_NAME,
      assistantName: seed.assistantName,
      timezone: seed.timezone,
      activeProvider: seed.activeProvider,
      activeModel: seed.activeModel,
      thinkingLevel: seed.thinkingLevel,
      agentOverrides: seed.agentOverrides,
      agentOrder: seed.agentOrder,
      browserAgent: seed.browserAgent,
      favorites: seed.favorites,
      memoryEmbedding: seed.memoryEmbedding,
      updatedAt: Date.now(),
    },
    profileId
  )
  try {
    fs.writeFileSync(
      /* turbopackIgnore: true */ configPath,
      JSON.stringify(next, null, 2),
      "utf-8"
    )
  } catch {
    // Config read still normalizes safely even if this best-effort migration
    // cannot persist (permissions, read-only filesystem, etc.).
  }
}

function isLegacyMemberDefaultConfig(parsed: Partial<AppConfig>): boolean {
  return (
    parsed.userName === ADMIN_DEFAULT_USER_NAME &&
    (parsed.activeProvider === undefined ||
      parsed.activeProvider === DEFAULT_CONFIG.activeProvider) &&
    (parsed.activeModel === undefined ||
      parsed.activeModel === DEFAULT_CONFIG.activeModel)
  )
}

function normalizeUserName(
  value: unknown,
  fallback: string,
  profileId: string
): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed || trimmed === MEMBER_DEFAULT_USER_NAME) return fallback
  if (!isAdminProfileId(profileId) && trimmed === ADMIN_DEFAULT_USER_NAME) {
    return fallback
  }
  return trimmed
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeAgentOverrides(
  value: unknown
): Record<string, AgentOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_CONFIG.agentOverrides
  }

  const out: Record<string, AgentOverride> = {}
  for (const [agentId, rawOverride] of Object.entries(value)) {
    if (
      typeof agentId !== "string" ||
      !agentId.trim() ||
      !rawOverride ||
      typeof rawOverride !== "object" ||
      Array.isArray(rawOverride)
    ) {
      continue
    }

    const raw = rawOverride as Record<string, unknown>
    const provider = normalizeOptionalString(raw.provider, 96)
    const model = normalizeOptionalString(raw.model, 160)
    if (!provider || !model) continue
    if (!effectiveModelExists(provider, model)) continue

    const override: AgentOverride = { provider, model }
    if (typeof raw.thinkingLevel === "string") {
      override.thinkingLevel = raw.thinkingLevel
    }
    if (isModelOptionsRecord(raw.modelOptions)) {
      override.modelOptions = raw.modelOptions
    }
    const fallbacks = normalizeAgentFallbacks(raw.fallbacks)
    if (fallbacks.length > 0) override.fallbacks = fallbacks
    out[agentId] = override
  }

  return out
}

function normalizeAgentFallbacks(value: unknown): AgentFallback[] {
  if (!Array.isArray(value)) return []
  const out: AgentFallback[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const provider = normalizeOptionalString(raw.provider, 96)
    const model = normalizeOptionalString(raw.model, 160)
    if (!provider || !model) continue
    if (!effectiveModelExists(provider, model)) continue
    const key = `${provider}:${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const fallback: AgentFallback = { provider, model }
    if (typeof raw.thinkingLevel === "string") {
      fallback.thinkingLevel = raw.thinkingLevel
    }
    out.push(fallback)
    if (out.length >= 2) break
  }
  return out
}

function normalizeModelSelection(
  providerValue: unknown,
  modelValue: unknown,
  fallbackProvider: string,
  fallbackModel: string
): { provider: string; model: string } {
  const provider = typeof providerValue === "string" ? providerValue : ""
  const model = typeof modelValue === "string" ? modelValue : ""
  if (provider && model && effectiveModelExists(provider, model)) {
    return { provider, model }
  }
  if (effectiveModelExists(fallbackProvider, fallbackModel)) {
    return { provider: fallbackProvider, model: fallbackModel }
  }

  const registry = getEffectiveRegistry()
  for (const [providerId, providerDef] of Object.entries(registry)) {
    const modelId = Object.keys(providerDef.models)[0]
    if (modelId) return { provider: providerId, model: modelId }
  }
  return { provider: fallbackProvider, model: fallbackModel }
}

function isModelOptionsRecord(
  value: unknown
): value is Record<string, ModelFeatureValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, optionValue]) =>
        /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) &&
        (typeof optionValue === "boolean" ||
          typeof optionValue === "string" ||
          typeof optionValue === "number")
    )
  )
}

function normalizeSmartMonitorSettings(
  value: unknown
): SmartMonitorSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const raw = value as Partial<SmartMonitorSettings>
  const next: SmartMonitorSettings = {}

  const qh = raw.quietHours
  if (qh && typeof qh === "object" && !Array.isArray(qh)) {
    const from = typeof qh.from === "string" ? qh.from.trim() : ""
    const to = typeof qh.to === "string" ? qh.to.trim() : ""
    const timezone = typeof qh.timezone === "string" ? qh.timezone.trim() : ""
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
    if (HHMM.test(from) && HHMM.test(to) && timezone.length > 0) {
      next.quietHours = { from, to, timezone }
    }
  }

  const liveLocationSource = raw.liveLocationSource
  if (
    liveLocationSource &&
    typeof liveLocationSource === "object" &&
    !Array.isArray(liveLocationSource)
  ) {
    const provider = liveLocationSource.provider
    const entityId =
      typeof liveLocationSource.entityId === "string"
        ? liveLocationSource.entityId.trim()
        : ""
    const label =
      typeof liveLocationSource.label === "string"
        ? liveLocationSource.label.trim()
        : ""
    const confirmedAt =
      typeof liveLocationSource.confirmedAt === "number" &&
      Number.isFinite(liveLocationSource.confirmedAt)
        ? liveLocationSource.confirmedAt
        : Date.now()
    if (
      provider === "home-assistant" &&
      /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(entityId)
    ) {
      next.liveLocationSource = {
        provider,
        entityId,
        confirmedAt,
        ...(label ? { label } : {}),
      }
    }
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function normalizeLocationIntelligenceSettings(
  value: unknown
): LocationIntelligenceSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const raw = value as Record<string, unknown>
  const enabled = raw.enabled === true
  const sourceRaw =
    raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)
      ? (raw.source as Record<string, unknown>)
      : {}

  const sourceType = normalizeLocationIntelligenceSourceType(sourceRaw.type)
  const entityId = normalizeOptionalString(sourceRaw.entityId, 160)
  const sourceLabel = normalizeOptionalString(sourceRaw.label, 120)
  const journalScriptId = normalizeScriptId(raw.journalScriptId)
  const dailyTaskId = normalizeScheduledTaskId(raw.dailyTaskId)
  const retention =
    raw.retention === "forever" || raw.retention === "keep_everything"
      ? "forever"
      : undefined
  const retentionDays =
    retention === "forever"
      ? undefined
      : normalizeRetentionDays(raw.retentionDays)
  const mapsMode = normalizeLocationIntelligenceMapsMode(raw.mapsMode)

  return {
    enabled,
    source: {
      type: sourceType,
      ...(entityId ? { entityId } : {}),
      ...(sourceLabel ? { label: sourceLabel } : {}),
    },
    ...(journalScriptId ? { journalScriptId } : {}),
    ...(dailyTaskId ? { dailyTaskId } : {}),
    ...(retention ? { retention } : {}),
    ...(retentionDays ? { retentionDays } : {}),
    mapsMode,
  }
}

function normalizeLocationIntelligenceSourceType(
  value: unknown
): LocationIntelligenceSourceType {
  return value === "home-assistant-webhook" ||
    value === "home-assistant" ||
    value === "manual" ||
    value === "unknown"
    ? value
    : "unknown"
}

function normalizeLocationIntelligenceMapsMode(
  value: unknown
): LocationIntelligenceMapsMode {
  return value === "strict" || value === "relaxed" || value === "balanced"
    ? value
    : "balanced"
}

function normalizeOptionalString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function normalizeScriptId(value: unknown): string {
  const trimmed = normalizeOptionalString(value, 96)
  return /^ms_[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : ""
}

function normalizeScheduledTaskId(value: unknown): string {
  const trimmed = normalizeOptionalString(value, 96)
  return /^sch_[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : ""
}

function normalizeRetentionDays(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const days = Math.floor(value)
  if (days < 1) return undefined
  return Math.min(days, 3650)
}

function normalizeBrowserAgentSettings(value: unknown): BrowserAgentSettings {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<BrowserAgentSettings>)
      : {}
  return {
    backend:
      parseBrowserBackendPreference(raw.backend) ??
      DEFAULT_BROWSER_AGENT_SETTINGS.backend,
    light: normalizeBrowserAgentModelSettings(
      raw.light,
      DEFAULT_BROWSER_AGENT_SETTINGS.light
    ),
    pro: normalizeBrowserAgentModelSettings(
      raw.pro,
      DEFAULT_BROWSER_AGENT_SETTINGS.pro
    ),
    proEnabled:
      typeof raw.proEnabled === "boolean"
        ? raw.proEnabled
        : DEFAULT_BROWSER_AGENT_SETTINGS.proEnabled,
  }
}

function normalizeBrowserAgentModelSettings(
  value: Partial<BrowserAgentModelSettings> | undefined,
  fallback: BrowserAgentModelSettings
): BrowserAgentModelSettings {
  return {
    provider: value?.provider || fallback.provider,
    model: value?.model || fallback.model,
    thinkingLevel: value?.thinkingLevel || fallback.thinkingLevel,
    modelOptions: value?.modelOptions ?? fallback.modelOptions,
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  const config = getConfig()
  const providerDef = getEffectiveProvider(config.activeProvider)
  const modelDef = providerDef
    ? getEffectiveModel(config.activeProvider, config.activeModel)
    : null

  let apiKeyConfigured = false
  let apiKeyMasked: string | null = null

  if (providerDef) {
    const key =
      getProviderApiKeyInfo(config.activeProvider, providerDef)?.value ?? null
    if (key && key.length > 8) {
      apiKeyConfigured = true
      apiKeyMasked = key.slice(0, 4) + "..." + key.slice(-4)
    }
  }

  return {
    ...config,
    apiKeyConfigured,
    apiKeyMasked,
    model: modelDef,
    provider: providerDef,
    browserAgentBackend: resolveBrowserBackend({
      settingsValue: config.browserAgent.backend,
    }),
  }
}

export function updateConfig(newConfig: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  const updated = normalizeAppConfig({
    ...current,
    ...newConfig,
    updatedAt: Date.now(),
  })
  ensureRuntimeFiles()
  fs.writeFileSync(
    activeConfigPath(),
    JSON.stringify(updated, null, 2),
    "utf-8"
  )
  emitAppEvent({ type: "config.updated" })
  emitAppEvent({ type: "settings.changed", reason: "config" })
  return updated
}

export function getConfiguredTimezone(): string {
  return getConfig().timezone
}

// --- Semantic memory embedding settings ---

export type EmbeddingProviderId = "google" | "openai"

export interface EmbeddingModelOption {
  provider: EmbeddingProviderId
  model: string
  label: string
  /** Supported output dimensionalities (Matryoshka). First entry = default. */
  dims: number[]
}

/**
 * Curated embedding-capable models per provider. We deliberately do NOT live-
 * discover from provider model lists (those are dominated by chat models and
 * dims aren't reported) — this is the filtered "embeddings only" set with known
 * Matryoshka dimensions. The Settings card shows entries whose provider has a
 * key configured.
 */
export const EMBEDDING_MODEL_OPTIONS: ReadonlyArray<EmbeddingModelOption> = [
  {
    provider: "google",
    model: "gemini-embedding-2",
    label: "Gemini Embedding 2 (multilingual, multimodal)",
    dims: [768, 1536, 3072],
  },
  {
    provider: "openai",
    model: "text-embedding-3-large",
    label: "OpenAI text-embedding-3-large",
    dims: [3072, 1536, 768, 256],
  },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    label: "OpenAI text-embedding-3-small",
    dims: [1536, 768, 256],
  },
]

/** Supported dims for a model id (Matryoshka). Falls back to [768]. */
export function embeddingDimsForModel(model: string): number[] {
  return EMBEDDING_MODEL_OPTIONS.find((o) => o.model === model)?.dims ?? [768]
}

const MEMORY_EMBEDDING_DEFAULTS: MemoryEmbeddingSettings = {
  enabled: true,
  provider: "google",
  model: "gemini-embedding-2",
  dim: 768,
  threshold: 0.68,
}

function coerceProvider(value: unknown): EmbeddingProviderId {
  return value === "openai" ? "openai" : "google"
}

function coerceDim(model: string, rawDim: unknown, fallback: number): number {
  const dims = embeddingDimsForModel(model)
  const n = Number(rawDim)
  if (Number.isFinite(n) && dims.includes(n)) return n
  return dims.includes(fallback) ? fallback : dims[0]
}

function normalizeMemoryEmbeddingSettings(
  value: unknown
): MemoryEmbeddingSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const raw = value as Partial<MemoryEmbeddingSettings>
  const model =
    typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : MEMORY_EMBEDDING_DEFAULTS.model
  const threshold =
    typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
      ? Math.min(1, Math.max(0, raw.threshold))
      : MEMORY_EMBEDDING_DEFAULTS.threshold
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    provider: coerceProvider(raw.provider),
    model,
    dim: coerceDim(model, raw.dim, MEMORY_EMBEDDING_DEFAULTS.dim),
    threshold,
  }
}

function memoryEmbeddingFromEnv(): MemoryEmbeddingSettings {
  const model =
    process.env.ORCHESTRATOR_MEMORY_EMBED_MODEL?.trim() ||
    MEMORY_EMBEDDING_DEFAULTS.model
  const thrRaw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_THRESHOLD)
  const threshold = Number.isFinite(thrRaw)
    ? Math.min(1, Math.max(0, thrRaw))
    : MEMORY_EMBEDDING_DEFAULTS.threshold
  return {
    enabled:
      (process.env.ORCHESTRATOR_MEMORY_RECALL ?? "on").toLowerCase() !== "off",
    provider: coerceProvider(process.env.ORCHESTRATOR_MEMORY_EMBED_PROVIDER),
    model,
    dim: coerceDim(
      model,
      process.env.ORCHESTRATOR_MEMORY_EMBED_DIM,
      MEMORY_EMBEDDING_DEFAULTS.dim
    ),
    threshold,
  }
}

/**
 * Resolved embedding settings: the Settings/config value when present, else the
 * env-derived defaults. `ORCHESTRATOR_MEMORY_RECALL=off` is a hard ops
 * kill-switch that disables recall regardless of the UI toggle.
 */
export function getMemoryEmbeddingSettings(): MemoryEmbeddingSettings {
  const base = getConfig().memoryEmbedding ?? memoryEmbeddingFromEnv()
  const killed =
    (process.env.ORCHESTRATOR_MEMORY_RECALL ?? "").toLowerCase() === "off"
  return { ...base, enabled: base.enabled && !killed }
}

/** Get the API key for the active provider from environment */
export function getApiKey(providerName?: string): string | null {
  const config = getConfig()
  const providerId = providerName ?? config.activeProvider
  const provider = getEffectiveProvider(providerId)
  if (!provider) return null
  return getProviderApiKeyInfo(providerId, provider)?.value ?? null
}

export function getProviderApiKeyInfo(
  providerId: string,
  provider: EffectiveProviderEntry
): { envName: string; value: string } | null {
  return getFirstEnvValue(
    getProviderApiKeyEnvNames(providerId, provider.apiKeyEnv)
  )
}

export function getProviderApiKeyEnvNames(
  providerId: string,
  primaryEnvName: string
): string[] {
  return uniqueStrings([
    primaryEnvName,
    ...(PROVIDER_API_KEY_ALIASES[providerId] ?? []),
  ])
}

export function getEnvValue(name: string): string | null {
  return getFirstEnvValue([name])?.value ?? null
}

function getFirstEnvValue(
  names: string[]
): { envName: string; value: string } | null {
  if (canUseSharedEnvSecret(names)) {
    for (const name of names) {
      const value = process.env[name]
      if (hasEnvValue(value)) return { envName: name, value }
    }
  }

  const filePaths = canUseSharedEnvSecret(names)
    ? sharedEnvFilePaths()
    : [activeRuntimePaths().workspaceEnvPath]
  for (const filePath of filePaths) {
    const values = readEnvFileValues(filePath, names)
    for (const name of names) {
      const value = values[name]
      if (hasEnvValue(value)) return { envName: name, value }
    }
  }

  return null
}

function sharedEnvFilePaths(): string[] {
  const activePath = activeRuntimePaths().workspaceEnvPath
  const adminPath = runtimePathsForProfile(ADMIN_PROFILE_ID).workspaceEnvPath
  return uniqueStrings([activePath, adminPath, ...PROJECT_ENV_PATHS])
}

function canUseSharedEnvSecret(names: string[]): boolean {
  const profileId = getActiveProfileId()
  if (isAdminProfileId(profileId)) return true
  const profile = getProfile(profileId)
  if (!profile?.permissions.inheritAdminApiKeys) return false
  const allowed = new Set(profile.permissions.allowedProviderApiKeys)
  return allowed.has("*") || names.some((name) => allowed.has(name))
}

function readEnvFileValues(
  filePath: string,
  names: string[]
): Record<string, string> {
  const wanted = new Set(names)
  const out: Record<string, string> = {}
  try {
    if (!fs.existsSync(filePath)) return out
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const normalized = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length).trim()
        : trimmed
      const idx = normalized.indexOf("=")
      if (idx <= 0) continue
      const key = normalized.slice(0, idx).trim()
      if (!wanted.has(key)) continue
      out[key] = stripEnvQuotes(normalized.slice(idx + 1).trim())
    }
  } catch {
    return out
  }
  return out
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function hasEnvValue(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

// ---------------------------------------------------------------------------
// Per-agent resolution
// ---------------------------------------------------------------------------

export interface EffectiveAgentSettings {
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
  modelOptions: Record<string, ModelFeatureValue>
  fallbacks: AgentFallback[]
  /** True if these settings come from a per-agent override (vs the global default) */
  fromOverride: boolean
}

/**
 * Resolve the effective provider/model/thinkingLevel for a given agent id.
 * Priority: agentOverrides[id] > global active.
 *
 * The returned model is guaranteed to exist in the effective registry — if the
 * override or global points to a missing model, we fall back to the first
 * available model in the provider, then to the global default. Archived models
 * stay valid when explicitly selected; archiving only hides them from the
 * default picker/favorites surface.
 */
export function getEffectiveAgentSettings(
  agentId: string
): EffectiveAgentSettings {
  const config = getConfigForEffectiveAgent()
  const override = config.agentOverrides[agentId]
  const registry = getEffectiveRegistry()

  const candidate = override
    ? {
        provider: override.provider,
        model: override.model,
        thinkingLevel: override.thinkingLevel ?? config.thinkingLevel,
        modelOptions: override.modelOptions ?? {},
        fallbacks: override.fallbacks ?? [],
        fromOverride: true,
      }
    : {
        provider: config.activeProvider,
        model: config.activeModel,
        thinkingLevel: config.thinkingLevel,
        modelOptions: {},
        fallbacks: [],
        fromOverride: false,
      }

  // Validate provider
  let providerDef = registry[candidate.provider]
  if (!providerDef) {
    providerDef = registry[config.activeProvider] ?? Object.values(registry)[0]
    if (providerDef) {
      candidate.provider =
        Object.keys(registry).find((k) => registry[k] === providerDef) ??
        candidate.provider
    }
    candidate.fromOverride = false
  }

  // Validate model — archived models remain runnable when explicitly selected.
  const modelDef = providerDef?.models[candidate.model]
  if (!modelDef) {
    const fallback = Object.entries(providerDef?.models ?? {}).find(
      ([, m]) => !m.archived
    )
    if (fallback) {
      candidate.model = fallback[0]
      candidate.fromOverride = false
    }
  }

  return candidate
}

function getConfigForEffectiveAgent(): AppConfig {
  const profileId = getActiveProfileId()
  return shouldUseAdminModelSettings(profileId) ? getAdminConfig() : getConfig()
}

export function setAgentOverride(
  agentId: string,
  override: AgentOverride | null
): AppConfig {
  return setSharedAgentOverride(agentId, override)
}

function setAgentOverrideForActiveProfile(
  agentId: string,
  override: AgentOverride | null
): AppConfig {
  const current = getConfig()
  const agentOverrides = { ...current.agentOverrides }
  if (override === null) {
    delete agentOverrides[agentId]
  } else {
    agentOverrides[agentId] = override
  }
  return updateConfig({ agentOverrides })
}

function setSharedAgentOverride(
  agentId: string,
  override: AgentOverride | null
): AppConfig {
  const activeProfileId = getActiveProfileId()
  const activeProfile = getProfile(activeProfileId)
  if (!isAdminProfileId(activeProfileId)) {
    if (activeProfile?.permissions.tools.models) {
      return setAgentOverrideForActiveProfile(agentId, override)
    }
    return getConfig()
  }

  let activeConfig: AppConfig | null = null

  for (const profile of listProfiles({ includeDisabled: true })) {
    if (
      !isAdminProfileId(profile.id) &&
      profile.permissions.tools.models
    ) {
      continue
    }
    const updated = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => setAgentOverrideForActiveProfile(agentId, override)
    )
    if (profile.id === activeProfileId) activeConfig = updated
  }

  return activeConfig ?? setAgentOverrideForActiveProfile(agentId, override)
}

function shouldUseAdminModelSettings(profileId: string): boolean {
  if (isAdminProfileId(profileId)) return false
  const profile = getProfile(profileId)
  return profile?.permissions.tools.models !== true
}

export function setBrowserAgentModel(
  slot: BrowserAgentModelSlot,
  override: BrowserAgentModelSettings
): AppConfig {
  return setSharedBrowserAgentConfig(
    slot === "light" ? { light: override } : { pro: override }
  )
}

function setBrowserAgentModelForActiveProfile(
  patch: Partial<BrowserAgentSettings>
): AppConfig {
  const current = getConfig()
  return updateConfig({
    browserAgent: {
      ...current.browserAgent,
      ...patch,
    },
  })
}

export function setBrowserAgentProEnabled(proEnabled: boolean): AppConfig {
  return setSharedBrowserAgentConfig({ proEnabled })
}

function setSharedBrowserAgentConfig(
  patch: Partial<BrowserAgentSettings>
): AppConfig {
  const activeProfileId = getActiveProfileId()
  const activeProfile = getProfile(activeProfileId)
  if (!isAdminProfileId(activeProfileId)) {
    if (activeProfile?.permissions.tools.models) {
      return setBrowserAgentModelForActiveProfile(patch)
    }
    return getConfig()
  }

  let activeConfig: AppConfig | null = null

  for (const profile of listProfiles({ includeDisabled: true })) {
    if (
      !isAdminProfileId(profile.id) &&
      profile.permissions.tools.models
    ) {
      continue
    }
    const updated = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => setBrowserAgentModelForActiveProfile(patch)
    )
    if (profile.id === activeProfileId) activeConfig = updated
  }

  return activeConfig ?? setBrowserAgentModelForActiveProfile(patch)
}

export function getEffectiveBrowserAgentSettings(): BrowserAgentSettings {
  const profileId = getActiveProfileId()
  return shouldUseAdminModelSettings(profileId)
    ? getAdminConfig().browserAgent
    : getConfig().browserAgent
}

export function setAgentOrder(agentOrder: string[]): AppConfig {
  return updateConfig({ agentOrder: normalizeStringList(agentOrder) })
}

export function setFavorites(favorites: string[]): AppConfig {
  // Deduplicate while preserving order; drop entries pointing to non-existent models.
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const fav of favorites) {
    if (seen.has(fav)) continue
    seen.add(fav)
    const [providerId, modelId] = fav.split(":")
    if (effectiveModelExists(providerId, modelId)) {
      cleaned.push(fav)
    }
  }
  return updateConfig({ favorites: cleaned })
}

export function modelExists(providerId: string, modelId: string): boolean {
  return effectiveModelExists(providerId, modelId)
}
