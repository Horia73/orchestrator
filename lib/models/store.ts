import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'

import seedJson from './seed.json'
import { emitAppEvent } from '@/lib/events'
import {
    SeedRegistrySchema,
    LiveRegistrySchema,
    CuratedRegistrySchema,
    EMPTY_LIVE_REGISTRY,
    EMPTY_CURATED_REGISTRY,
    type SeedRegistry,
    type LiveRegistry,
    type CuratedRegistry,
} from './schema'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DB_DIR = path.join(process.cwd(), '.orchestrator')
const WORKSPACE_DIR = path.join(DB_DIR, 'workspace')
const LIVE_PATH = path.join(WORKSPACE_DIR, 'api-models.json')
const CURATED_PATH = path.join(WORKSPACE_DIR, 'model-overrides.json')
const LEGACY_LIVE_PATH = path.join(DB_DIR, 'models-live.json')
const LEGACY_WORKSPACE_LIVE_PATH = path.join(WORKSPACE_DIR, 'models-live.json')
const LEGACY_CURATED_PATH = path.join(DB_DIR, 'models-curated.json')
const LEGACY_WORKSPACE_CURATED_PATH = path.join(WORKSPACE_DIR, 'models-curated.json')

function ensureDir() {
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
}

function migrateLegacyFile(legacyPath: string, targetPath: string) {
    ensureDir()
    if (!fs.existsSync(targetPath) && fs.existsSync(legacyPath)) {
        fs.copyFileSync(legacyPath, targetPath)
    }
}

// ---------------------------------------------------------------------------
// Atomic write — write to a temp file in the same directory, then rename.
// rename() is atomic on POSIX, so a crash mid-write never corrupts the target.
// We also fsync the temp file before rename to flush page cache.
// ---------------------------------------------------------------------------

function writeJsonAtomic(targetPath: string, data: unknown) {
    ensureDir()
    const dir = path.dirname(targetPath)
    const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${randomUUID()}`)
    const json = JSON.stringify(data, null, 2)

    const fd = fs.openSync(tmpPath, 'w', 0o600)
    try {
        fs.writeSync(fd, json)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }

    fs.renameSync(tmpPath, targetPath)
}

/**
 * Move a corrupted file aside so we don't keep retrying to parse it. Returns
 * the backup path so callers can surface it to the user.
 */
function quarantineCorruptedFile(targetPath: string): string | null {
    if (!fs.existsSync(targetPath)) return null
    const backup = `${targetPath}.corrupted-${Date.now()}`
    try {
        fs.renameSync(targetPath, backup)
        return backup
    } catch (err) {
        console.error(`Failed to quarantine ${targetPath}:`, err)
        return null
    }
}

// ---------------------------------------------------------------------------
// Layer 1 — built-in seed (loaded once at startup)
// ---------------------------------------------------------------------------

let _seedCache: SeedRegistry | null = null

export function getSeedRegistry(): SeedRegistry {
    if (_seedCache) return _seedCache
    // Throws on malformed seed — that's a code-level bug, fail fast.
    _seedCache = SeedRegistrySchema.parse(seedJson)
    return _seedCache
}

// ---------------------------------------------------------------------------
// Layer 2 — live registry
// On corruption: log + quarantine + return empty (we can re-fetch from API).
// ---------------------------------------------------------------------------

export function readLiveRegistry(): LiveRegistry {
    migrateLegacyFile(LEGACY_WORKSPACE_LIVE_PATH, LIVE_PATH)
    migrateLegacyFile(LEGACY_LIVE_PATH, LIVE_PATH)
    if (!fs.existsSync(LIVE_PATH)) return EMPTY_LIVE_REGISTRY

    let raw: string
    try {
        raw = fs.readFileSync(LIVE_PATH, 'utf-8')
    } catch (err) {
        console.error(`Failed to read ${LIVE_PATH}:`, err)
        return EMPTY_LIVE_REGISTRY
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        const backup = quarantineCorruptedFile(LIVE_PATH)
        console.warn(`api-models.json is not valid JSON; quarantined to ${backup}. Error:`, err)
        return EMPTY_LIVE_REGISTRY
    }

    const result = LiveRegistrySchema.safeParse(parsed)
    if (!result.success) {
        const backup = quarantineCorruptedFile(LIVE_PATH)
        console.warn(`api-models.json failed schema validation; quarantined to ${backup}. Issues:`, result.error.issues)
        return EMPTY_LIVE_REGISTRY
    }

    return result.data
}

export function writeLiveRegistry(registry: LiveRegistry) {
    // Validate before write — catches bugs early, the file on disk stays valid.
    const validated = LiveRegistrySchema.parse(registry)
    writeJsonAtomic(LIVE_PATH, validated)
    emitAppEvent({ type: 'settings.changed', reason: 'models' })
}

// ---------------------------------------------------------------------------
// Layer 3 — curated overrides
// On corruption: backup, log, return empty. User data is precious — never
// silently overwrite their pricing/research with defaults; surface the backup
// path so they can recover manually if it ever happens.
// ---------------------------------------------------------------------------

export function readCuratedRegistry(): CuratedRegistry {
    migrateLegacyFile(LEGACY_WORKSPACE_CURATED_PATH, CURATED_PATH)
    migrateLegacyFile(LEGACY_CURATED_PATH, CURATED_PATH)
    if (!fs.existsSync(CURATED_PATH)) return EMPTY_CURATED_REGISTRY

    let raw: string
    try {
        raw = fs.readFileSync(CURATED_PATH, 'utf-8')
    } catch (err) {
        console.error(`Failed to read ${CURATED_PATH}:`, err)
        return EMPTY_CURATED_REGISTRY
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        const backup = quarantineCorruptedFile(CURATED_PATH)
        console.warn(`model-overrides.json is not valid JSON; quarantined to ${backup}. Error:`, err)
        return EMPTY_CURATED_REGISTRY
    }

    const result = CuratedRegistrySchema.safeParse(parsed)
    if (!result.success) {
        const backup = quarantineCorruptedFile(CURATED_PATH)
        console.warn(`model-overrides.json failed schema validation; quarantined to ${backup}. Issues:`, result.error.issues)
        return EMPTY_CURATED_REGISTRY
    }

    return result.data
}

export function writeCuratedRegistry(registry: CuratedRegistry) {
    const validated = CuratedRegistrySchema.parse(registry)
    writeJsonAtomic(CURATED_PATH, validated)
    emitAppEvent({ type: 'settings.changed', reason: 'models' })
}

// ---------------------------------------------------------------------------
// Diagnostics — useful for debugging and a future "Storage" tab
// ---------------------------------------------------------------------------

export function getStorePaths() {
    return { liveRegistry: LIVE_PATH, curatedRegistry: CURATED_PATH, dataDir: DB_DIR }
}
