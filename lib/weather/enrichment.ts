import type {
    WeatherAlert,
    WeatherArtifact,
    WeatherHistoricalComparison,
    WeatherPollen,
    WeatherPollenSpecies,
    WeatherRadar,
} from './schema'
import { fetchGooglePollen } from './google-pollen'
import { uvLabel } from './weather-codes'

// ---------------------------------------------------------------------------
// Weather artifact enrichment.
//
// Provider calls return the canonical forecast. This module adds optional
// derived intelligence around that forecast:
//   - forecast heads-up banners
//   - Open-Meteo archive comparison for same calendar date
//   - Google Pollen API first, Open-Meteo seasonal pollen fallback
//   - RainViewer latest radar widget image
//
// Every network enrichment is best-effort and cached independently. A failed
// history/pollen/radar request must never blank the weather card.
// ---------------------------------------------------------------------------

const OM_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive'
const OM_AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const RAINVIEWER_MANIFEST = 'https://api.rainviewer.com/public/weather-maps.json'

type CacheEntry<T> = { at: number; value: T }
const historicalCache = new Map<string, CacheEntry<WeatherHistoricalComparison | null>>()
const pollenCache = new Map<string, CacheEntry<WeatherPollen | null>>()
const radarCache = new Map<string, CacheEntry<WeatherRadar | null>>()

const HOUR_MS = 60 * 60 * 1000
const HISTORICAL_TTL_MS = 6 * HOUR_MS
const POLLEN_TTL_MS = HOUR_MS
const RADAR_TTL_MS = 10 * 60 * 1000

export interface WeatherEnrichmentOptions {
    includeAlerts?: boolean
    includeHistorical?: boolean
    includePollen?: boolean
    includeRadar?: boolean
}

export async function enrichWeatherArtifact(
    artifact: WeatherArtifact,
    options: WeatherEnrichmentOptions = {},
): Promise<WeatherArtifact> {
    const includeAlerts = options.includeAlerts !== false
    const includeHistorical = options.includeHistorical !== false
    const includePollen = options.includePollen !== false
    const includeRadar = options.includeRadar !== false

    const [historical, pollen, radar] = await Promise.all([
        includeHistorical ? safe(() => fetchHistoricalComparison(artifact)) : Promise.resolve(null),
        includePollen ? safe(() => fetchPollen(artifact)) : Promise.resolve(null),
        includeRadar ? safe(() => fetchRadar(artifact)) : Promise.resolve(null),
    ])

    const alerts = includeAlerts ? buildForecastAlerts(artifact) : []

    return {
        ...artifact,
        ...(alerts.length > 0 ? { alerts } : {}),
        ...(historical ? { historical } : {}),
        ...(pollen ? { pollen } : {}),
        ...(radar ? { radar } : {}),
    }
}

async function safe<T>(fn: () => Promise<T | null>): Promise<T | null> {
    try { return await fn() } catch { return null }
}

// --- alerts / why ----------------------------------------------------------

