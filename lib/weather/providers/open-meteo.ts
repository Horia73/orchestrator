import {
    fetchOpenMeteoAirQuality,
    fetchOpenMeteoForecast,
    geocodeOpenMeteo,
    OpenMeteoError,
} from '../open-meteo'
import type {
    WeatherAvailability,
    WeatherFetchOptions,
    WeatherFetchResult,
    WeatherGeocodeHit,
    WeatherProviderClient,
} from './types'
import { WeatherProviderError } from './types'

// ---------------------------------------------------------------------------
// Open-Meteo provider adapter.
//
// Keyless, so `isAvailable()` is essentially always "yes" — we still ping
// the upstream lazily once per process to fail fast in offline environments.
// ---------------------------------------------------------------------------

let probeCache: { result: WeatherAvailability; at: number } | null = null
const PROBE_TTL_MS = 30 * 60 * 1000 // 30 min — Open-Meteo rarely goes down

async function probeOpenMeteoAvailability(): Promise<WeatherAvailability> {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return probeCache.result
    }
    try {
        // Tiny request (1 day, 1 hour) over a guaranteed-data coordinate.
        await fetchOpenMeteoForecast({
            lat: 51.5074, lng: -0.1278, units: 'metric', days: 1, hours: 1,
        })
        const result: WeatherAvailability = { available: true }
        probeCache = { result, at: Date.now() }
        return result
    } catch (e) {
        const err = e as OpenMeteoError | Error
        const result: WeatherAvailability = {
            available: false,
            reason: err.message,
        }
        probeCache = { result, at: Date.now() }
        return result
    }
}

export function invalidateOpenMeteoProbe(): void {
    probeCache = null
}

export const openMeteoProvider: WeatherProviderClient = {
    id: 'open-meteo',
    name: 'Open-Meteo',

    isAvailable: probeOpenMeteoAvailability,

    async geocode(query: string, languageCode?: string): Promise<WeatherGeocodeHit | null> {
        try {
            const hit = await geocodeOpenMeteo(query, languageCode ?? 'en')
            return hit
        } catch (e) {
            // Geocoding errors aren't fatal — the WeatherShow tool decides
            // whether to retry with the other provider's geocoder.
            const err = e as OpenMeteoError | Error
            throw new WeatherProviderError('open-meteo', `geocode: ${err.message}`)
        }
    },

    async fetchWeather(opts: WeatherFetchOptions): Promise<WeatherFetchResult> {
        let result
        try {
            result = await fetchOpenMeteoForecast({
                lat: opts.lat, lng: opts.lng, units: opts.units,
                days: opts.days, hours: opts.hours, languageCode: opts.languageCode,
            })
        } catch (e) {
            if (e instanceof OpenMeteoError) {
                throw new WeatherProviderError('open-meteo', e.message, e.status, e.upstream)
            }
            throw e
        }

        let airQuality
        if (opts.includeAirQuality !== false) {
            // Open-Meteo's AQ endpoint is keyless and free — best-effort,
            // null-tolerant. Never lets AQ fail the parent call.
            try {
                const aq = await fetchOpenMeteoAirQuality(opts.lat, opts.lng)
                if (aq) airQuality = aq
            } catch { /* ignore */ }
        }

        return {
            current: result.current,
            hourly: result.hourly,
            daily: result.daily,
            airQuality,
            timezone: result.timezone,
        }
    },
}
