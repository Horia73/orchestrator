import fs from 'fs'
import path from 'path'

import { getEnvValue, WORKSPACE_ENV_PATH } from '@/lib/config'
import { readGoogleMapsApiKey } from '@/lib/maps/google-session'
import { invalidateWeatherConnectionProbe } from '@/lib/integrations/weather'
import { invalidateWeatherProviderState } from '@/lib/weather/providers'

// ---------------------------------------------------------------------------
// Google Maps integration — connection status.
//
// Architecture note: the chat renderer now uses Google Maps JavaScript
// API loaded inside a sandboxed iframe directly from Google's CDN. There
// is no server-side tile pipeline anymore. Server-side, the only Maps
// Platform product we still call is the Geocoding API (address → coords).
//
// "Configured" means GOOGLE_MAPS_API_KEY is present in the environment.
// "Connected" means a smoke ping against the Geocoding API succeeds with
// that same key, which is the best proxy for "Maps Platform APIs are enabled
// and usable".
// ---------------------------------------------------------------------------

const GOOGLE_GEOCODE_PROBE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

export interface MapsIntegrationStatus {
    id: 'maps'
    name: string
    description: string
    /** GOOGLE_MAPS_API_KEY is set, so the Maps JS iframe can load. */
    configured: boolean
    /** A Geocoding API ping with the key returned OK. Used as a generic
     *  proxy for "Maps Platform setup is healthy". */
    connected: boolean
    /** True when the key is set but the probe failed — usually means a
     *  required API is not enabled in the GCP project, billing is off,
     *  or the key has restrictions blocking server-side calls. */
    needsReconnect: boolean
    /** Last probe error, if any. Surfaced in the integrations block so
     *  the orchestrator can read it and guide the fix. */
    error?: string
    /** True when the user supplied a custom Google Maps Map ID. Without
     *  this we fall back to Google's demo ID, which is fine for basic maps
     *  but not a production-grade vector/tilt setup. */
    mapIdConfigured: boolean
    mapIdSource: 'env' | 'demo'
    mapIdLabel: string
    vectorMap: {
        configured: boolean
        message: string
    }
    earth3d: {
        readyToTry: boolean
        channel: 'beta'
        message: string
    }
}

export interface GoogleMapsConfigInput {
    apiKey?: string
    mapId?: string
    rawEnv?: string
}

export interface MapsIntegrationConfigSummary {
    id: 'maps'
    configured: boolean
    mapIdConfigured: boolean
    mapIdSource: 'env' | 'demo'
    mapIdLabel: string
}

let probeCache: { connected: boolean; error?: string; at: number } | null = null
const PROBE_TTL_MS = 5 * 60 * 1000
const DEMO_MAP_ID = 'DEMO_MAP_ID'

async function probeConnection(): Promise<{ connected: boolean; error?: string }> {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return { connected: probeCache.connected, error: probeCache.error }
    }
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) {
        probeCache = { connected: false, error: 'GOOGLE_MAPS_API_KEY is not set', at: Date.now() }
        return probeCache
    }
    try {
        // Ping the Geocoding API with a trivial, deterministic input.
        // We don't care about the geocoding result — only that the
        // upstream returned a usable status. ZERO_RESULTS is fine
        // (means the API is alive); REQUEST_DENIED / INVALID_REQUEST
        // surface the real problem.
        const url = `${GOOGLE_GEOCODE_PROBE_URL}?address=${encodeURIComponent('Cluj-Napoca')}&key=${encodeURIComponent(apiKey)}`
        const resp = await fetch(url)
        if (!resp.ok) {
            probeCache = { connected: false, error: `HTTP ${resp.status}`, at: Date.now() }
            return probeCache
        }
        const data = await resp.json() as { status: string; error_message?: string }
        if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
            probeCache = { connected: true, at: Date.now() }
            return probeCache
        }
        probeCache = {
            connected: false,
            error: `${data.status}: ${data.error_message ?? '(no message)'}`,
            at: Date.now(),
        }
        return probeCache
    } catch (e) {
        const msg = (e as Error).message
        probeCache = { connected: false, error: `network: ${msg}`, at: Date.now() }
        return probeCache
    }
}

export async function getMapsIntegrationStatus(useCachedProbe = true): Promise<MapsIntegrationStatus> {
    const apiKey = readGoogleMapsApiKey()
    const mapId = readGoogleMapsMapId()
    const mapIdFields = mapsSetupFields(!!apiKey, mapId)
    const configured = !!apiKey
    if (!configured) {
        return {
            id: 'maps',
            name: 'Google Maps',
            description: 'Interactive satellite maps inline in chat (Google Maps JavaScript API).',
            configured: false,
            connected: false,
            needsReconnect: false,
            ...mapIdFields,
        }
    }
    if (!useCachedProbe) probeCache = null
    const probe = await probeConnection()
    return {
        id: 'maps',
        name: 'Google Maps',
        description: 'Interactive satellite maps inline in chat (Google Maps JavaScript API).',
        configured: true,
        connected: probe.connected,
        needsReconnect: !probe.connected,
        error: probe.error,
        ...mapIdFields,
    }
}