function buildForecastAlerts(artifact: WeatherArtifact): WeatherAlert[] {
    const out: WeatherAlert[] = []
    const c = artifact.current
    const today = artifact.daily[0]
    const tempUnit = artifact.units === 'metric' ? '°C' : '°F'
    const windUnit = artifact.units === 'metric' ? 'm/s' : 'mph'
    const precipUnit = artifact.units === 'metric' ? 'mm' : 'in'
    const next12Rain = maxNumber(artifact.hourly.slice(0, 12).map(h => h.precipitationProbability), c.precipitationProbability ?? 0)
    const maxWind = maxNumber([
        c.windSpeed,
        c.windGust,
        ...artifact.daily.slice(0, 2).flatMap(d => [d.windSpeedMax, d.windGustMax]),
    ])

    if (next12Rain >= 70 || (today && (today.precipitationProbability >= 70 || today.precipitationSum >= (artifact.units === 'metric' ? 10 : 0.4)))) {
        const amount = today?.precipitationSum ?? 0
        out.push({
            id: 'rain-next',
            source: 'forecast',
            kind: 'rain',
            severity: next12Rain >= 85 || amount >= (artifact.units === 'metric' ? 20 : 0.8) ? 'watch' : 'advisory',
            title: 'Rain likely',
            summary: `${Math.round(Math.max(next12Rain, today?.precipitationProbability ?? 0))}% rain risk${amount > 0 ? `, about ${formatAmount(amount)} ${precipUnit} today` : ''}.`,
        })
    }

    if (hasCondition(artifact, ['thunderstorm', 'hail'])) {
        out.push({
            id: 'storm-risk',
            source: 'forecast',
            kind: 'storm',
            severity: 'watch',
            title: 'Storm risk',
            summary: 'Thunderstorm or hail appears in the nearby forecast window.',
        })
    }

    const windThreshold = artifact.units === 'metric' ? 11 : 25
    const windWarning = artifact.units === 'metric' ? 17 : 40
    if (maxWind >= windThreshold) {
        out.push({
            id: 'wind-risk',
            source: 'forecast',
            kind: 'wind',
            severity: maxWind >= windWarning ? 'warning' : 'advisory',
            title: 'Windy conditions',
            summary: `Peak wind/gust near ${Math.round(maxWind)} ${windUnit}. Secure loose items and expect it to feel cooler.`,
        })
    }

    const uv = Math.max(c.uvIndex, today?.uvIndexMax ?? 0)
    if (uv >= 8) {
        out.push({
            id: 'uv-high',
            source: 'forecast',
            kind: 'uv',
            severity: uv >= 11 ? 'warning' : 'advisory',
            title: `${uvLabel(uv)} UV`,
            summary: `UV index peaks near ${Math.round(uv)}. Sunscreen and shade matter during midday.`,
        })
    }

    if (artifact.airQuality && artifact.airQuality.aqi > 100) {
        out.push({
            id: 'aqi-elevated',
            source: 'forecast',
            kind: 'air_quality',
            severity: artifact.airQuality.aqi > 150 ? 'warning' : 'advisory',
            title: 'Air quality elevated',
            summary: `AQI is ${Math.round(artifact.airQuality.aqi)} (${artifact.airQuality.aqiLabel}). Sensitive groups should limit heavy outdoor effort.`,
        })
    }

    const high = today?.temperatureHigh ?? c.temperature
    const low = today?.temperatureLow ?? c.temperature
    const heatThreshold = artifact.units === 'metric' ? 32 : 90
    const coldThreshold = artifact.units === 'metric' ? 0 : 32
    if (Math.max(high, c.feelsLike) >= heatThreshold) {
        out.push({
            id: 'heat-risk',
            source: 'forecast',
            kind: 'heat',
            severity: Math.max(high, c.feelsLike) >= (artifact.units === 'metric' ? 36 : 97) ? 'warning' : 'advisory',
            title: 'Heat stress possible',
            summary: `High near ${Math.round(high)}${tempUnit}; hydrate and avoid peak sun if active outside.`,
        })
    }
    if (low <= coldThreshold) {
        out.push({
            id: 'cold-risk',
            source: 'forecast',
            kind: 'cold',
            severity: low <= (artifact.units === 'metric' ? -6 : 21) ? 'warning' : 'advisory',
            title: 'Freezing risk',
            summary: `Low near ${Math.round(low)}${tempUnit}. Dress in layers and watch for slick surfaces if wet.`,
        })
    }

    if (c.condition === 'fog') {
        out.push({
            id: 'fog-now',
            source: 'forecast',
            kind: 'fog',
            severity: 'advisory',
            title: 'Fog reducing visibility',
            summary: 'Leave extra distance if driving until visibility improves.',
        })
    }

    return out.slice(0, 6)
}

