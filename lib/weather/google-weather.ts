import { readGoogleMapsApiKey } from '@/lib/maps/google-session'

import {
    googleTypeToCondition,
    conditionLabel as fallbackLabel,
    conditionLabelForLocale,
} from './weather-codes'
import type {
    WeatherArtifact,
    WeatherCondition,
    WeatherCurrent,
    WeatherDaily,
    WeatherHourly,
    WeatherLocation,
    WeatherUnits,
} from './schema'

// ---------------------------------------------------------------------------
// Google Weather API client.
//
// Three endpoints under https://weather.googleapis.com/v1/:
//   - currentConditions:lookup       → live observation
//   - forecast/days:lookup           → up to 10 days
//   - forecast/hours:lookup          → up to 240 hours; we ask for 24
//
// All three accept the same `key=...` query param as Maps JS/Geocoding,
// but the **Weather API** must be enabled separately in the GCP project at
// https://console.cloud.google.com/apis/library/weather.googleapis.com — the
// most common cause of `connected: false` here, mirroring Google's separate
// enable step for Maps JavaScript and Geocoding.
//
// Pricing: ~$0.001 / current call, ~$0.003 / forecast call. Covered by the
// $200/month free credit at any single-user volume.
//
// This module returns CANONICAL `WeatherArtifact` data (minus location +
// fetchedAt + provider which the caller fills in based on what they geocoded).
// All unit conversion happens here so the schema sees clean numbers.
// ---------------------------------------------------------------------------

const GOOGLE_WEATHER_BASE = 'https://weather.googleapis.com/v1'

/** Default forecast horizon. iOS Weather shows 10 days; Google supports
 *  up to 10 in a single call. */
const DEFAULT_DAILY_HORIZON = 10
const MAX_DAILY_HORIZON = 10

/** Hourly horizon. iOS Weather shows ~24h in the scrollable strip;
 *  Google supports up to 240. We default to a single-day window but
 *  callers commonly pass hours = days × 24 so daily-row expansion has
 *  hourly data for every visible day. */
const DEFAULT_HOURLY_HORIZON = 24
const MAX_HOURLY_HORIZON = 240

// --- raw response types ----------------------------------------------------

/** Subset of Google's response we actually consume. Strings/objects we don't
 *  use are omitted from the typing — Google may add fields without breaking
 *  this client. */
interface GoogleQuantity {
    /** Numeric quantity. Always present when the parent is. */
    value?: number
    /** Alternate name Google uses on some sub-fields (e.g. wind speed). */
    quantity?: number
    /** Unit suffix: "CELSIUS", "KILOMETERS_PER_HOUR", "MILLIMETERS", … */
    unit?: string
}

interface GoogleCondition {
    type?: string
    description?: { text?: string; languageCode?: string }
    iconBaseUri?: string
}

interface GoogleCurrentResponse {
    currentTime?: string
    timeZone?: { id?: string }
    isDaytime?: boolean
    weatherCondition?: GoogleCondition
    temperature?: { degrees?: number; unit?: string }
    feelsLikeTemperature?: { degrees?: number; unit?: string }
    dewPoint?: { degrees?: number; unit?: string }
    relativeHumidity?: number
    uvIndex?: number
    precipitation?: {
        probability?: { percent?: number; type?: string }
        qpf?: GoogleQuantity
    }
    airPressure?: { meanSeaLevelMillibars?: number }
    wind?: {
        direction?: { degrees?: number; cardinal?: string }
        speed?: GoogleQuantity
        gust?: GoogleQuantity
    }
    visibility?: GoogleQuantity
    cloudCover?: number
}

interface GoogleForecastDay {
    interval?: { startTime?: string; endTime?: string }
    displayDate?: { year: number; month: number; day: number }
    daytimeForecast?: GoogleHalfDayForecast
    nighttimeForecast?: GoogleHalfDayForecast
    maxTemperature?: { degrees?: number; unit?: string }
    minTemperature?: { degrees?: number; unit?: string }
    feelsLikeMaxTemperature?: { degrees?: number; unit?: string }
    feelsLikeMinTemperature?: { degrees?: number; unit?: string }
    sunEvents?: { sunriseTime?: string; sunsetTime?: string }
    maxHeatIndex?: { degrees?: number; unit?: string }
}

