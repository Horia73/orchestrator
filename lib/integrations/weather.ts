import { readGoogleMapsApiKey } from '@/lib/maps/google-session'
import { fetchGoogleWeather, GoogleWeatherError } from '@/lib/weather/google-weather'
import { openMeteoProvider } from '@/lib/weather/providers/open-meteo'

// ---------------------------------------------------------------------------
// Weather integration — connection status.
//
// Google Weather is an optional upgrade: "configured" means
// GOOGLE_MAPS_API_KEY is present.
// Open-Meteo is keyless and remains the fallback. Therefore the top-level
// "connected" flag means at least one provider can answer, while the nested
// `google` object reports the Google-specific Weather API probe.
//
// There is no OAuth; the key is set via SetEnv or .env.local.
// The Weather API enable step is separate from Google Geocoding —
// surfacing a clear connected/needsReconnect flag is what saves the user
// a confused "why doesn't Google work" loop while still making clear that
// forecasts render through Open-Meteo when Google is unavailable.
// ---------------------------------------------------------------------------

export interface WeatherIntegrationStatus {
    id: 'weather'
    name: string
    description: string
    /** Google Maps Platform key is set. */
    configured: boolean
    /** At least one provider can answer. */
    connected: boolean
    /** True when the key is set but the Google probe failed — usually means the
     *  Weather API isn't enabled on the project, or the key restrictions
     *  block server-to-server calls. */
    needsReconnect: boolean
    /** Last provider error from a failed probe, if any. Includes Google's verbatim
     *  message (which carries the enable-API URL when SERVICE_DISABLED). */
    error?: string
    google: {
        configured: boolean
        connected: boolean
        needsReconnect: boolean
        error?: string
    }
    openMeteo: {
        available: boolean
        error?: string
    }
    anyProviderReady: boolean
    providerInUse: 'google' | 'open-meteo' | null
}

let probeCache: { connected: boolean; error?: string; at: number } | null = null
const PROBE_TTL_MS = 5 * 60 * 1000

/**
 * Cheap, deterministic probe coordinates. London (1°W, 51°N) — Google
 * always has data for it, and the request is small. We don't reuse the
 * user's location because (a) we may not know it yet and (b) we want the
 * probe to be cacheable across users / requests on the same machine.
 */
const PROBE_LAT = 51.5074
const PROBE_LNG = -0.1278

async function probeConnection(): Promise<{ connected: boolean; error?: string }> {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return { connected: probeCache.connected, error: probeCache.error }
    }
    try {
        // Smallest possible call — only need to confirm the API answers.
        // `fetchGoogleWeather` runs current+daily+hourly in parallel; for a
        // probe a single currentConditions hit would be enough but the
        // shared client doesn't expose it standalone. The cost is a few
        // hundredths of a cent every 5 minutes worst case, far below the
        // free credit.
        await fetchGoogleWeather({
            lat: PROBE_LAT,
            lng: PROBE_LNG,
            units: 'metric',
            days: 1,
            hours: 1,
        })
        probeCache = { connected: true, at: Date.now() }
        return { connected: true }
    } catch (e) {
        const err = e as GoogleWeatherError | Error
        const msg = formatProbeError(err)
        probeCache = { connected: false, error: msg, at: Date.now() }
        return { connected: false, error: msg }
    }
}

function formatProbeError(err: GoogleWeatherError | Error): string {
    if (err instanceof GoogleWeatherError) {
        // Forward Google's JSON body when present — it usually contains the
        // exact enable-API URL when SERVICE_DISABLED or the billing-status
        // detail when BILLING_DISABLED.
        if (err.upstream) {
            return `${err.message}: ${err.upstream}`
        }
        return err.message
    }
    return err.message
}

export async function getWeatherIntegrationStatus(useCachedProbe = true): Promise<WeatherIntegrationStatus> {
    const apiKey = readGoogleMapsApiKey()
    const configured = !!apiKey
    const base = {
        id: 'weather' as const,
        name: 'Weather',
        description: 'Live forecasts, AQI, and pollen for any location, rendered as inline iOS-style weather cards. Google Weather/Air Quality/Pollen are preferred when configured; Open-Meteo works without a key.',
    }
    if (!useCachedProbe) probeCache = null
    const [probe, omAvail] = await Promise.all([
        configured ? probeConnection() : Promise.resolve({ connected: false, error: undefined }),
        openMeteoProvider.isAvailable(),
    ])
    const googleConnected = configured && probe.connected
    const anyProviderReady = googleConnected || omAvail.available
    const googleNeedsReconnect = configured && !googleConnected
    return {
        ...base,
        configured,
        connected: anyProviderReady,
        needsReconnect: googleNeedsReconnect,
        error: googleNeedsReconnect
            ? probe.error
            : (!anyProviderReady ? omAvail.reason : undefined),
        google: {
            configured,
            connected: googleConnected,
            needsReconnect: googleNeedsReconnect,
            error: probe.error,
        },
        openMeteo: {
            available: omAvail.available,
            error: omAvail.reason,
        },
        anyProviderReady,
        providerInUse: googleConnected ? 'google' : (omAvail.available ? 'open-meteo' : null),
    }
}

/** Invalidate the connection probe — call after SetEnv writes a new key or
 *  after the user enables the Weather API so the next status read re-probes. */
export function invalidateWeatherConnectionProbe(): void {
    probeCache = null
}