function hasCondition(artifact: WeatherArtifact, conditions: string[]): boolean {
    const set = new Set(conditions)
    return set.has(artifact.current.condition)
        || artifact.hourly.slice(0, 24).some(h => set.has(h.condition))
        || artifact.daily.slice(0, 2).some(d => set.has(d.condition))
}

// --- historical comparison -------------------------------------------------

interface ArchiveResponse {
    daily?: {
        time?: string[]
        temperature_2m_max?: number[]
        temperature_2m_min?: number[]
        precipitation_sum?: number[]
    }
}

async function fetchHistoricalComparison(artifact: WeatherArtifact): Promise<WeatherHistoricalComparison | null> {
    const today = artifact.daily[0]
    if (!today?.date) return null
    const key = [
        roundCoord(artifact.location.coordinates[1]),
        roundCoord(artifact.location.coordinates[0]),
        artifact.units,
        today.date,
    ].join(':')
    const cached = getFresh(historicalCache, key, HISTORICAL_TTL_MS)
    if (cached !== undefined) return cached

    const target = parseIsoDate(today.date)
    if (!target) return setCache(historicalCache, key, null)
    const endYear = target.year - 1
    const startYear = Math.max(1940, endYear - 9)
    if (endYear < startYear) return setCache(historicalCache, key, null)
    const startDate = validIsoDate(startYear, target.month, target.day)
    const endDate = validIsoDate(endYear, target.month, target.day)
    if (!startDate || !endDate) return setCache(historicalCache, key, null)

    const url = new URL(OM_ARCHIVE)
    url.searchParams.set('latitude', String(artifact.location.coordinates[1]))
    url.searchParams.set('longitude', String(artifact.location.coordinates[0]))
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date', endDate)
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum')
    url.searchParams.set('timezone', 'auto')
    if (artifact.units === 'imperial') {
        url.searchParams.set('temperature_unit', 'fahrenheit')
        url.searchParams.set('precipitation_unit', 'inch')
    }

    const data = await fetchJson<ArchiveResponse>(url.toString(), 8000)
    const daily = data.daily
    if (!daily?.time?.length) return setCache(historicalCache, key, null)
    const suffix = `-${String(target.month).padStart(2, '0')}-${String(target.day).padStart(2, '0')}`
    const highSamples: number[] = []
    const lowSamples: number[] = []
    const precipSamples: number[] = []
    for (let i = 0; i < daily.time.length; i++) {
        if (!daily.time[i]?.endsWith(suffix)) continue
        pushFinite(highSamples, daily.temperature_2m_max?.[i])
        pushFinite(lowSamples, daily.temperature_2m_min?.[i])
        pushFinite(precipSamples, daily.precipitation_sum?.[i])
    }
    const sampleYears = Math.max(highSamples.length, lowSamples.length, precipSamples.length)
    if (sampleYears === 0) return setCache(historicalCache, key, null)

    const highNormal = average(highSamples)
    const lowNormal = average(lowSamples)
    const precipNormal = average(precipSamples)
    const highAnomaly = highNormal == null ? null : round1(today.temperatureHigh - highNormal)
    const lowAnomaly = lowNormal == null ? null : round1(today.temperatureLow - lowNormal)
    const precipAnomaly = precipNormal == null ? null : round2(today.precipitationSum - precipNormal)
    const summary = historicalSummary(artifact, {
        highAnomaly,
        lowAnomaly,
        precipAnomaly,
        precipNormal,
    })

    return setCache(historicalCache, key, {
        source: 'open-meteo-archive',
        generatedAt: new Date().toISOString(),
        targetDate: today.date,
        sampleYears,
        ...(highNormal != null && highAnomaly != null ? {
            temperatureHigh: {
                current: round1(today.temperatureHigh),
                normal: round1(highNormal),
                anomaly: highAnomaly,
            },
        } : {}),
        ...(lowNormal != null && lowAnomaly != null ? {
            temperatureLow: {
                current: round1(today.temperatureLow),
                normal: round1(lowNormal),
                anomaly: lowAnomaly,
            },
        } : {}),
        ...(precipNormal != null && precipAnomaly != null ? {
            precipitation: {
                current: round2(today.precipitationSum),
                normal: round2(precipNormal),
                anomaly: precipAnomaly,
            },
        } : {}),
        summary,
    })
}

