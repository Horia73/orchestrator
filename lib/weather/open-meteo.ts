import type {
    WeatherAirQuality,
    WeatherCondition,
    WeatherCurrent,
    WeatherDaily,
    WeatherHourly,
    WeatherUnits,
} from './schema'
import { aqiLabel as universalAqiLabel, conditionLabelForLocale } from './weather-codes'

// ---------------------------------------------------------------------------
// Open-Meteo API client.
//
// Why Open-Meteo:
//   - Keyless. No env var, no API enable dance, no quotas at single-user
//     volume — perfect fallback when the user hasn't set up Google.
//   - ECMWF-backed (the European model, gold standard for EU forecasts).
//     Quality matches or beats Google for European users.
//   - Three free endpoints used here:
//       https://api.open-meteo.com/v1/forecast              (current + hourly + daily)
//       https://geocoding-api.open-meteo.com/v1/search       (place → coords)
//       https://air-quality-api.open-meteo.com/v1/air-quality (AQ; CAMS-backed)
//
// Returns canonical `WeatherFetchResult` parts so the provider abstraction
// can plug it into WeatherShow alongside Google.
// ---------------------------------------------------------------------------

const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast'
const OM_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const OM_AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality'

export class OpenMeteoError extends Error {
    constructor(message: string, public readonly status?: number, public readonly upstream?: string) {
        super(message)
        this.name = 'OpenMeteoError'
    }
}

// --- WMO weather codes (Open-Meteo / WMO standard) ------------------------

/**
 * Map an Open-Meteo `weather_code` (WMO 4677 / 4680) to our normalized
 * condition enum. Documented at https://open-meteo.com/en/docs.
 *
 * Codes:
 *   0          Clear sky
 *   1, 2, 3    Mainly clear, partly cloudy, overcast
 *   45, 48     Fog
 *   51, 53, 55 Drizzle (light/moderate/dense)
 *   56, 57     Freezing drizzle
 *   61, 63, 65 Rain (slight/moderate/heavy)
 *   66, 67     Freezing rain
 *   71, 73, 75 Snow (slight/moderate/heavy)
 *   77         Snow grains
 *   80, 81, 82 Rain showers
 *   85, 86     Snow showers
 *   95         Thunderstorm
 *   96, 99     Thunderstorm with hail
 */
function wmoToCondition(code: number): WeatherCondition {
    if (code === 0) return 'clear'
    if (code === 1) return 'clear'
    if (code === 2) return 'partly-cloudy'
    if (code === 3) return 'overcast'
    if (code === 45 || code === 48) return 'fog'
    if (code >= 51 && code <= 57) return 'drizzle'
    if (code === 61 || code === 80) return 'rain'
    if (code === 63 || code === 81) return 'rain'
    if (code === 65 || code === 82) return 'heavy-rain'
    if (code === 66 || code === 67) return 'sleet'
    if (code === 71 || code === 85) return 'snow'
    if (code === 73) return 'snow'
    if (code === 75 || code === 86) return 'heavy-snow'
    if (code === 77) return 'snow'
    if (code === 95) return 'thunderstorm'
    if (code === 96 || code === 99) return 'thunderstorm'
    return 'unknown'
}

/** Human label for a WMO code, in English. Open-Meteo doesn't return
 *  natural-language descriptions; we synthesize them. The model can
 *  re-localise in prose if it wants. */
function wmoLabel(code: number): string {
    switch (code) {
        case 0: return 'Clear sky'
        case 1: return 'Mainly clear'
        case 2: return 'Partly cloudy'
        case 3: return 'Overcast'
        case 45: return 'Fog'
        case 48: return 'Depositing rime fog'
        case 51: return 'Light drizzle'
        case 53: return 'Moderate drizzle'
        case 55: return 'Dense drizzle'
        case 56: return 'Light freezing drizzle'
        case 57: return 'Dense freezing drizzle'
        case 61: return 'Slight rain'
        case 63: return 'Moderate rain'
        case 65: return 'Heavy rain'
        case 66: return 'Light freezing rain'
        case 67: return 'Heavy freezing rain'
        case 71: return 'Slight snow'
        case 73: return 'Moderate snow'
        case 75: return 'Heavy snow'
        case 77: return 'Snow grains'
        case 80: return 'Slight rain showers'
        case 81: return 'Moderate rain showers'
        case 82: return 'Violent rain showers'
        case 85: return 'Slight snow showers'
        case 86: return 'Heavy snow showers'
        case 95: return 'Thunderstorm'
        case 96: return 'Thunderstorm with slight hail'
        case 99: return 'Thunderstorm with heavy hail'
        default: return 'Unknown'
    }
}