export async function saveGoogleMapsConfig(input: GoogleMapsConfigInput): Promise<MapsIntegrationStatus> {
    const pasted = parseEnvAssignments(input.rawEnv ?? '')
    const apiKey = cleanConfigValue(input.apiKey) || pasted.GOOGLE_MAPS_API_KEY
    const mapId = cleanConfigValue(input.mapId) || pasted.GOOGLE_MAPS_MAP_ID
    const values: Record<string, string> = {}

    if (apiKey) values.GOOGLE_MAPS_API_KEY = apiKey
    if (mapId) values.GOOGLE_MAPS_MAP_ID = mapId
    if (Object.keys(values).length === 0) {
        throw new Error('Paste a GOOGLE_MAPS_API_KEY env line or fill the API key field.')
    }

    patchWorkspaceEnv(values)
    for (const [key, value] of Object.entries(values)) process.env[key] = value
    invalidateMapsConnectionProbe()
    invalidateWeatherConnectionProbe()
    invalidateWeatherProviderState()

    return getMapsIntegrationStatus(false)
}

export function getMapsIntegrationConfigSummary(): MapsIntegrationConfigSummary {
    const apiKey = readGoogleMapsApiKey()
    const mapId = readGoogleMapsMapId()
    const fields = mapsSetupFields(!!apiKey, mapId)
    return {
        id: 'maps',
        configured: !!apiKey,
        mapIdConfigured: fields.mapIdConfigured,
        mapIdSource: fields.mapIdSource,
        mapIdLabel: fields.mapIdLabel,
    }
}

/** Invalidate the connection probe — call after SetEnv writes a new key
 *  so the next status read re-probes. */
export function invalidateMapsConnectionProbe(): void {
    probeCache = null
}

function readGoogleMapsMapId(): string {
    return cleanConfigValue(getEnvValue('GOOGLE_MAPS_MAP_ID'))
}

function mapsSetupFields(apiKeyConfigured: boolean, mapId: string): Pick<
    MapsIntegrationStatus,
    'mapIdConfigured' | 'mapIdSource' | 'mapIdLabel' | 'vectorMap' | 'earth3d'
> {
    const mapIdConfigured = !!mapId
    return {
        mapIdConfigured,
        mapIdSource: mapIdConfigured ? 'env' : 'demo',
        mapIdLabel: mapIdConfigured ? maskMapId(mapId) : DEMO_MAP_ID,
        vectorMap: {
            configured: mapIdConfigured,
            message: mapIdConfigured
                ? 'Custom Map ID is set. Make sure it is a JavaScript Vector Map ID with Tilt and Rotation enabled.'
                : 'Using DEMO_MAP_ID. Add a custom JavaScript Vector Map ID for production tilt and rotation.',
        },
        earth3d: {
            readyToTry: apiKeyConfigured,
            channel: 'beta',
            message: apiKeyConfigured
                ? 'Earth 3D can be tried with Maps JavaScript beta; photorealistic surface coverage varies by area.'
                : 'Add GOOGLE_MAPS_API_KEY before trying Earth 3D.',
        },
    }
}

function maskMapId(value: string): string {
    if (value.length <= 6) return 'custom Map ID'
    return `custom ...${value.slice(-6)}`
}

function parseEnvAssignments(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
        const idx = normalized.indexOf('=')
        if (idx <= 0) continue
        const key = normalized.slice(0, idx).trim()
        if (key !== 'GOOGLE_MAPS_API_KEY' && key !== 'GOOGLE_MAPS_MAP_ID') continue
        out[key] = stripEnvQuotes(normalized.slice(idx + 1).trim())
    }
    return out
}

function patchWorkspaceEnv(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(WORKSPACE_ENV_PATH), { recursive: true })
    const existing = fs.existsSync(WORKSPACE_ENV_PATH)
        ? fs.readFileSync(WORKSPACE_ENV_PATH, 'utf-8')
        : ''
    const keysToReplace = new Set(Object.keys(values))
    const written = new Set<string>()
    const kept: string[] = []
    for (const line of existing.split(/\r?\n/)) {
        const key = parseEnvLineKey(line)
        if (!key) {
            kept.push(line)
            continue
        }
        if (!keysToReplace.has(key)) {
            kept.push(line)
            continue
        }
        if (!written.has(key)) {
            kept.push(`${key}=${formatEnvValue(values[key])}`)
            written.add(key)
        }
    }

    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
    const missing = Object.entries(values).filter(([key]) => !written.has(key))
    if (missing.length > 0 && kept.length > 0) kept.push('')
    for (const [key, value] of missing) kept.push(`${key}=${formatEnvValue(value)}`)

    fs.writeFileSync(WORKSPACE_ENV_PATH, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(WORKSPACE_ENV_PATH, 0o600)
    } catch {
        // Best effort; some filesystems ignore chmod.
    }
}

function parseEnvLineKey(line: string): string | null {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
    const idx = normalized.indexOf('=')
    if (idx <= 0) return null
    return normalized.slice(0, idx).trim()
}

function cleanConfigValue(value: string | null | undefined): string {
    return stripEnvQuotes((value ?? '').replace(/[\r\n]/g, '').trim())
}

function stripEnvQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    return value
}

function formatEnvValue(value: string): string {
    if (value === '') return '""'
    if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