function historicalSummary(
    artifact: WeatherArtifact,
    values: { highAnomaly: number | null; lowAnomaly: number | null; precipAnomaly: number | null; precipNormal: number | null },
): string {
    const tempUnit = artifact.units === 'metric' ? '°' : '°'
    const precipUnit = artifact.units === 'metric' ? 'mm' : 'in'
    const high = values.highAnomaly
    const precip = values.precipAnomaly
    if (high != null && Math.abs(high) >= 3) {
        return high > 0
            ? `Today's high is about ${Math.abs(high).toFixed(1)}${tempUnit} warmer than recent same-date history.`
            : `Today's high is about ${Math.abs(high).toFixed(1)}${tempUnit} cooler than recent same-date history.`
    }
    if (precip != null && values.precipNormal != null && Math.abs(precip) >= (artifact.units === 'metric' ? 3 : 0.12)) {
        return precip > 0
            ? `Forecast precipitation is ${formatAmount(Math.abs(precip))} ${precipUnit} above the recent same-date average.`
            : `Forecast precipitation is below the recent same-date average.`
    }
    return 'Close to recent same-date history for temperature and precipitation.'
}

// --- pollen ----------------------------------------------------------------

interface PollenResponse {
    current?: Partial<Record<
        'alder_pollen' | 'birch_pollen' | 'grass_pollen' | 'mugwort_pollen' | 'olive_pollen' | 'ragweed_pollen',
        number
    >>
}

const POLLEN_FIELDS = [
    ['alder', 'Alder', 'alder_pollen'],
    ['birch', 'Birch', 'birch_pollen'],
    ['grass', 'Grass', 'grass_pollen'],
    ['mugwort', 'Mugwort', 'mugwort_pollen'],
    ['olive', 'Olive', 'olive_pollen'],
    ['ragweed', 'Ragweed', 'ragweed_pollen'],
] as const

async function fetchPollen(artifact: WeatherArtifact): Promise<WeatherPollen | null> {
    const lat = artifact.location.coordinates[1]
    const lng = artifact.location.coordinates[0]
    const googleKey = `google:${roundCoord(lat)}:${roundCoord(lng)}`
    const cachedGoogle = getFresh(pollenCache, googleKey, POLLEN_TTL_MS)
    if (cachedGoogle !== undefined) return cachedGoogle

    try {
        const google = await fetchGooglePollen({ lat, lng })
        if (google) return setCache(pollenCache, googleKey, google)
    } catch {
        // Google Pollen API is an optional Maps Platform enable step.
        // Fall through to Open-Meteo so the weather card still renders.
    }

    const key = `open-meteo:${roundCoord(lat)}:${roundCoord(lng)}`
    const cached = getFresh(pollenCache, key, POLLEN_TTL_MS)
    if (cached !== undefined) return cached

    const url = new URL(OM_AIR_QUALITY)
    url.searchParams.set('latitude', String(lat))
    url.searchParams.set('longitude', String(lng))
    url.searchParams.set('current', POLLEN_FIELDS.map(([, , field]) => field).join(','))

    const data = await fetchJson<PollenResponse>(url.toString(), 6000)
    const current = data.current
    if (!current) return setCache(pollenCache, key, null)

    const species: WeatherPollenSpecies[] = []
    for (const [kind, label, field] of POLLEN_FIELDS) {
        const value = current[field]
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        species.push({
            kind,
            label,
            value: round1(value),
            level: pollenLevel(value),
        })
    }
    if (species.length === 0) return setCache(pollenCache, key, null)
    species.sort((a, b) => b.value - a.value)
    const primary = species[0]
    return setCache(pollenCache, key, {
        source: 'open-meteo-air-quality',
        generatedAt: new Date().toISOString(),
        primary,
        species,
        summary: primary.value <= 0
            ? 'Pollen signal is currently low or unavailable for active species.'
            : `${primary.label} is the main pollen signal right now (${primary.level.replace('_', ' ')}).`,
    })
}