// --- types -----------------------------------------------------------------

interface OmForecastResponse {
    latitude: number
    longitude: number
    timezone: string
    timezone_abbreviation: string
    elevation: number
    current_units?: Record<string, string>
    current?: {
        time: string
        interval?: number
        temperature_2m?: number
        apparent_temperature?: number
        is_day?: number
        precipitation?: number
        rain?: number
        showers?: number
        snowfall?: number
        weather_code?: number
        cloud_cover?: number
        pressure_msl?: number
        surface_pressure?: number
        wind_speed_10m?: number
        wind_direction_10m?: number
        wind_gusts_10m?: number
        relative_humidity_2m?: number
        dew_point_2m?: number
        visibility?: number
        uv_index?: number
    }
    hourly?: {
        time: string[]
        temperature_2m: number[]
        weather_code: number[]
        precipitation_probability: number[]
        is_day: number[]
        uv_index?: number[]
    }
    daily?: {
        time: string[]
        weather_code: number[]
        temperature_2m_max: number[]
        temperature_2m_min: number[]
        apparent_temperature_max?: number[]
        apparent_temperature_min?: number[]
        sunrise: string[]
        sunset: string[]
        precipitation_sum: number[]
        precipitation_probability_max: number[]
        wind_speed_10m_max: number[]
        wind_gusts_10m_max?: number[]
        uv_index_max: number[]
    }
}

// --- helpers ---------------------------------------------------------------

