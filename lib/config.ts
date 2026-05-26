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
import {
  ORCHESTRATOR_STATE_DIR,
  PRIVATE_STATE_DIR,
  PROJECT_DIR,
  UPLOADS_DIR,
  WORKSPACE_DIR,
  WORKSPACE_ENV_PATH,
} from "@/lib/runtime-paths"

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

const LEGACY_CONFIG_PATH = path.join(
  /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
  "config.json"
)
const CONFIG_PATH = path.join(
  /* turbopackIgnore: true */ WORKSPACE_DIR,
  "config.json"
)
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
// App config (persisted in .orchestrator/config.json)
// ---------------------------------------------------------------------------

export interface AgentOverride {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
  modelOptions?: Record<string, ModelFeatureValue>
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

export interface AppConfig {
  assistantName: string
  userName: string
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
  /** Browser backend preference, effective backend, source, and availability diagnostics. */
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
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/mp4",
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
  const baseMime = mimeType.split(";")[0].trim()
  return all.includes(baseMime)
}

// ---------------------------------------------------------------------------
// Defaults + persistence for AppConfig
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_AGENT_SETTINGS: BrowserAgentSettings = {
  backend: "auto",
  light: {
    provider: "google",
    model: "gemini-3-flash-preview",
    thinkingLevel: "low",
    modelOptions: {
      media_resolution: "media_resolution_medium",
    },
  },
  pro: {
    provider: "google",
    model: "gemini-3.1-pro-preview",
    thinkingLevel: "high",
    modelOptions: {
      media_resolution: "media_resolution_medium",
    },
  },
}

const DEFAULT_CONFIG: AppConfig = {
  assistantName: "Orchestrator",
  userName: "User",
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

if (!fs.existsSync(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR)) {
  fs.mkdirSync(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, {
    recursive: true,
  })
}

if (!fs.existsSync(/* turbopackIgnore: true */ UPLOADS_DIR)) {
  fs.mkdirSync(/* turbopackIgnore: true */ UPLOADS_DIR, { recursive: true })
}

if (!fs.existsSync(/* turbopackIgnore: true */ WORKSPACE_DIR)) {
  fs.mkdirSync(/* turbopackIgnore: true */ WORKSPACE_DIR, { recursive: true })
}

if (!fs.existsSync(/* turbopackIgnore: true */ PRIVATE_STATE_DIR)) {
  fs.mkdirSync(/* turbopackIgnore: true */ PRIVATE_STATE_DIR, {
    recursive: true,
  })
  try {
    fs.chmodSync(/* turbopackIgnore: true */ PRIVATE_STATE_DIR, 0o700)
  } catch {
    // Some filesystems ignore chmod; the directory remains inside .orchestrator.
  }
}

if (
  !fs.existsSync(/* turbopackIgnore: true */ CONFIG_PATH) &&
  fs.existsSync(/* turbopackIgnore: true */ LEGACY_CONFIG_PATH)
) {
  fs.copyFileSync(/* turbopackIgnore: true */ LEGACY_CONFIG_PATH, CONFIG_PATH)
}

if (!fs.existsSync(/* turbopackIgnore: true */ CONFIG_PATH)) {
  fs.writeFileSync(
    /* turbopackIgnore: true */ CONFIG_PATH,
    JSON.stringify(DEFAULT_CONFIG, null, 2),
    "utf-8"
  )
}

export function getConfig(): AppConfig {
  try {
    const data = fs.readFileSync(
      /* turbopackIgnore: true */ CONFIG_PATH,
      "utf-8"
    )
    const parsed = JSON.parse(data)
    // Merge with defaults so new fields get their default values
    return normalizeAppConfig(parsed)
  } catch (e) {
    console.error("Failed to read config, returning default", e)
    return DEFAULT_CONFIG
  }
}

function normalizeAppConfig(parsed: Partial<AppConfig>): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    agentOverrides: parsed.agentOverrides ?? DEFAULT_CONFIG.agentOverrides,
    agentOrder: normalizeStringList(
      (parsed as { agentOrder?: unknown }).agentOrder
    ),
    browserAgent: normalizeBrowserAgentSettings(parsed.browserAgent),
    smartMonitor: normalizeSmartMonitorSettings(parsed.smartMonitor),
  }
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
      chromeExecutablePath:
        process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH ||
        process.env.CHROME_EXECUTABLE_PATH ||
        null,
    }),
  }
}

export function updateConfig(newConfig: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  const updated = { ...current, ...newConfig, updatedAt: Date.now() }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8")
  emitAppEvent({ type: "config.updated" })
  emitAppEvent({ type: "settings.changed", reason: "config" })
  return updated
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
  for (const name of names) {
    const value = process.env[name]
    if (hasEnvValue(value)) return { envName: name, value }
  }

  for (const filePath of [WORKSPACE_ENV_PATH, ...PROJECT_ENV_PATHS]) {
    const values = readEnvFileValues(filePath, names)
    for (const name of names) {
      const value = values[name]
      if (hasEnvValue(value)) return { envName: name, value }
    }
  }

  return null
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
  /** True if these settings come from a per-agent override (vs the global default) */
  fromOverride: boolean
}

/**
 * Resolve the effective provider/model/thinkingLevel for a given agent id.
 * Priority: agentOverrides[id] > global active.
 *
 * The returned model is guaranteed to exist in the effective registry — if the
 * override or global points to a missing model (or one that's been archived),
 * we fall back to the first non-archived model in the provider, then to the
 * global default. This prevents broken state when a previously-favorited model
 * is removed or archived.
 */
export function getEffectiveAgentSettings(
  agentId: string
): EffectiveAgentSettings {
  const config = getConfig()
  const override = config.agentOverrides[agentId]
  const registry = getEffectiveRegistry()

  const candidate = override
    ? {
        provider: override.provider,
        model: override.model,
        thinkingLevel: override.thinkingLevel ?? config.thinkingLevel,
        modelOptions: override.modelOptions ?? {},
        fromOverride: true,
      }
    : {
        provider: config.activeProvider,
        model: config.activeModel,
        thinkingLevel: config.thinkingLevel,
        modelOptions: {},
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

  // Validate model — pick first non-archived if current is missing/archived
  const modelDef = providerDef?.models[candidate.model]
  if (!modelDef || modelDef.archived) {
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

export function setAgentOverride(
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

export function setBrowserAgentModel(
  slot: BrowserAgentModelSlot,
  override: BrowserAgentModelSettings
): AppConfig {
  const current = getConfig()
  return updateConfig({
    browserAgent: {
      ...current.browserAgent,
      [slot]: override,
    },
  })
}

export function setBrowserAgentBackend(
  backend: BrowserBackendPreference
): AppConfig {
  const current = getConfig()
  return updateConfig({
    browserAgent: {
      ...current.browserAgent,
      backend,
    },
  })
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