interface GoogleHalfDayForecast {
    interval?: { startTime?: string; endTime?: string }
    weatherCondition?: GoogleCondition
    relativeHumidity?: number
    uvIndex?: number
    precipitation?: {
        probability?: { percent?: number; type?: string }
        qpf?: GoogleQuantity
        snowQpf?: GoogleQuantity
    }
    thunderstormProbability?: number
    wind?: {
        direction?: { degrees?: number; cardinal?: string }
        speed?: GoogleQuantity
        gust?: GoogleQuantity
    }
    cloudCover?: number
}

interface GoogleForecastDaysResponse {
    forecastDays?: GoogleForecastDay[]
    timeZone?: { id?: string }
    nextPageToken?: string
}

interface GoogleForecastHour {
    interval?: { startTime?: string; endTime?: string }
    displayDateTime?: { year: number; month: number; day: number; hours: number; minutes?: number }
    isDaytime?: boolean
    weatherCondition?: GoogleCondition
    temperature?: { degrees?: number; unit?: string }
    feelsLikeTemperature?: { degrees?: number; unit?: string }
    relativeHumidity?: number
    uvIndex?: number
    precipitation?: {
        probability?: { percent?: number; type?: string }
        qpf?: GoogleQuantity
    }
    wind?: {
        direction?: { degrees?: number; cardinal?: string }
        speed?: GoogleQuantity
        gust?: GoogleQuantity
    }
    cloudCover?: number
}

interface GoogleForecastHoursResponse {
    forecastHours?: GoogleForecastHour[]
    /** Google history.hours.lookup returns the same hour shape under this key. */
    historyHours?: GoogleForecastHour[]
    timeZone?: { id?: string }
    nextPageToken?: string
}

// --- unit conversion -------------------------------------------------------

/**
 * Google returns whichever unit suits the request — we always ask for
 * METRIC and convert client-side when the artifact requested imperial.
 * Keeping conversion in one place means the schema sees consistent values
 * regardless of what the upstream returned.
 */
function convertTemp(celsius: number, units: WeatherUnits): number {
    return units === 'metric' ? celsius : celsius * 9 / 5 + 32
}

function convertDistance(km: number, units: WeatherUnits): number {
    // km → miles for imperial.
    return units === 'metric' ? km : km * 0.621371
}

function convertSpeed(kph: number, units: WeatherUnits): number {
    // Google returns wind in km/h when METRIC. Convert to m/s for metric
    // (matches Open-Meteo + most European convention) and mph for imperial.
    return units === 'metric' ? kph / 3.6 : kph * 0.621371
}

function convertPrecip(mm: number, units: WeatherUnits): number {
    return units === 'metric' ? mm : mm / 25.4
}

// --- helpers ---------------------------------------------------------------

function readNum(n: number | undefined | null, fallback = 0): number {
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n))
}

function isoDateInTimezone(ts: string | undefined | null): string {
    if (!ts) return new Date().toISOString().slice(0, 10)
    // Google returns timestamps in RFC3339 with the location's offset. The
    // first 10 chars are already YYYY-MM-DD in the requested timezone.
    if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10)
    return new Date(ts).toISOString().slice(0, 10)
}

function deriveCondition(cond: GoogleCondition | undefined, languageCode?: string): {
    condition: WeatherCondition
    label: string
} {
    const condition = googleTypeToCondition(cond?.type)
    const upstreamLabel = cond?.description?.text?.trim()
    const label = shouldUseLocalLabel(upstreamLabel, languageCode)
        ? conditionLabelForLocale(condition, languageCode)
        : upstreamLabel || fallbackLabel(condition)
    return { condition, label }
}

function shouldUseLocalLabel(upstreamLabel: string | undefined, languageCode: string | undefined): boolean {
    const lang = languageCode?.toLowerCase() ?? ''
    if (lang === 'ro' || lang.startsWith('ro-')) return true
    if (!upstreamLabel) return false
    return /^ștergeți$/i.test(upstreamLabel) || /^stergeti$/i.test(upstreamLabel)
}

// --- API calls -------------------------------------------------------------

