import { readGoogleMapsApiKey } from '@/lib/maps/google-session'

import { aqiLabel as universalAqiLabel } from './weather-codes'
import type { WeatherAirQuality } from './schema'

// ---------------------------------------------------------------------------
// Google Air Quality API client.
//
// Endpoint:
//   POST https://airquality.googleapis.com/v1/currentConditions:lookup
//   { "location": { "latitude": LAT, "longitude": LNG },
//     "extraComputations": ["LOCAL_AQI", "POLLUTANT_CONCENTRATION", ...],
//     "languageCode": "en" }
//
// Uses `GOOGLE_MAPS_API_KEY`, but the **Air Quality API** must be separately
// enabled in the GCP project at:
//   https://console.cloud.google.com/apis/library/airquality.googleapis.com
//
// We request `LOCAL_AQI` (which gives the country-specific scale most
// users in EU expect — CAQI, AQI-China, etc. depending on location) PLUS
// pollutant concentrations so the renderer can show PM2.5/PM10/ozone.
//
// Returns null when AQ is unavailable — the caller treats AQ as decorative
// and proceeds without it.
// ---------------------------------------------------------------------------

const AQ_BASE = 'https://airquality.googleapis.com/v1/currentConditions:lookup'

interface GoogleAqResponse {
    dateTime?: string
    regionCode?: string
    indexes?: Array<{
        code?: string
        displayName?: string
        aqi?: number
        aqiDisplay?: string
        category?: string
        dominantPollutant?: string
    }>
    pollutants?: Array<{
        code?: string
        displayName?: string
        fullName?: string
        concentration?: { value?: number; units?: string }
    }>
    healthRecommendations?: Record<string, string>
}

export interface FetchAirQualityOptions {
    lat: number
    lng: number
    languageCode?: string
}

export class GoogleAirQualityError extends Error {
    constructor(message: string, public readonly status?: number, public readonly upstream?: string) {
        super(message)
        this.name = 'GoogleAirQualityError'
    }
}

/**
 * Fetch current air quality at the given coordinate. Returns the canonical
 * `WeatherAirQuality` shape so the renderer doesn't need to know which API
 * produced it.
 *
 * Picks the LOCAL index when present (matches what residents expect — e.g.
 * CAQI for EU), falls back to UAQI (Google's universal scale) otherwise.
 */
export async function fetchGoogleAirQuality(opts: FetchAirQualityOptions): Promise<WeatherAirQuality> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) throw new GoogleAirQualityError('GOOGLE_MAPS_API_KEY is not set')

    const url = new URL(AQ_BASE)
    url.searchParams.set('key', apiKey)

    const body = {
        location: { latitude: opts.lat, longitude: opts.lng },
        extraComputations: ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION'],
        languageCode: opts.languageCode ?? 'en',
    }

    let resp: Response
    try {
        resp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    } catch (e) {
        throw new GoogleAirQualityError(`network: ${(e as Error).message}`)
    }
    if (!resp.ok) {
        let text = ''
        try { text = await resp.text() } catch { /* ignore */ }
        throw new GoogleAirQualityError(
            `Google Air Quality API HTTP ${resp.status}`,
            resp.status,
            text || undefined,
        )
    }
    let data: GoogleAqResponse
    try {
        data = await resp.json() as GoogleAqResponse
    } catch (e) {
        throw new GoogleAirQualityError(`bad json: ${(e as Error).message}`)
    }

    // Pick the LOCAL index if Google returned one (matches local expectation,
    // e.g. CAQI for EU residents), otherwise UAQI (Universal Air Quality
    // Index — Google's global scale).
    const indexes = data.indexes ?? []
    const local = indexes.find(i => (i.code ?? '').endsWith('caqi')
        || (i.code ?? '').endsWith('eaqi')
        || (i.code ?? '').endsWith('_aqi'))
    const universal = indexes.find(i => (i.code ?? '').toLowerCase() === 'uaqi')
    const chosen = local ?? universal ?? indexes[0]
    if (!chosen || typeof chosen.aqi !== 'number') {
        throw new GoogleAirQualityError('Google Air Quality returned no usable index')
    }

    // Pollutants — match by code, picked from Google's standard list.
    const pollutants = data.pollutants ?? []
    const pm25 = pickPollutant(pollutants, 'pm25')
    const pm10 = pickPollutant(pollutants, 'pm10')
    const ozone = pickPollutant(pollutants, 'o3')

    return {
        aqi: chosen.aqi,
        aqiLabel: chosen.category?.trim() || universalAqiLabel(chosen.aqi),
        pm25,
        pm10,
        ozone,
    }
}

function pickPollutant(arr: NonNullable<GoogleAqResponse['pollutants']>, code: string): number | undefined {
    const match = arr.find(p => (p.code ?? '').toLowerCase() === code.toLowerCase())
    const value = match?.concentration?.value
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.round(value * 10) / 10
}
