import type { IntegrationStatusKind } from '@/lib/integrations/manifest'
import { getGmailIntegrationStatus } from '@/lib/integrations/gmail'
import { getGoogleCalendarIntegrationStatus } from '@/lib/integrations/google-calendar'
import { getGoogleDriveIntegrationStatus } from '@/lib/integrations/google-drive'
import { getWhatsAppIntegrationStatus } from '@/lib/integrations/whatsapp'
import { getHomeAssistantIntegrationStatus } from '@/lib/integrations/home-assistant'
import { getMapsIntegrationStatus } from '@/lib/integrations/maps'
import { getWeatherIntegrationStatus } from '@/lib/integrations/weather'
import { getRemoteMcpIntegrationStatus } from '@/lib/integrations/mcp'
import { resolveAppOrigin } from '@/lib/app-origin'
import { getLocationIntelligenceStatus } from '@/lib/location-intelligence/journal'
import { getActiveProfileId } from '@/lib/profiles/context'

// ---------------------------------------------------------------------------
// Connection-status snapshot.
//
// Prompt builders are synchronous, but integration status checks are async
// (and some hit the network). We keep a process-local stale-while-revalidate
// cache: prompt builds read the last known snapshot synchronously and, when it
// is stale, kick off a non-blocking refresh for the next turn. The Settings UI
// poll (/api/integrations/status) also warms this cache, so in practice the
// snapshot is fresh by the time the orchestrator needs it.
// ---------------------------------------------------------------------------

export type IntegrationConnState =
    | 'connected'
    | 'resumable'
    | 'needs_reconnect'
    | 'configured'
    | 'not_configured'
    | 'disabled'
    | 'unknown'

export interface IntegrationStateEntry {
    state: IntegrationConnState
    /** Short human detail, e.g. the connected account email. Never a secret. */
    detail?: string
}

export type IntegrationStatusSnapshot = Record<IntegrationStatusKind, IntegrationStateEntry>

const UNKNOWN: IntegrationStateEntry = { state: 'unknown' }

function emptySnapshot(): IntegrationStatusSnapshot {
    return {
        'gmail': UNKNOWN,
        'google-calendar': UNKNOWN,
        'google-drive': UNKNOWN,
        'whatsapp': UNKNOWN,
        'home-assistant': UNKNOWN,
        'maps': UNKNOWN,
        'weather': UNKNOWN,
        'location-intelligence': UNKNOWN,
        'mcp': UNKNOWN,
    }
}

interface StatusLike {
    configured?: boolean
    connected?: boolean
    needsReconnect?: boolean
}

function deriveState(s: StatusLike | null | undefined): IntegrationConnState {
    if (!s) return 'unknown'
    if (s.needsReconnect) return 'needs_reconnect'
    if (s.connected) return 'connected'
    if (s.configured) return 'configured'
    return 'not_configured'
}

function entry(s: StatusLike | null | undefined, detail?: string | null): IntegrationStateEntry {
    const state = deriveState(s)
    return detail && (state === 'connected' || state === 'needs_reconnect')
        ? { state, detail }
        : { state }
}

// Minimal structural shapes — avoid importing the heavy integration interfaces.
type Gmailish = StatusLike & { accountEmail?: string | null }
type Calendarish = StatusLike & { accountEmail?: string | null }
type Driveish = StatusLike & { accountEmail?: string | null; accountName?: string | null }
type WhatsAppish = StatusLike & {
    provider?: string | null
    sessionStored?: boolean
    phoneNumber?: string | null
    accountName?: string | null
}
type HomeAssistantish = StatusLike & { locationName?: string | null; baseUrl?: string | null }
type Mapsish = StatusLike & { error?: string | null }
type Weatherish = StatusLike & {
    error?: string | null
    providerInUse?: 'google' | 'open-meteo' | null
    google?: { connected?: boolean; error?: string | null }
    openMeteo?: { available?: boolean; error?: string | null }
}
type LocationIntelligenceish = StatusLike & {
    enabled?: boolean
    source?: { label?: string | null; entityId?: string | null }
    journal?: { lastDate?: string | null; dayCount?: number | null }
}
type RemoteMcpish = StatusLike & {
    serverCount?: number
    connectedServerCount?: number
}