interface FetchOptions {
    lat: number
    lng: number
    units: WeatherUnits
    /** Forecast days, 1..10. Defaults to 10. */
    days?: number
    /** Forecast hours, 1..240. Defaults to 24. */
    hours?: number
    /** BCP-47 language code for condition descriptions ("en", "ro", …). */
    languageCode?: string
}

/** Shape returned by the in-house fetcher: the schema's `WeatherArtifact`
 *  minus the location + fetchedAt + provider fields, which the caller
 *  (the WeatherShow tool) supplies once geocoding is known. */
export interface GoogleWeatherResult {
    current: WeatherCurrent
    hourly: WeatherHourly[]
    daily: WeatherDaily[]
    /** IANA timezone Google reported alongside the data. The caller can use
     *  this as a fallback when geocoding didn't return one. */
    timezone: string | undefined
}

export class GoogleWeatherError extends Error {
    constructor(message: string, public readonly status?: number, public readonly upstream?: string) {
        super(message)
        this.name = 'GoogleWeatherError'
    }
}

async function callWeatherApi<T>(path: string, params: Record<string, string>): Promise<T> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) {
        throw new GoogleWeatherError('GOOGLE_MAPS_API_KEY is not set')
    }
    const url = new URL(`${GOOGLE_WEATHER_BASE}${path}`)
    url.searchParams.set('key', apiKey)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    let resp: Response
    try {
        resp = await fetch(url.toString())
    } catch (e) {
        throw new GoogleWeatherError(`network: ${(e as Error).message}`)
    }
    if (!resp.ok) {
        let body = ''
        try { body = await resp.text() } catch { /* ignore */ }
        // Google encodes the actionable hint (enable-API URL, billing
        // status, key restrictions) inside the JSON body. Forward verbatim
        // so the orchestrator can surface it via WeatherStatus.
        throw new GoogleWeatherError(
            `Google Weather API HTTP ${resp.status}`,
            resp.status,
            body || undefined,
        )
    }
    try {
        return await resp.json() as T
    } catch (e) {
        throw new GoogleWeatherError(`bad json: ${(e as Error).message}`)
    }
}

async function fetchCurrent(opts: FetchOptions): Promise<GoogleCurrentResponse> {
    return callWeatherApi<GoogleCurrentResponse>('/currentConditions:lookup', {
        'location.latitude': String(opts.lat),
        'location.longitude': String(opts.lng),
        unitsSystem: 'METRIC',
        languageCode: opts.languageCode ?? 'en',
    })
}

async function fetchDaily(opts: FetchOptions): Promise<GoogleForecastDaysResponse> {
    const days = clamp(opts.days ?? DEFAULT_DAILY_HORIZON, 1, MAX_DAILY_HORIZON)
    return callWeatherApi<GoogleForecastDaysResponse>('/forecast/days:lookup', {
        'location.latitude': String(opts.lat),
        'location.longitude': String(opts.lng),
        days: String(days),
        unitsSystem: 'METRIC',
        languageCode: opts.languageCode ?? 'en',
    })
}

async function fetchHourly(opts: FetchOptions): Promise<GoogleForecastHoursResponse> {
    const hours = clamp(opts.hours ?? DEFAULT_HOURLY_HORIZON, 1, MAX_HOURLY_HORIZON)
    return callWeatherApi<GoogleForecastHoursResponse>('/forecast/hours:lookup', {
        'location.latitude': String(opts.lat),
        'location.longitude': String(opts.lng),
        hours: String(hours),
        unitsSystem: 'METRIC',
        languageCode: opts.languageCode ?? 'en',
    })
}

/**
 * Past 24h observations. Used to fill in today's morning hours when the
 * forecast endpoint only returns "from now". Best-effort: if the History
 * API isn't enabled we silently return an empty list.
 */
async function fetchHistory(opts: FetchOptions): Promise<GoogleForecastHoursResponse> {
    try {
        return await callWeatherApi<GoogleForecastHoursResponse>('/history/hours:lookup', {
            'location.latitude': String(opts.lat),
            'location.longitude': String(opts.lng),
            hours: '24',
            unitsSystem: 'METRIC',
            languageCode: opts.languageCode ?? 'en',
        })
    } catch {
        return { forecastHours: [] }
    }
}

// --- transformers ----------------------------------------------------------