function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function num(n: unknown, fallback = 0): number {
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

// --- main fetch ------------------------------------------------------------

export interface OpenMeteoFetchOptions {
    lat: number
    lng: number
    units: WeatherUnits
    days?: number
    hours?: number
    /** Open-Meteo doesn't localise condition descriptions but accepts a
     *  language for the geocoding endpoint. Forwarded to geocode() only. */
    languageCode?: string
}

export interface OpenMeteoFetchResult {
    current: WeatherCurrent
    hourly: WeatherHourly[]
    daily: WeatherDaily[]
    timezone: string
}

/**
 * Fetch current + hourly + daily forecast in a single Open-Meteo request.
 * Open-Meteo's forecast endpoint returns all three families in one round
 * trip — significantly cheaper than the Google 3-call dance.
 */
export async function fetchOpenMeteoForecast(opts: OpenMeteoFetchOptions): Promise<OpenMeteoFetchResult> {
    const days = clamp(opts.days ?? 10, 1, 16)
    const hours = clamp(opts.hours ?? 24, 1, 240)
    // Open-Meteo wants exact field lists per family. We request the union
    // we care about; pruning fields would just hide options for later.
    const currentFields = [
        'temperature_2m', 'apparent_temperature', 'is_day', 'precipitation',
        'weather_code', 'cloud_cover', 'pressure_msl',
        'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
        'relative_humidity_2m', 'dew_point_2m', 'visibility', 'uv_index',
    ].join(',')
    const hourlyFields = [
        'temperature_2m', 'weather_code', 'precipitation_probability', 'is_day',
        'uv_index',
    ].join(',')
    const dailyFields = [
        'weather_code', 'temperature_2m_max', 'temperature_2m_min',
        'apparent_temperature_max', 'apparent_temperature_min',
        'sunrise', 'sunset',
        'precipitation_sum', 'precipitation_probability_max',
        'wind_speed_10m_max', 'wind_gusts_10m_max', 'uv_index_max',
    ].join(',')

    const url = new URL(OM_FORECAST)
    url.searchParams.set('latitude', String(opts.lat))
    url.searchParams.set('longitude', String(opts.lng))
    url.searchParams.set('current', currentFields)
    url.searchParams.set('hourly', hourlyFields)
    url.searchParams.set('daily', dailyFields)
    url.searchParams.set('forecast_days', String(days))
    url.searchParams.set('forecast_hours', String(hours))
    // Always include the past 24h so today's row, when expanded, shows the
    // morning hours even if the user asks mid-afternoon. Open-Meteo's
    // `past_hours` is free and stays under the same forecast call.
    url.searchParams.set('past_hours', '24')
    url.searchParams.set('timezone', 'auto')
    // Open-Meteo's unit knobs map cleanly to ours.
    if (opts.units === 'imperial') {
        url.searchParams.set('temperature_unit', 'fahrenheit')
        url.searchParams.set('wind_speed_unit', 'mph')
        url.searchParams.set('precipitation_unit', 'inch')
    } else {
        // metric defaults are °C, km/h (we convert to m/s below), mm.
        url.searchParams.set('temperature_unit', 'celsius')
        url.searchParams.set('wind_speed_unit', 'kmh')
        url.searchParams.set('precipitation_unit', 'mm')
    }

    let resp: Response
    try {
        resp = await fetch(url.toString())
    } catch (e) {
        throw new OpenMeteoError(`network: ${(e as Error).message}`)
    }
    if (!resp.ok) {
        let body = ''
        try { body = await resp.text() } catch { /* ignore */ }
        throw new OpenMeteoError(`Open-Meteo HTTP ${resp.status}`, resp.status, body || undefined)
    }
    let data: OmForecastResponse
    try { data = await resp.json() as OmForecastResponse }
    catch (e) { throw new OpenMeteoError(`bad json: ${(e as Error).message}`) }

    if (!data.current || !data.daily) {
        throw new OpenMeteoError('Open-Meteo response missing current/daily blocks')
    }

    return {
        current: buildCurrent(data, opts.units, opts.languageCode),
        hourly: buildHourly(data, opts.units),
        daily: buildDaily(data, opts.units, opts.languageCode),
        timezone: data.timezone || 'UTC',
    }
}

function buildCurrent(data: OmForecastResponse, units: WeatherUnits, languageCode?: string): WeatherCurrent {
    const c = data.current!
    const code = num(c.weather_code, -1)
    const condition = code >= 0 ? wmoToCondition(code) : 'unknown'
    // Open-Meteo wind in km/h when metric — convert to m/s for our schema.
    // Imperial already comes back in mph.
    const windInBase = num(c.wind_speed_10m)
    const gustInBase = c.wind_gusts_10m
    const windSpeed = units === 'metric' ? round1(windInBase / 3.6) : round1(windInBase)
    const gustSpeed = typeof gustInBase === 'number'
        ? (units === 'metric' ? round1(gustInBase / 3.6) : round1(gustInBase))
        : undefined
    const visKm = num(c.visibility, 10000) / 1000 // OM returns meters
    return {
        temperature: round1(num(c.temperature_2m)),
        feelsLike: round1(num(c.apparent_temperature, num(c.temperature_2m))),
        condition,
        conditionLabel: labelForWmo(condition, code, languageCode),
        isDay: c.is_day === 1,
        humidity: clamp(num(c.relative_humidity_2m), 0, 100),
        dewPoint: typeof c.dew_point_2m === 'number' ? round1(c.dew_point_2m) : undefined,
        windSpeed,
        windDirection: clamp(num(c.wind_direction_10m), 0, 360),
        windGust: gustSpeed,
        precipitation: round2(num(c.precipitation)),
        pressure: clamp(num(c.pressure_msl, 1013), 800, 1100),
        // Visibility is in km for metric, mi for imperial (convert from km).
        visibility: units === 'metric' ? round1(visKm) : round1(visKm * 0.621371),
        uvIndex: clamp(num(c.uv_index), 0, 20),
        cloudCover: clamp(num(c.cloud_cover), 0, 100),
    }
}

function buildHourly(data: OmForecastResponse, _units: WeatherUnits): WeatherHourly[] {
    void _units
    const h = data.hourly
    if (!h) return []
    const out: WeatherHourly[] = []
    const len = Math.min(
        h.time.length,
        h.temperature_2m.length,
        h.weather_code.length,
        h.precipitation_probability.length,
        h.is_day.length,
    )
    for (let i = 0; i < len; i++) {
        const code = num(h.weather_code[i], -1)
        const uv = h.uv_index?.[i]
        out.push({
            // Open-Meteo returns local wall-clock ISO strings without an
            // offset. Normalize them to RFC3339 with the location offset so
            // Date parsing is correct for weather outside the server/browser tz.
            time: normalizeOpenMeteoTime(h.time[i], data.timezone),
            temperature: round1(num(h.temperature_2m[i])),
            condition: code >= 0 ? wmoToCondition(code) : 'unknown',
            precipitationProbability: clamp(num(h.precipitation_probability[i]), 0, 100),
            isDay: h.is_day[i] === 1,
            uvIndex: typeof uv === 'number' && Number.isFinite(uv) ? clamp(round1(uv), 0, 20) : undefined,
        })
    }
    return out
}

function buildDaily(data: OmForecastResponse, units: WeatherUnits, languageCode?: string): WeatherDaily[] {
    const d = data.daily!
    const out: WeatherDaily[] = []
    const len = Math.min(
        d.time.length, d.weather_code.length, d.temperature_2m_max.length,
        d.temperature_2m_min.length, d.sunrise.length, d.sunset.length,
        d.precipitation_sum.length, d.precipitation_probability_max.length,
        d.wind_speed_10m_max.length, d.uv_index_max.length,
    )
    for (let i = 0; i < len; i++) {
        const code = num(d.weather_code[i], -1)
        const condition = code >= 0 ? wmoToCondition(code) : 'unknown'
        out.push({
            date: d.time[i],
            condition,
            conditionLabel: labelForWmo(condition, code, languageCode),
            temperatureHigh: round1(num(d.temperature_2m_max[i])),
            temperatureLow: round1(num(d.temperature_2m_min[i])),
            feelsLikeHigh: d.apparent_temperature_max?.[i] != null ? round1(num(d.apparent_temperature_max[i])) : undefined,
            feelsLikeLow: d.apparent_temperature_min?.[i] != null ? round1(num(d.apparent_temperature_min[i])) : undefined,
            precipitationProbability: clamp(num(d.precipitation_probability_max[i]), 0, 100),
            precipitationSum: round2(num(d.precipitation_sum[i])),
            uvIndexMax: clamp(num(d.uv_index_max[i]), 0, 20),
            sunrise: normalizeOpenMeteoTime(d.sunrise[i], data.timezone),
            sunset: normalizeOpenMeteoTime(d.sunset[i], data.timezone),
            windSpeedMax: units === 'metric'
                ? round1(num(d.wind_speed_10m_max[i]) / 3.6)
                : round1(num(d.wind_speed_10m_max[i])),
            windGustMax: d.wind_gusts_10m_max?.[i] != null
                ? (units === 'metric'
                    ? round1(num(d.wind_gusts_10m_max[i]) / 3.6)
                    : round1(num(d.wind_gusts_10m_max[i])))
                : undefined,
        })
    }
    return out
}

function labelForWmo(condition: WeatherCondition, code: number, languageCode?: string): string {
    const lang = languageCode?.toLowerCase() ?? ''
    if (lang === 'ro' || lang.startsWith('ro-')) return conditionLabelForLocale(condition, languageCode)
    return wmoLabel(code)
}

interface LocalDateTimeParts {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
}

function normalizeOpenMeteoTime(value: string | undefined, timezone: string | undefined): string {
    const raw = value ?? ''
    if (!raw || hasExplicitTimezone(raw) || !timezone) return raw
    const parts = parseLocalDateTime(raw)
    if (!parts) return raw
    const offset = offsetMinutesForLocalTime(timezone, parts)
    if (offset == null) return raw
    return `${formatLocalDateTime(parts)}${formatOffset(offset)}`
}

function hasExplicitTimezone(value: string): boolean {
    return /(?:Z|[+\-]\d\d:?\d\d)$/i.test(value)
}

function parseLocalDateTime(value: string): LocalDateTimeParts | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
    if (!match) return null
    const parts = {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] ?? '0'),
    }
    if (
        !Number.isFinite(parts.year) ||
        parts.month < 1 || parts.month > 12 ||
        parts.day < 1 || parts.day > 31 ||
        parts.hour < 0 || parts.hour > 23 ||
        parts.minute < 0 || parts.minute > 59 ||
        parts.second < 0 || parts.second > 59
    ) {
        return null
    }
    return parts
}

