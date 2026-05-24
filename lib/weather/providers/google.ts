import { readGoogleMapsApiKey } from '@/lib/maps/google-session'

import {
    fetchGoogleAirQuality,
    type GoogleAirQualityError,
} from '../google-air-quality'
import {
    fetchGoogleWeather,
    GoogleWeatherError,
} from '../google-weather'
import type {
    WeatherAvailability,
    WeatherFetchOptions,
    WeatherFetchResult,
    WeatherProviderClient,
} from './types'
import { WeatherProviderError } from './types'

// ---------------------------------------------------------------------------
// Google Weather provider adapter.
//
// Wraps the existing `fetchGoogleWeather()` + the new `fetchGoogleAirQuality`
// behind the `WeatherProviderClient` interface so WeatherShow can ask any
// provider the same questions. `isAvailable()` checks env presence + the
// existing 5-minute probe cache from `lib/integrations/weather.ts`.
//
// Geocoding is intentionally NOT exposed here — the WeatherShow tool reuses
// the maps integration's `geocodeAddresses()` for Google paths, since the
// maps key + Geocoding API are the same surface. Keeping the geocoding hop
// outside this file means the provider only worries about forecast data.
// ---------------------------------------------------------------------------

let probeCache: { result: WeatherAvailability; at: number } | null = null
const PROBE_TTL_MS = 5 * 60 * 1000

async function probeGoogleAvailability(): Promise<WeatherAvailability> {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return probeCache.result
    }
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) {
        const result: WeatherAvailability = {
            available: false,
            reason: 'GOOGLE_MAPS_API_KEY is not set',
        }
        probeCache = { result, at: Date.now() }
        return result
    }
    try {
        // Cheap probe coord (London) — see lib/integrations/weather.ts for
        // the reasoning. We don't reuse that module's cache directly because
        // this layer wants to make its own availability decision per call,
        // not depend on cross-module state.
        await fetchGoogleWeather({
            lat: 51.5074,
            lng: -0.1278,
            units: 'metric',
            days: 1,
            hours: 1,
        })
        const result: WeatherAvailability = { available: true }
        probeCache = { result, at: Date.now() }
        return result
    } catch (e) {
        const err = e as GoogleWeatherError | Error
        const detail = err instanceof GoogleWeatherError && err.upstream
            ? err.upstream
            : undefined
        const result: WeatherAvailability = {
            available: false,
            reason: err.message,
            detail,
        }
        probeCache = { result, at: Date.now() }
        return result
    }
}

export function invalidateGoogleProbe(): void {
    probeCache = null
}

export const googleWeatherProvider: WeatherProviderClient = {
    id: 'google',
    name: 'Google Weather',

    isAvailable: probeGoogleAvailability,

    async fetchWeather(opts: WeatherFetchOptions): Promise<WeatherFetchResult> {
        let weather
        try {
            weather = await fetchGoogleWeather({
                lat: opts.lat,
                lng: opts.lng,
                units: opts.units,
                days: opts.days,
                hours: opts.hours,
                languageCode: opts.languageCode,
            })
        } catch (e) {
            if (e instanceof GoogleWeatherError) {
                throw new WeatherProviderError('google', e.message, e.status, e.upstream)
            }
            throw e
        }

        // Air quality is best-effort — a separate Google API that may not
        // be enabled. We never let an AQ failure tank the weather response.
        let airQuality
        if (opts.includeAirQuality !== false) {
            try {
                airQuality = await fetchGoogleAirQuality({
                    lat: opts.lat,
                    lng: opts.lng,
                    languageCode: opts.languageCode,
                })
            } catch (e) {
                // Swallow: AQ is decorative. The orchestrator can surface
                // the upstream hint later if the user asks "why no AQ".
                const aqErr = e as GoogleAirQualityError | Error
                void aqErr // referenced for type narrowing only
                airQuality = undefined
            }
        }

        return {
            current: weather.current,
            hourly: weather.hourly,
            daily: weather.daily,
            airQuality,
            timezone: weather.timezone,
        }
    },
}