function transformCurrent(raw: GoogleCurrentResponse, units: WeatherUnits, languageCode?: string): WeatherCurrent {
    const { condition, label } = deriveCondition(raw.weatherCondition, languageCode)
    const tempC = readNum(raw.temperature?.degrees)
    const feelsC = readNum(raw.feelsLikeTemperature?.degrees, tempC)
    const dewC = raw.dewPoint?.degrees
    const windKph = readNum(raw.wind?.speed?.value ?? raw.wind?.speed?.quantity)
    const gustKph = raw.wind?.gust?.value ?? raw.wind?.gust?.quantity
    const precipMm = readNum(raw.precipitation?.qpf?.value ?? raw.precipitation?.qpf?.quantity)
    const visKm = readNum(raw.visibility?.value ?? raw.visibility?.quantity, 10)

    return {
        temperature: round1(convertTemp(tempC, units)),
        feelsLike: round1(convertTemp(feelsC, units)),
        condition,
        conditionLabel: label,
        isDay: raw.isDaytime === true,
        humidity: clamp(readNum(raw.relativeHumidity, 0), 0, 100),
        dewPoint: typeof dewC === 'number' ? round1(convertTemp(dewC, units)) : undefined,
        windSpeed: round1(convertSpeed(windKph, units)),
        windDirection: clamp(readNum(raw.wind?.direction?.degrees, 0), 0, 360),
        windGust: typeof gustKph === 'number' ? round1(convertSpeed(gustKph, units)) : undefined,
        precipitation: round2(convertPrecip(precipMm, units)),
        precipitationProbability: typeof raw.precipitation?.probability?.percent === 'number'
            ? clamp(raw.precipitation.probability.percent, 0, 100)
            : undefined,
        pressure: clamp(readNum(raw.airPressure?.meanSeaLevelMillibars, 1013), 800, 1100),
        visibility: round1(convertDistance(visKm, units)),
        uvIndex: clamp(readNum(raw.uvIndex, 0), 0, 20),
        cloudCover: clamp(readNum(raw.cloudCover, 0), 0, 100),
    }
}

/** Round to 1 decimal. Avoids JSON noise like 23.49999999999. */
function round1(n: number): number {
    return Math.round(n * 10) / 10
}
function round2(n: number): number {
    return Math.round(n * 100) / 100
}

function transformDaily(raw: GoogleForecastDay, units: WeatherUnits, languageCode?: string): WeatherDaily {
    // Prefer the daytime forecast's condition (matches "today's weather" UX);
    // fall back to nighttime when only night data is available (rare).
    const half = raw.daytimeForecast ?? raw.nighttimeForecast
    const { condition, label } = deriveCondition(half?.weatherCondition, languageCode)
    const hiC = readNum(raw.maxTemperature?.degrees)
    const loC = readNum(raw.minTemperature?.degrees)
    const feelHiC = raw.feelsLikeMaxTemperature?.degrees
    const feelLoC = raw.feelsLikeMinTemperature?.degrees
    const precipMm = readNum(half?.precipitation?.qpf?.value ?? half?.precipitation?.qpf?.quantity)
    const windKph = readNum(half?.wind?.speed?.value ?? half?.wind?.speed?.quantity)
    const gustKph = half?.wind?.gust?.value ?? half?.wind?.gust?.quantity
    const date = raw.displayDate
        ? `${raw.displayDate.year.toString().padStart(4, '0')}-${String(raw.displayDate.month).padStart(2, '0')}-${String(raw.displayDate.day).padStart(2, '0')}`
        : isoDateInTimezone(raw.interval?.startTime)

    return {
        date,
        condition,
        conditionLabel: label,
        temperatureHigh: round1(convertTemp(hiC, units)),
        temperatureLow: round1(convertTemp(loC, units)),
        feelsLikeHigh: typeof feelHiC === 'number' ? round1(convertTemp(feelHiC, units)) : undefined,
        feelsLikeLow: typeof feelLoC === 'number' ? round1(convertTemp(feelLoC, units)) : undefined,
        precipitationProbability: clamp(readNum(half?.precipitation?.probability?.percent, 0), 0, 100),
        precipitationSum: round2(convertPrecip(precipMm, units)),
        uvIndexMax: clamp(readNum(half?.uvIndex, 0), 0, 20),
        sunrise: raw.sunEvents?.sunriseTime ?? '',
        sunset: raw.sunEvents?.sunsetTime ?? '',
        windSpeedMax: round1(convertSpeed(windKph, units)),
        windGustMax: typeof gustKph === 'number' ? round1(convertSpeed(gustKph, units)) : undefined,
        humidityAvg: typeof half?.relativeHumidity === 'number'
            ? clamp(half.relativeHumidity, 0, 100)
            : undefined,
    }
}