function offsetMinutesForLocalTime(timezone: string, local: LocalDateTimeParts): number | null {
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    let offset = timezoneOffsetMinutes(timezone, new Date(localAsUtc))
    if (offset == null) return null

    // Refine once around DST transitions. The first offset is based on the
    // UTC guess; the second is based on the actual instant that guess implies.
    const impliedUtc = localAsUtc - offset * 60_000
    const refined = timezoneOffsetMinutes(timezone, new Date(impliedUtc))
    if (refined != null) offset = refined
    return offset
}

function timezoneOffsetMinutes(timezone: string, instant: Date): number | null {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(instant)
        const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
        const asUtc = Date.UTC(
            value('year'),
            value('month') - 1,
            value('day'),
            value('hour'),
            value('minute'),
            value('second'),
        )
        if (!Number.isFinite(asUtc)) return null
        return Math.round((asUtc - instant.getTime()) / 60_000)
    } catch {
        return null
    }
}

function formatLocalDateTime(parts: LocalDateTimeParts): string {
    return [
        parts.year.toString().padStart(4, '0'),
        String(parts.month).padStart(2, '0'),
        String(parts.day).padStart(2, '0'),
    ].join('-') + `T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`
}

function formatOffset(minutes: number): string {
    const sign = minutes >= 0 ? '+' : '-'
    const abs = Math.abs(minutes)
    const hh = Math.floor(abs / 60)
    const mm = abs % 60
    return `${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// --- geocoding -------------------------------------------------------------

interface OmGeocodeResponse {
    results?: Array<{
        name?: string
        latitude?: number
        longitude?: number
        country?: string
        country_code?: string
        admin1?: string
        admin2?: string
        timezone?: string
    }>
}

export interface OpenMeteoGeocodeHit {
    name: string
    region?: string
    country?: string
    coordinates: [number, number]
    timezone?: string
}

export async function geocodeOpenMeteo(query: string, languageCode = 'en'): Promise<OpenMeteoGeocodeHit | null> {
    if (!query.trim()) return null
    const url = new URL(OM_GEOCODE)
    url.searchParams.set('name', query)
    url.searchParams.set('count', '1')
    url.searchParams.set('language', languageCode)
    url.searchParams.set('format', 'json')

    let resp: Response
    try {
        resp = await fetch(url.toString())
    } catch (e) {
        throw new OpenMeteoError(`geocoding network: ${(e as Error).message}`)
    }
    if (!resp.ok) {
        throw new OpenMeteoError(`Open-Meteo geocoding HTTP ${resp.status}`, resp.status)
    }
    let data: OmGeocodeResponse
    try { data = await resp.json() as OmGeocodeResponse }
    catch (e) { throw new OpenMeteoError(`geocoding bad json: ${(e as Error).message}`) }
    const top = data.results?.[0]
    if (!top || typeof top.latitude !== 'number' || typeof top.longitude !== 'number') return null
    return {
        name: top.name ?? query,
        region: top.admin1 ?? top.admin2,
        country: top.country_code ?? top.country,
        coordinates: [top.longitude, top.latitude],
        timezone: top.timezone,
    }
}

// --- air quality -----------------------------------------------------------

interface OmAirQualityResponse {
    current?: {
        time?: string
        european_aqi?: number
        us_aqi?: number
        pm10?: number
        pm2_5?: number
        ozone?: number
    }
}

/**
 * Fetch current air quality from Open-Meteo's CAMS-backed endpoint. Free,
 * keyless. Returns null instead of throwing if the upstream rejects — AQ is
 * decorative.
 *
 * Prefers European AQI in EU regions (where CAMS data is densest), falls
 * back to US AQI globally. Open-Meteo doesn't tell us the region, so we
 * just pick whichever is non-null.
 */
export async function fetchOpenMeteoAirQuality(lat: number, lng: number): Promise<WeatherAirQuality | null> {
    const url = new URL(OM_AIR_QUALITY)
    url.searchParams.set('latitude', String(lat))
    url.searchParams.set('longitude', String(lng))
    url.searchParams.set('current', 'european_aqi,us_aqi,pm10,pm2_5,ozone')

    let resp: Response
    try { resp = await fetch(url.toString()) }
    catch { return null }
    if (!resp.ok) return null
    let data: OmAirQualityResponse
    try { data = await resp.json() as OmAirQualityResponse }
    catch { return null }
    const c = data.current
    if (!c) return null
    const aqi = typeof c.european_aqi === 'number' ? c.european_aqi
              : typeof c.us_aqi === 'number' ? c.us_aqi
              : null
    if (aqi === null) return null
    return {
        aqi,
        aqiLabel: universalAqiLabel(aqi),
        pm25: typeof c.pm2_5 === 'number' ? round1(c.pm2_5) : undefined,
        pm10: typeof c.pm10 === 'number' ? round1(c.pm10) : undefined,
        ozone: typeof c.ozone === 'number' ? round1(c.ozone) : undefined,
    }
}