function whatsappEntry(s: WhatsAppish | null | undefined): IntegrationStateEntry {
    if (s?.provider === 'disabled') return { state: 'disabled' }
    if (s?.provider === 'baileys' && !s.connected && s.sessionStored && !s.needsReconnect) {
        const detail = s.phoneNumber ?? s.accountName
        return detail ? { state: 'resumable', detail } : { state: 'resumable' }
    }
    return entry(s, s?.phoneNumber ?? s?.accountName)
}

export interface RawStatuses {
    gmail?: Gmailish | null
    googleCalendar?: Calendarish | null
    googleDrive?: Driveish | null
    whatsapp?: WhatsAppish | null
    homeAssistant?: HomeAssistantish | null
    maps?: Mapsish | null
    weather?: Weatherish | null
    locationIntelligence?: LocationIntelligenceish | null
    mcp?: RemoteMcpish | null
}

/** Build a snapshot from already-computed status objects (used by the UI status route too). */
export function snapshotFromStatuses(raw: RawStatuses): IntegrationStatusSnapshot {
    return {
        'gmail': entry(raw.gmail, raw.gmail?.accountEmail),
        'google-calendar': entry(raw.googleCalendar, raw.googleCalendar?.accountEmail),
        'google-drive': entry(raw.googleDrive, raw.googleDrive?.accountEmail ?? raw.googleDrive?.accountName),
        'whatsapp': whatsappEntry(raw.whatsapp),
        'home-assistant': entry(raw.homeAssistant, raw.homeAssistant?.locationName ?? raw.homeAssistant?.baseUrl),
        // Maps doesn't have an account identity to surface as a detail —
        // when needsReconnect we forward the Google error so the
        // orchestrator can read it from the always-on integrations block.
        'maps': entry(raw.maps, raw.maps?.error ?? null),
        'weather': entry(raw.weather, weatherDetail(raw.weather)),
        'location-intelligence': entry(raw.locationIntelligence, locationIntelligenceDetail(raw.locationIntelligence)),
        'mcp': entry(raw.mcp, remoteMcpDetail(raw.mcp)),
    }
}

const TTL_MS = 60_000

interface SnapshotCacheEntry {
    cached: IntegrationStatusSnapshot | null
    fetchedAt: number
    inFlight: Promise<void> | null
}

const cacheByProfile = new Map<string, SnapshotCacheEntry>()

/** Reachable Orchestrator origin captured from the last request; status fns need it. */
let lastKnownOrigin: string | undefined

export function rememberOrigin(origin: string | undefined): void {
    if (origin && origin.trim()) lastKnownOrigin = origin.trim()
}

/**
 * Best available origin for status checks. Order: explicit caller arg, then
 * the last origin seen by any prior request, then the configured app origin
 * (`ORCHESTRATOR_PUBLIC_URL` / fallback `http://localhost:3000`). The fallback
 * matters for callers that have no request context (scheduler, microscripts,
 * MCP) — without it, a cold cache stays cold and integration gates report
 * `unknown` forever.
 */
function resolveSnapshotOrigin(origin?: string): string {
    const explicit = origin && origin.trim()
    if (explicit) return explicit
    if (lastKnownOrigin) return lastKnownOrigin
    return resolveAppOrigin()
}

async function fetchSnapshot(origin: string): Promise<IntegrationStatusSnapshot> {
    const [gmail, googleCalendar, googleDrive, whatsapp, homeAssistant, maps, weather, locationIntelligence, mcp] = await Promise.allSettled([
        getGmailIntegrationStatus(origin, true),
        getGoogleCalendarIntegrationStatus(origin, true),
        getGoogleDriveIntegrationStatus(origin, true),
        getWhatsAppIntegrationStatus(origin),
        getHomeAssistantIntegrationStatus(true),
        getMapsIntegrationStatus(true),
        getWeatherIntegrationStatus(true),
        Promise.resolve(getLocationIntelligenceStatus()),
        getRemoteMcpIntegrationStatus(origin, true),
    ])
    const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null)
    return snapshotFromStatuses({
        gmail: val(gmail),
        googleCalendar: val(googleCalendar),
        googleDrive: val(googleDrive),
        whatsapp: val(whatsapp),
        homeAssistant: val(homeAssistant),
        maps: val(maps),
        weather: val(weather),
        locationIntelligence: val(locationIntelligence),
        mcp: val(mcp),
    })
}

/** Refresh the cache now. Awaitable for callers that can afford it (e.g. the status route). */
export async function refreshIntegrationStatusSnapshot(origin?: string): Promise<IntegrationStatusSnapshot> {
    const useOrigin = resolveSnapshotOrigin(origin)
    rememberOrigin(useOrigin)
    const snapshot = await fetchSnapshot(useOrigin)
    const cache = activeCacheEntry()
    cache.cached = snapshot
    cache.fetchedAt = Date.now()
    return snapshot
}