function transformHourly(raw: GoogleForecastHour, units: WeatherUnits): WeatherHourly {
    const { condition } = deriveCondition(raw.weatherCondition)
    const tempC = readNum(raw.temperature?.degrees)
    // Google's hourly response includes `interval.startTime` as RFC3339 with
    // the location's offset — perfect for the renderer's hour label.
    const time = raw.interval?.startTime ?? ''
    const uv = raw.uvIndex
    return {
        time,
        temperature: round1(convertTemp(tempC, units)),
        condition,
        precipitationProbability: clamp(readNum(raw.precipitation?.probability?.percent, 0), 0, 100),
        isDay: raw.isDaytime === true,
        uvIndex: typeof uv === 'number' && Number.isFinite(uv) ? clamp(round1(uv), 0, 20) : undefined,
    }
}

// --- entry point -----------------------------------------------------------

/**
 * Fetch current + hourly + daily in parallel and return canonical artifact
 * fragments. The caller supplies `location` and `provider` to assemble the
 * full WeatherArtifact.
 *
 * Errors propagate as `GoogleWeatherError` so the WeatherShow tool can
 * surface the upstream message (often containing the enable-API URL).
 */
export async function fetchGoogleWeather(opts: FetchOptions): Promise<GoogleWeatherResult> {
    // Run history alongside the forecast calls; history is best-effort so a
    // 4-way parallel is fine — total wall-clock is bounded by the slowest.
    const [currentRaw, dailyRaw, hourlyRaw, historyRaw] = await Promise.all([
        fetchCurrent(opts),
        fetchDaily(opts),
        fetchHourly(opts),
        fetchHistory(opts),
    ])
    const current = transformCurrent(currentRaw, opts.units, opts.languageCode)
    const daily = (dailyRaw.forecastDays ?? []).map(d => transformDaily(d, opts.units, opts.languageCode))
    // Prepend past 24h then the forecast — gives the day-expansion strip
    // hours from before "now" so today's morning is visible mid-afternoon.
    const past = (historyRaw.historyHours ?? historyRaw.forecastHours ?? []).map(h => transformHourly(h, opts.units))
    const forecast = (hourlyRaw.forecastHours ?? []).map(h => transformHourly(h, opts.units))
    const hourly = [...past, ...forecast].sort((a, b) => {
        const ams = Date.parse(a.time)
        const bms = Date.parse(b.time)
        if (!Number.isFinite(ams) && !Number.isFinite(bms)) return 0
        if (!Number.isFinite(ams)) return 1
        if (!Number.isFinite(bms)) return -1
        return ams - bms
    })
    if (daily.length === 0) {
        // Belt-and-braces — without at least one day the schema rejects.
        throw new GoogleWeatherError('Google returned no forecast days for this location.')
    }
    return {
        current,
        daily,
        hourly,
        timezone: currentRaw.timeZone?.id ?? dailyRaw.timeZone?.id ?? hourlyRaw.timeZone?.id,
    }
}

// --- shape-assembly helper -------------------------------------------------

/**
 * Assemble a full `WeatherArtifact` from a `GoogleWeatherResult` plus the
 * location info the caller already has from geocoding. Keeps the tool
 * implementation small and the artifact-shape logic in one place.
 */
export function assembleWeatherArtifact(args: {
    location: WeatherLocation
    units: WeatherUnits
    result: GoogleWeatherResult
    attribution?: string
}): WeatherArtifact {
    return {
        location: args.location,
        units: args.units,
        fetchedAt: new Date().toISOString(),
        provider: 'google',
        current: args.result.current,
        hourly: args.result.hourly,
        daily: args.result.daily,
        attribution: args.attribution,
    }
}