function pollenLevel(value: number): WeatherPollenSpecies['level'] {
    if (value >= 100) return 'very_high'
    if (value >= 50) return 'high'
    if (value >= 10) return 'moderate'
    return 'low'
}

// --- radar -----------------------------------------------------------------

interface RainViewerManifest {
    host?: string
    radar?: {
        past?: Array<{ time?: number; path?: string }>
    }
}

async function fetchRadar(artifact: WeatherArtifact): Promise<WeatherRadar | null> {
    const lat = artifact.location.coordinates[1]
    const lng = artifact.location.coordinates[0]
    const key = `${roundCoord(lat)}:${roundCoord(lng)}`
    const cached = getFresh(radarCache, key, RADAR_TTL_MS)
    if (cached !== undefined) return cached

    const data = await fetchJson<RainViewerManifest>(RAINVIEWER_MANIFEST, 6000)
    const host = typeof data.host === 'string' ? data.host.replace(/\/+$/, '') : ''
    const frames = data.radar?.past ?? []
    const latest = [...frames].reverse().find(frame => frame.path && frame.time)
    if (!host || !latest?.path || !latest.time) return setCache(radarCache, key, null)
    const path = latest.path.startsWith('/') ? latest.path : `/${latest.path}`
    const imageUrl = `${host}${path}/512/7/${formatCoord(lat)}/${formatCoord(lng)}/2/1_1.png`
    const viewerUrl = `https://www.rainviewer.com/map.html?c=1&layer=radar&lm=1&loc=${encodeURIComponent(`${formatCoord(lat)},${formatCoord(lng)},7`)}&o=83&oAP=1&oC=0&oCS=1&oF=0&oFa=0&oU=0&sm=1&sn=1`
    const tileTemplate = `${host}${path}/512/{z}/{x}/{y}/2/1_1.png`
    return setCache(radarCache, key, {
        source: 'rainviewer',
        generatedAt: new Date().toISOString(),
        frameTime: new Date(latest.time * 1000).toISOString(),
        imageUrl,
        viewerUrl,
        tileTemplate,
        attribution: 'RainViewer radar',
    })
}

// --- shared helpers --------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        return await resp.json() as T
    } finally {
        clearTimeout(timer)
    }
}

function getFresh<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.at > ttlMs) {
        cache.delete(key)
        return undefined
    }
    return entry.value
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
    cache.set(key, { at: Date.now(), value })
    return value
}

function maxNumber(values: Array<number | undefined | null>, fallback = 0): number {
    let max = fallback
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value
    }
    return max
}

function pushFinite(out: number[], value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
}

function average(values: number[]): number | null {
    if (values.length === 0) return null
    return values.reduce((sum, v) => sum + v, 0) / values.length
}

function round1(value: number): number {
    return Math.round(value * 10) / 10
}

function round2(value: number): number {
    return Math.round(value * 100) / 100
}

function roundCoord(value: number): string {
    return value.toFixed(3)
}

function formatCoord(value: number): string {
    return value.toFixed(5)
}

function formatAmount(value: number): string {
    if (value < 10) return value.toFixed(1)
    return Math.round(value).toString()
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (!validIsoDate(year, month, day)) return null
    return { year, month, day }
}

function validIsoDate(year: number, month: number, day: number): string | null {
    const d = new Date(Date.UTC(year, month - 1, day))
    if (
        d.getUTCFullYear() !== year ||
        d.getUTCMonth() !== month - 1 ||
        d.getUTCDate() !== day
    ) {
        return null
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
