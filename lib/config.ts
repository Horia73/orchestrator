import path from 'path';
import fs from 'fs';

import {
    type ThinkingLevel,
    type ModelPricing,
    type ModelFeatureValue,
    type EffectiveProviderEntry,
    type EffectiveModelEntry,
} from '@/lib/models/schema';
import {
    getEffectiveRegistry,
    getEffectiveProvider,
    getEffectiveModel,
    effectiveModelExists,
} from '@/lib/models/registry';

/** Project root for this orchestrator instance. */
export const PROJECT_DIR = /* turbopackIgnore: true */ process.cwd();

/** Application state lives under the project. */
const DB_DIR = path.join(PROJECT_DIR, '.orchestrator');

/**
 * Runtime workspace for agents. CLI agents start here, shell tools run here,
 * and filesystem tools expose this directory as "/".
 */
export const WORKSPACE_DIR = path.join(DB_DIR, 'workspace');
export const PRIVATE_STATE_DIR = path.join(DB_DIR, 'private');

const LEGACY_CONFIG_PATH = path.join(DB_DIR, 'config.json');
const CONFIG_PATH = path.join(WORKSPACE_DIR, 'config.json');
export const WORKSPACE_ENV_PATH = path.join(WORKSPACE_DIR, '.env.local');

/** Directory where uploaded files are stored */
export const UPLOADS_DIR = path.join(DB_DIR, 'uploads');

/**
 * Root exposed to filesystem-capable agents.
 * Relative paths in tools resolve from here, and CLI-backed agents start
 * here as their cwd.
 */
export const AGENT_WORKSPACE_DIR = WORKSPACE_DIR;

/** Real files backing persisted artifacts, mounted under the agent workspace. */
export const ARTIFACTS_DIR = path.join(WORKSPACE_DIR, 'artifacts');

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
export const PROVIDERS = new Proxy({} as Record<string, EffectiveProviderEntry>, {
    get(_target, key) {
        if (typeof key !== 'string') return undefined
        return getEffectiveRegistry()[key]
    },
    has(_target, key) {
        if (typeof key !== 'string') return false
        return key in getEffectiveRegistry()
    },
    ownKeys() {
        return Object.keys(getEffectiveRegistry())
    },
    getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== 'string') return undefined
        const reg = getEffectiveRegistry()
        if (!(key in reg)) return undefined
        return { configurable: true, enumerable: true, value: reg[key], writable: false }
    },
})

// ---------------------------------------------------------------------------
// App config (persisted in .orchestrator/config.json)
// ---------------------------------------------------------------------------

export interface AgentOverride {
    provider: string
    model: string
    thinkingLevel?: ThinkingLevel
    modelOptions?: Record<string, ModelFeatureValue>
}

export type BrowserAgentModelSlot = 'light' | 'pro'

export interface BrowserAgentModelSettings {
    provider: string
    model: string
    thinkingLevel: ThinkingLevel
    modelOptions?: Record<string, ModelFeatureValue>
}

export interface BrowserAgentSettings {
    light: BrowserAgentModelSettings
    pro: BrowserAgentModelSettings
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
    /** Browser automation uses a light model first and escalates to the pro model when stuck. */
    browserAgent: BrowserAgentSettings
    /** Favorite models, in display order. Each entry is "providerId:modelId". */
    favorites: string[]
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
            image: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
            audio: ['audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/mp4'],
            video: ['video/mp4', 'video/mpeg', 'video/mpg', 'video/mov', 'video/avi', 'video/x-flv', 'video/webm', 'video/wmv', 'video/3gpp'],
            document: ['application/pdf', 'text/plain'],
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
export function isFileSupportedByProvider(provider: string, mimeType: string): boolean {
    const support = PROVIDER_FILE_SUPPORT[provider]
    if (!support) return false
    const all = [
        ...support.supportedMimeTypes.image,
        ...support.supportedMimeTypes.audio,
        ...support.supportedMimeTypes.video,
        ...support.supportedMimeTypes.document,
    ]
    // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm")
    const baseMime = mimeType.split(';')[0].trim()
    return all.includes(baseMime)
}

// ---------------------------------------------------------------------------
// Defaults + persistence for AppConfig
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_AGENT_SETTINGS: BrowserAgentSettings = {
    light: {
        provider: "google",
        model: "gemini-3-flash-preview",
        thinkingLevel: "low",
    },
    pro: {
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinkingLevel: "high",
    },
}

const DEFAULT_CONFIG: AppConfig = {
    assistantName: "Orchestrator",
    userName: "User",
    activeProvider: "google",
    activeModel: "gemini-3-flash-preview",
    thinkingLevel: "high",
    agentOverrides: {},
    browserAgent: DEFAULT_BROWSER_AGENT_SETTINGS,
    favorites: [],
    updatedAt: Date.now(),
};

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

if (!fs.existsSync(PRIVATE_STATE_DIR)) {
    fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true });
    try {
        fs.chmodSync(PRIVATE_STATE_DIR, 0o700);
    } catch {
        // Some filesystems ignore chmod; the directory remains inside .orchestrator.
    }
}

if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
    fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
}

if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
}

export function getConfig(): AppConfig {
    try {
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        // Merge with defaults so new fields get their default values
        return normalizeAppConfig(parsed);
    } catch (e) {
        console.error("Failed to read config, returning default", e);
        return DEFAULT_CONFIG;
    }
}

