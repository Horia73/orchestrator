import type { IntegrationStatusKind } from '@/lib/integrations/manifest'
import { getGmailIntegrationStatus } from '@/lib/integrations/gmail'
import { getGoogleCalendarIntegrationStatus } from '@/lib/integrations/google-calendar'
import { getGoogleDriveIntegrationStatus } from '@/lib/integrations/google-drive'
import { getWhatsAppIntegrationStatus } from '@/lib/integrations/whatsapp'
import { getHomeAssistantIntegrationStatus } from '@/lib/integrations/home-assistant'

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
    | 'needs_reconnect'
    | 'configured'
    | 'not_configured'
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
type WhatsAppish = StatusLike & { phoneNumber?: string | null; accountName?: string | null }
type HomeAssistantish = StatusLike & { locationName?: string | null; baseUrl?: string | null }

export interface RawStatuses {
    gmail?: Gmailish | null
    googleCalendar?: Calendarish | null
    googleDrive?: Driveish | null
    whatsapp?: WhatsAppish | null
    homeAssistant?: HomeAssistantish | null
}

/** Build a snapshot from already-computed status objects (used by the UI status route too). */
export function snapshotFromStatuses(raw: RawStatuses): IntegrationStatusSnapshot {
    return {
        'gmail': entry(raw.gmail, raw.gmail?.accountEmail),
        'google-calendar': entry(raw.googleCalendar, raw.googleCalendar?.accountEmail),
        'google-drive': entry(raw.googleDrive, raw.googleDrive?.accountEmail ?? raw.googleDrive?.accountName),
        'whatsapp': entry(raw.whatsapp, raw.whatsapp?.phoneNumber ?? raw.whatsapp?.accountName),
        'home-assistant': entry(raw.homeAssistant, raw.homeAssistant?.locationName ?? raw.homeAssistant?.baseUrl),
    }
}

const TTL_MS = 60_000

let cached: IntegrationStatusSnapshot | null = null
let fetchedAt = 0
let inFlight: Promise<void> | null = null

/** Reachable Orchestrator origin captured from the last request; status fns need it. */
let lastKnownOrigin: string | undefined

export function rememberOrigin(origin: string | undefined): void {
    if (origin && origin.trim()) lastKnownOrigin = origin.trim()
}

async function fetchSnapshot(origin: string): Promise<IntegrationStatusSnapshot> {
    const [gmail, googleCalendar, googleDrive, whatsapp, homeAssistant] = await Promise.allSettled([
        getGmailIntegrationStatus(origin, true),
        getGoogleCalendarIntegrationStatus(origin, true),
        getGoogleDriveIntegrationStatus(origin, true),
        getWhatsAppIntegrationStatus(origin),
        getHomeAssistantIntegrationStatus(true),
    ])
    const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null)
    return snapshotFromStatuses({
        gmail: val(gmail),
        googleCalendar: val(googleCalendar),
        googleDrive: val(googleDrive),
        whatsapp: val(whatsapp),
        homeAssistant: val(homeAssistant),
    })
}

/** Refresh the cache now. Awaitable for callers that can afford it (e.g. the status route). */
export async function refreshIntegrationStatusSnapshot(origin?: string): Promise<IntegrationStatusSnapshot> {
    const useOrigin = (origin && origin.trim()) || lastKnownOrigin
    if (!useOrigin) return cached ?? emptySnapshot()
    rememberOrigin(useOrigin)
    const snapshot = await fetchSnapshot(useOrigin)
    cached = snapshot
    fetchedAt = Date.now()
    return snapshot
}

/**
 * Synchronous read for prompt builders. Returns the last known snapshot
 * immediately; if it is stale (or absent) and an origin is known, schedules a
 * non-blocking refresh so the *next* turn is accurate. A cold cache returns
 * all-`unknown`, which the prompt block renders as "verify with the runbook".
 */
export function getIntegrationStatusSnapshot(origin?: string): IntegrationStatusSnapshot {
    rememberOrigin(origin)
    const fresh = cached && Date.now() - fetchedAt < TTL_MS
    if (!fresh && !inFlight && (lastKnownOrigin || origin)) {
        inFlight = refreshIntegrationStatusSnapshot(origin)
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => { inFlight = null })
    }
    return cached ?? emptySnapshot()
}

/** Merge externally-computed statuses into the cache (called by the UI status route). */
export function recordIntegrationStatuses(raw: RawStatuses): void {
    cached = snapshotFromStatuses(raw)
    fetchedAt = Date.now()
}