/**
 * Synchronous read for prompt builders. Returns the last known snapshot
 * immediately; if it is stale (or absent), schedules a non-blocking refresh
 * so the *next* turn is accurate. A cold cache returns all-`unknown` for this
 * turn, which the prompt block renders as "verify with the runbook".
 */
export function getIntegrationStatusSnapshot(origin?: string): IntegrationStatusSnapshot {
    rememberOrigin(origin)
    const cache = activeCacheEntry()
    const fresh = cache.cached && Date.now() - cache.fetchedAt < TTL_MS
    if (!fresh && !cache.inFlight) {
        cache.inFlight = refreshIntegrationStatusSnapshot(origin)
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => { cache.inFlight = null })
    }
    return cache.cached ?? emptySnapshot()
}

/** Merge externally-computed statuses into the cache (called by the UI status route). */
export function recordIntegrationStatuses(raw: RawStatuses): void {
    const cache = activeCacheEntry()
    const previous = cache.cached ?? emptySnapshot()
    cache.cached = {
        'gmail': hasOwn(raw, 'gmail') ? entry(raw.gmail, raw.gmail?.accountEmail) : previous.gmail,
        'google-calendar': hasOwn(raw, 'googleCalendar') ? entry(raw.googleCalendar, raw.googleCalendar?.accountEmail) : previous['google-calendar'],
        'google-drive': hasOwn(raw, 'googleDrive') ? entry(raw.googleDrive, raw.googleDrive?.accountEmail ?? raw.googleDrive?.accountName) : previous['google-drive'],
        'whatsapp': hasOwn(raw, 'whatsapp') ? whatsappEntry(raw.whatsapp) : previous.whatsapp,
        'home-assistant': hasOwn(raw, 'homeAssistant') ? entry(raw.homeAssistant, raw.homeAssistant?.locationName ?? raw.homeAssistant?.baseUrl) : previous['home-assistant'],
        'maps': hasOwn(raw, 'maps') ? entry(raw.maps, raw.maps?.error ?? null) : previous.maps,
        'weather': hasOwn(raw, 'weather') ? entry(raw.weather, weatherDetail(raw.weather)) : previous.weather,
        'location-intelligence': hasOwn(raw, 'locationIntelligence') ? entry(raw.locationIntelligence, locationIntelligenceDetail(raw.locationIntelligence)) : previous['location-intelligence'],
        'mcp': hasOwn(raw, 'mcp') ? entry(raw.mcp, remoteMcpDetail(raw.mcp)) : previous.mcp,
    }
    cache.fetchedAt = Date.now()
}

function activeCacheEntry(): SnapshotCacheEntry {
    const profileId = getActiveProfileId()
    const existing = cacheByProfile.get(profileId)
    if (existing) return existing
    const created: SnapshotCacheEntry = {
        cached: null,
        fetchedAt: 0,
        inFlight: null,
    }
    cacheByProfile.set(profileId, created)
    return created
}

function weatherDetail(weather: Weatherish | null | undefined): string | null {
    if (!weather) return null
    if (weather.needsReconnect && weather.google?.error) return weather.google.error
    if (weather.providerInUse === 'google') return 'Google Weather'
    if (weather.providerInUse === 'open-meteo') return 'Open-Meteo fallback'
    return weather.error ?? weather.openMeteo?.error ?? null
}

function locationIntelligenceDetail(status: LocationIntelligenceish | null | undefined): string | null {
    if (!status) return null
    if (status.journal?.lastDate) return `latest day ${status.journal.lastDate}`
    if (typeof status.journal?.dayCount === 'number') return `${status.journal.dayCount} days`
    if (status.source?.label) return status.source.label
    if (status.source?.entityId) return status.source.entityId
    if (status.enabled === false) return 'disabled'
    return null
}

function remoteMcpDetail(status: RemoteMcpish | null | undefined): string | null {
    if (!status) return null
    if (
        typeof status.connectedServerCount === 'number' &&
        typeof status.serverCount === 'number'
    ) {
        return `${status.connectedServerCount}/${status.serverCount} servers connected`
    }
    if (typeof status.serverCount === 'number') return `${status.serverCount} servers configured`
    return null
}

function hasOwn<T extends object>(obj: T, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key)
}