function normalizeAppConfig(parsed: Partial<AppConfig>): AppConfig {
    return {
        ...DEFAULT_CONFIG,
        ...parsed,
        agentOverrides: parsed.agentOverrides ?? DEFAULT_CONFIG.agentOverrides,
        browserAgent: normalizeBrowserAgentSettings(parsed.browserAgent),
    }
}

function normalizeBrowserAgentSettings(value: unknown): BrowserAgentSettings {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<Record<BrowserAgentModelSlot, Partial<BrowserAgentModelSettings>>>
        : {}
    return {
        light: normalizeBrowserAgentModelSettings(raw.light, DEFAULT_BROWSER_AGENT_SETTINGS.light),
        pro: normalizeBrowserAgentModelSettings(raw.pro, DEFAULT_BROWSER_AGENT_SETTINGS.pro),
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
        modelOptions: value?.modelOptions,
    }
}

export function getRuntimeConfig(): RuntimeConfig {
    const config = getConfig();
    const providerDef = getEffectiveProvider(config.activeProvider);
    const modelDef = providerDef ? getEffectiveModel(config.activeProvider, config.activeModel) : null;

    let apiKeyConfigured = false;
    let apiKeyMasked: string | null = null;

    if (providerDef) {
        const key = getEnvValue(providerDef.apiKeyEnv);
        if (key && key.length > 8) {
            apiKeyConfigured = true;
            apiKeyMasked = key.slice(0, 4) + "..." + key.slice(-4);
        }
    }

    return {
        ...config,
        apiKeyConfigured,
        apiKeyMasked,
        model: modelDef,
        provider: providerDef,
    };
}

export function updateConfig(newConfig: Partial<AppConfig>): AppConfig {
    const current = getConfig();
    const updated = { ...current, ...newConfig, updatedAt: Date.now() };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}

/** Get the API key for the active provider from environment */
export function getApiKey(providerName?: string): string | null {
    const config = getConfig();
    const provider = getEffectiveProvider(providerName ?? config.activeProvider);
    if (!provider) return null;
    return getEnvValue(provider.apiKeyEnv);
}

export function getEnvValue(name: string): string | null {
    return process.env[name] ?? readWorkspaceEnvValue(name)
}

function readWorkspaceEnvValue(name: string): string | null {
    try {
        if (!fs.existsSync(WORKSPACE_ENV_PATH)) return null
        const lines = fs.readFileSync(WORKSPACE_ENV_PATH, 'utf-8').split(/\r?\n/)
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const idx = trimmed.indexOf('=')
            if (idx <= 0) continue
            if (trimmed.slice(0, idx).trim() !== name) continue
            return stripEnvQuotes(trimmed.slice(idx + 1).trim())
        }
    } catch {
        return null
    }
    return null
}

function stripEnvQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    return value
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
export function getEffectiveAgentSettings(agentId: string): EffectiveAgentSettings {
    const config = getConfig()
    const override = config.agentOverrides[agentId]
    const registry = getEffectiveRegistry()

    const candidate = override
        ? { provider: override.provider, model: override.model, thinkingLevel: override.thinkingLevel ?? config.thinkingLevel, modelOptions: override.modelOptions ?? {}, fromOverride: true }
        : { provider: config.activeProvider, model: config.activeModel, thinkingLevel: config.thinkingLevel, modelOptions: {}, fromOverride: false }

    // Validate provider
    let providerDef = registry[candidate.provider]
    if (!providerDef) {
        providerDef = registry[config.activeProvider] ?? Object.values(registry)[0]
        if (providerDef) {
            candidate.provider = Object.keys(registry).find(k => registry[k] === providerDef) ?? candidate.provider
        }
        candidate.fromOverride = false
    }

    // Validate model — pick first non-archived if current is missing/archived
    const modelDef = providerDef?.models[candidate.model]
    if (!modelDef || modelDef.archived) {
        const fallback = Object.entries(providerDef?.models ?? {}).find(([, m]) => !m.archived)
        if (fallback) {
            candidate.model = fallback[0]
            candidate.fromOverride = false
        }
    }

    return candidate
}

export function setAgentOverride(agentId: string, override: AgentOverride | null): AppConfig {
    const current = getConfig()
    const agentOverrides = { ...current.agentOverrides }
    if (override === null) {
        delete agentOverrides[agentId]
    } else {
        agentOverrides[agentId] = override
    }
    return updateConfig({ agentOverrides })
}

export function setBrowserAgentModel(slot: BrowserAgentModelSlot, override: BrowserAgentModelSettings): AppConfig {
    const current = getConfig()
    return updateConfig({
        browserAgent: {
            ...current.browserAgent,
            [slot]: override,
        },
    })
}

export function setFavorites(favorites: string[]): AppConfig {
    // Deduplicate while preserving order; drop entries pointing to non-existent models.
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const fav of favorites) {
        if (seen.has(fav)) continue
        seen.add(fav)
        const [providerId, modelId] = fav.split(':')
        if (effectiveModelExists(providerId, modelId)) {
            cleaned.push(fav)
        }
    }
    return updateConfig({ favorites: cleaned })
}

export function modelExists(providerId: string, modelId: string): boolean {
    return effectiveModelExists(providerId, modelId)
}
