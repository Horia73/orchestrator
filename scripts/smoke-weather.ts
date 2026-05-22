/**
 * Smoke test for the weather artifact foundation.
 *
 * Validates the pure-logic pieces:
 *   - Schema parses minimal and rich valid inputs.
 *   - Schema rejects malformed inputs with a useful error path.
 *   - WMO/Google code mapping is total (every known Google type resolves).
 *   - UV / wind / AQI label helpers return expected ranges.
 *   - WeatherShow tool input validation (kebab-case, missing location, bad lat/lng).
 *
 * No network. The renderer is exercised by browser preview; the upstream
 * Google API call is exercised end-to-end at runtime with a real key.
 *
 * Run: npx tsx scripts/smoke-weather.ts
 */
import {
    WeatherArtifactSchema,
    parseWeatherArtifact,
} from '@/lib/weather/schema'
import {
    aqiLabel,
    conditionLabel,
    conditionLabelForLocale,
    googleTypeToCondition,
    uvLabel,
    windCompass,
} from '@/lib/weather/weather-codes'
import { effectiveWeatherHours, executeWeatherShow } from '@/lib/ai/tools/weather'
import {
    readCachedWeather,
    weatherCacheSize,
    writeCachedWeather,
    invalidateWeatherCache,
} from '@/lib/weather/cache'
import {
    openMeteoProvider,
    googleWeatherProvider,
    WEATHER_PROVIDER_CHAIN,
} from '@/lib/weather/providers'
import { enrichWeatherArtifact } from '@/lib/weather/enrichment'
import {
    getArtifactUpdateData,
    getDirectEmitArtifactData,
    stripArtifactUpdatePayload,
    stripDirectEmitPayload,
} from '@/lib/artifacts/direct-emit'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// --- schema: minimal valid -------------------------------------------------

const minimalArtifact = {
    location: {
        name: 'Bucharest',
        country: 'RO',
        coordinates: [26.1, 44.43],
        timezone: 'Europe/Bucharest',
    },
    units: 'metric' as const,
    fetchedAt: new Date().toISOString(),
    provider: 'google' as const,
    current: {
        temperature: 22.5,
        feelsLike: 21,
        condition: 'partly-cloudy' as const,
        conditionLabel: 'Partly cloudy',
        isDay: true,
        humidity: 64,
        windSpeed: 3.2,
        windDirection: 45,
        precipitation: 0,
        pressure: 1013,
        visibility: 10,
        uvIndex: 4,
        cloudCover: 40,
    },
    hourly: [],
    daily: [
        {
            date: '2025-05-21',
            condition: 'partly-cloudy' as const,
            conditionLabel: 'Partly cloudy',
            temperatureHigh: 26,
            temperatureLow: 14,
            precipitationProbability: 10,
            precipitationSum: 0,
            uvIndexMax: 5,
            sunrise: '2025-05-21T05:46:00+03:00',
            sunset: '2025-05-21T20:34:00+03:00',
            windSpeedMax: 5.5,
        },
    ],
}
{
    const json = JSON.stringify(minimalArtifact)
    const r = parseWeatherArtifact(json)
    check('schema: minimal artifact parses', r.ok)
    if (r.ok) {
        check('schema: location preserved', r.value.location.name === 'Bucharest')
        check('schema: condition normalized', r.value.current.condition === 'partly-cloudy')
        check('schema: daily has 1 entry', r.value.daily.length === 1)
        check('schema: airQuality stays undefined', r.value.airQuality === undefined)
    }
}

// --- schema: rich valid ----------------------------------------------------

const richArtifact = {
    ...minimalArtifact,
    hourly: [
        { time: '2025-05-21T12:00:00+03:00', temperature: 22, condition: 'clear', precipitationProbability: 0, isDay: true },
        { time: '2025-05-21T13:00:00+03:00', temperature: 24, condition: 'partly-cloudy', precipitationProbability: 5, isDay: true },
        { time: '2025-05-21T14:00:00+03:00', temperature: 25, condition: 'rain', precipitationProbability: 70, isDay: true },
    ],
    daily: [
        ...minimalArtifact.daily,
        {
            date: '2025-05-22',
            condition: 'rain' as const,
            conditionLabel: 'Light rain',
            temperatureHigh: 21,
            temperatureLow: 12,
            precipitationProbability: 80,
            precipitationSum: 5.4,
            uvIndexMax: 3,
            sunrise: '2025-05-22T05:45:00+03:00',
            sunset: '2025-05-22T20:35:00+03:00',
            windSpeedMax: 8,
        },
    ],
    airQuality: { aqi: 42, aqiLabel: 'Good', pm25: 6.2, pm10: 18 },
    outfit: {
        source: 'model' as const,
        generatedAt: new Date().toISOString(),
        headline: 'Light jacket',
        summary: 'Cool air and a rain chance make a light layer the practical choice.',
        items: ['Feels 16°C', '70% rain', 'Wind 3 m/s'],
    },
    alerts: [{
        id: 'rain-next',
        source: 'forecast' as const,
        kind: 'rain' as const,
        severity: 'advisory' as const,
        title: 'Rain likely',
        summary: '70% rain risk this afternoon.',
    }],
    why: [{
        kind: 'feels_like' as const,
        title: 'Feels-like gap',
        value: '16°',
        explanation: 'Wind is making it feel cooler than the raw temperature.',
        severity: 'useful' as const,
    }],
    historical: {
        source: 'open-meteo-archive' as const,
        generatedAt: new Date().toISOString(),
        targetDate: '2025-05-21',
        sampleYears: 10,
        temperatureHigh: { current: 26, normal: 24, anomaly: 2 },
        precipitation: { current: 1.2, normal: 2.4, anomaly: -1.2 },
        summary: 'Close to recent same-date history.',
    },
    pollen: {
        source: 'open-meteo-air-quality' as const,
        generatedAt: new Date().toISOString(),
        primary: { kind: 'grass' as const, label: 'Grass', value: 12, level: 'moderate' as const },
        species: [{ kind: 'grass' as const, label: 'Grass', value: 12, level: 'moderate' as const }],
        summary: 'Grass is the main pollen signal right now.',
    },
    radar: {
        source: 'rainviewer' as const,
        generatedAt: new Date().toISOString(),
        frameTime: new Date().toISOString(),
        imageUrl: 'https://tilecache.rainviewer.com/v2/radar/1609402200/512/7/44.43000/26.10000/2/1_1.png',
        viewerUrl: 'https://www.rainviewer.com/map.html?c=1&layer=radar&loc=44.43000%2C26.10000%2C7',
        attribution: 'RainViewer radar',
    },
    calendarContext: [{
        title: 'Meeting',
        startTime: '2025-05-21T14:00:00+03:00',
        locationName: 'Bucharest',
        temperature: 24,
        precipitationProbability: 70,
        note: 'Rain window overlaps the meeting.',
    }],
    attribution: 'Live data',
}
{
    const json = JSON.stringify(richArtifact)
    const r = parseWeatherArtifact(json)
    check('schema: rich artifact parses', r.ok)
    if (r.ok) {
        check('schema: hourly preserved', r.value.hourly.length === 3)
        check('schema: airQuality preserved', r.value.airQuality?.aqiLabel === 'Good')
        check('schema: outfit preserved', r.value.outfit?.headline === 'Light jacket')
        check('schema: alerts preserved', r.value.alerts?.[0]?.kind === 'rain')
        check('schema: why preserved', r.value.why?.[0]?.kind === 'feels_like')
        check('schema: why source defaults to model', r.value.why?.[0]?.source === 'model')
        check('schema: historical preserved', r.value.historical?.sampleYears === 10)
        check('schema: pollen preserved', r.value.pollen?.primary?.kind === 'grass')
        check('schema: radar preserved', r.value.radar?.source === 'rainviewer')
        check('schema: radar viewer URL preserved', r.value.radar?.viewerUrl?.includes('rainviewer.com/map.html'))
        check('schema: calendar context preserved', r.value.calendarContext?.[0]?.title === 'Meeting')
        check('schema: attribution preserved', r.value.attribution === 'Live data')
    }
}
{
    const hourly = Array.from({ length: 264 }, (_, i) => ({
        time: `2026-05-${String(20 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00+03:00`,
        temperature: 20,
        condition: 'clear' as const,
        precipitationProbability: 0,
        isDay: i % 24 >= 6 && i % 24 < 21,
    }))
    const r = parseWeatherArtifact(JSON.stringify({ ...minimalArtifact, hourly }))
    check('schema: hourly accepts 240 forecast + 24 history entries', r.ok, r.ok ? null : r.error)
}
{
    const r = parseWeatherArtifact(JSON.stringify({
        ...minimalArtifact,
        location: { ...minimalArtifact.location, country: 'United States' },
    }))
    check('schema: country accepts geocoder long names', r.ok, r.ok ? null : r.error)
}
{
    const enriched = await enrichWeatherArtifact(WeatherArtifactSchema.parse(minimalArtifact), {
        includeAlerts: false,
        includeHistorical: false,
        includePollen: false,
        includeRadar: false,
    })
    check('enrichment: why is not deterministic', enriched.why === undefined)
}
{
    const json = JSON.stringify({
        ...minimalArtifact,
        pollen: {
            source: 'google-pollen' as const,
            generatedAt: new Date().toISOString(),
            primary: { kind: 'tree' as const, label: 'Tree', value: 4, level: 'high' as const },
            species: [
                { kind: 'tree' as const, label: 'Tree', value: 4, level: 'high' as const },
                { kind: 'weed' as const, label: 'Weed', value: 2, level: 'moderate' as const },
            ],
            summary: 'Tree is the main Google Pollen signal right now.',
        },
    })
    const r = parseWeatherArtifact(json)
    check('schema: Google pollen source parses', r.ok)
    if (r.ok) {
        check('schema: Google pollen tree kind preserved', r.value.pollen?.primary?.kind === 'tree')
        check('schema: Google pollen weed kind preserved', r.value.pollen?.species[1]?.kind === 'weed')
    }
}

// --- schema: rejections ----------------------------------------------------

const badCases: Array<[string, string, RegExp]> = [
    ['rejects non-JSON', '{not json', /Invalid JSON/],
    ['rejects empty body', JSON.stringify({}), /location/],
    ['rejects out-of-range latitude',
        JSON.stringify({ ...minimalArtifact, location: { ...minimalArtifact.location, coordinates: [10, 99] } }),
        /location\.coordinates/],
    ['rejects bad units',
        JSON.stringify({ ...minimalArtifact, units: 'kelvin' }),
        /units/],
    ['rejects unknown condition',
        JSON.stringify({ ...minimalArtifact, current: { ...minimalArtifact.current, condition: 'asteroid' } }),
        /current\.condition/],
    ['rejects out-of-range humidity',
        JSON.stringify({ ...minimalArtifact, current: { ...minimalArtifact.current, humidity: 150 } }),
        /current\.humidity/],
    ['rejects bad date format on daily',
        JSON.stringify({ ...minimalArtifact, daily: [{ ...minimalArtifact.daily[0], date: '21/05/2025' }] }),
        /daily\.0\.date/],
    ['rejects empty daily',
        JSON.stringify({ ...minimalArtifact, daily: [] }),
        /daily/],
    ['rejects unknown provider',
        JSON.stringify({ ...minimalArtifact, provider: 'accuweather' }),
        /provider/],
]
for (const [label, raw, pathRe] of badCases) {
    const r = parseWeatherArtifact(raw)
    const matched = !r.ok && pathRe.test(r.error)
    check(`schema: ${label}`, matched, r.ok ? 'unexpectedly parsed' : r.error)
}

// --- schema: defaults & safeParse ------------------------------------------

{
    const parsed = WeatherArtifactSchema.safeParse(minimalArtifact)
    check('schema (direct): safeParse succeeds', parsed.success)
}

// --- direct emit normalization --------------------------------------------

{
    const directPayload = {
        directEmit: true,
        identifier: 'bucharest-weather',
        title: 'Weather in Bucharest',
        type: 'application/vnd.ant.weather',
        display: 'inline',
        body: JSON.stringify(minimalArtifact),
        usage: 'Card mounted automatically.',
        providerUsed: 'google',
        modelContext: { now: { temperature: 21 } },
    }
    const fromObject = getDirectEmitArtifactData(directPayload)
    check('direct-emit: reads object payload', fromObject?.identifier === 'bucharest-weather')
    check('direct-emit: keeps weather body', fromObject?.body === directPayload.body)

    const fromString = getDirectEmitArtifactData(JSON.stringify(directPayload))
    check('direct-emit: reads string payload from Codex provider', fromString?.type === 'application/vnd.ant.weather')

    const stripped = stripDirectEmitPayload(directPayload)
    check('direct-emit: strips body from displayed result', !('body' in stripped))
    check('direct-emit: marks artifact as mounted', stripped.directEmitted === true)
    check('direct-emit: preserves provider metadata', stripped.providerUsed === 'google')
    check('direct-emit: preserves compact model context', typeof stripped.modelContext === 'object')

    const updatePayload = {
        artifactUpdate: true,
        identifier: 'bucharest-weather',
        title: 'Weather in Bucharest',
        type: 'application/vnd.ant.weather',
        display: 'inline',
        body: JSON.stringify(richArtifact),
    }
    const update = getArtifactUpdateData(updatePayload)
    check('artifact-update: reads update payload', update?.identifier === 'bucharest-weather')
    const strippedUpdate = stripArtifactUpdatePayload(updatePayload)
    check('artifact-update: strips body from displayed result', !('body' in strippedUpdate))
    check('artifact-update: marks artifact as updated', strippedUpdate.artifactUpdated === true)
}

// --- weather-codes: mapping coverage --------------------------------------

const googleTypes = [
    'CLEAR', 'MOSTLY_CLEAR', 'PARTLY_CLOUDY', 'MOSTLY_CLOUDY', 'CLOUDY',
    'WINDY', 'WIND_AND_RAIN',
    'LIGHT_RAIN_SHOWERS', 'CHANCE_OF_SHOWERS', 'SCATTERED_SHOWERS', 'RAIN_SHOWERS', 'HEAVY_RAIN_SHOWERS',
    'LIGHT_TO_MODERATE_RAIN', 'MODERATE_TO_HEAVY_RAIN', 'RAIN', 'LIGHT_RAIN', 'HEAVY_RAIN',
    'LIGHT_SNOW_SHOWERS', 'CHANCE_OF_SNOW_SHOWERS', 'SCATTERED_SNOW_SHOWERS', 'SNOW_SHOWERS', 'HEAVY_SNOW_SHOWERS',
    'LIGHT_TO_MODERATE_SNOW', 'MODERATE_TO_HEAVY_SNOW', 'SNOW', 'LIGHT_SNOW', 'HEAVY_SNOW',
    'SNOWSTORM', 'HEAVY_SNOW_STORM', 'BLOWING_SNOW',
    'RAIN_AND_SNOW',
    'HAIL', 'HAIL_SHOWERS',
    'THUNDERSTORM', 'THUNDERSHOWER', 'LIGHT_THUNDERSTORM_RAIN', 'SCATTERED_THUNDERSTORMS', 'HEAVY_THUNDERSTORM',
] as const
for (const t of googleTypes) {
    const cond = googleTypeToCondition(t)
    // Every Google type should map to a non-'unknown' condition. Unknown is
    // reserved for TYPE_UNSPECIFIED and outright bogus strings.
    check(`code-map: ${t} → known condition`, cond !== 'unknown', cond)
}

check('code-map: TYPE_UNSPECIFIED → unknown', googleTypeToCondition('TYPE_UNSPECIFIED') === 'unknown')
check('code-map: empty string → unknown', googleTypeToCondition('') === 'unknown')
check('code-map: bogus string → unknown', googleTypeToCondition('UFO_INVASION') === 'unknown')

// --- weather-codes: label helpers ------------------------------------------

check('label: clear has a default', conditionLabel('clear') === 'Clear')
check('label: unknown has a default', conditionLabel('unknown') === 'Unknown')
check('label: Romanian clear is weather, not UI verb', conditionLabelForLocale('clear', 'ro') === 'Senin')
check('label: Romanian storm localizes', conditionLabelForLocale('thunderstorm', 'ro-RO') === 'Furtună')

check('uv: 0 → Low', uvLabel(0) === 'Low')
check('uv: 2 → Low', uvLabel(2) === 'Low')
check('uv: 5 → Moderate', uvLabel(5) === 'Moderate')
check('uv: 7 → High', uvLabel(7) === 'High')
check('uv: 10 → Very High', uvLabel(10) === 'Very High')
check('uv: 12 → Extreme', uvLabel(12) === 'Extreme')

check('wind compass: 0 → N', windCompass(0) === 'N')
check('wind compass: 90 → E', windCompass(90) === 'E')
check('wind compass: 180 → S', windCompass(180) === 'S')
check('wind compass: 270 → W', windCompass(270) === 'W')
check('wind compass: 45 → NE', windCompass(45) === 'NE')
check('wind compass: 359 wraps to N', windCompass(359) === 'N')
check('wind compass: negative wraps', windCompass(-90) === 'W')

check('aqi: 25 → Good', aqiLabel(25) === 'Good')
check('aqi: 75 → Moderate', aqiLabel(75) === 'Moderate')
check('aqi: 125 → USG', aqiLabel(125) === 'Unhealthy for Sensitive Groups')
check('aqi: 175 → Unhealthy', aqiLabel(175) === 'Unhealthy')
check('aqi: 250 → Very Unhealthy', aqiLabel(250) === 'Very Unhealthy')
check('aqi: 400 → Hazardous', aqiLabel(400) === 'Hazardous')

// --- WeatherShow tool input validation ------------------------------------

{
    const empty = await executeWeatherShow({ location: '' })
    check('WeatherShow: rejects empty location', !empty.success && /non-empty/.test(empty.error ?? ''))

    const missing = await executeWeatherShow({})
    check('WeatherShow: rejects missing location', !missing.success && /location/.test(missing.error ?? ''))

    const badId = await executeWeatherShow({ location: 'Bucharest', identifier: 'Bad Id With Spaces' })
    check('WeatherShow: rejects non-kebab-case identifier', !badId.success && /kebab-case/.test(badId.error ?? ''))

    check('WeatherShow: hours default to days horizon plus boundary buffer', effectiveWeatherHours(3, undefined) === 96)
    check('WeatherShow: hours cannot undershoot visible days', effectiveWeatherHours(3, 24) === 96)
    check('WeatherShow: hours can request longer horizon', effectiveWeatherHours(3, 96) === 96)
}

// --- provider chain --------------------------------------------------------

check('chain: WEATHER_PROVIDER_CHAIN has 2 providers', WEATHER_PROVIDER_CHAIN.length === 2)
check('chain: google is first', WEATHER_PROVIDER_CHAIN[0].id === 'google')
check('chain: open-meteo is second', WEATHER_PROVIDER_CHAIN[1].id === 'open-meteo')
check('chain: open-meteo has geocode method', typeof openMeteoProvider.geocode === 'function')
check('chain: google has no geocode method (uses maps integration)', typeof googleWeatherProvider.geocode !== 'function')

// --- cache ------------------------------------------------------------------

invalidateWeatherCache()
{
    const args = { lat: 44.43, lng: 26.1, units: 'metric' as const, days: 7, hours: 24, includeAirQuality: true, languageCode: 'en' }
    check('cache: miss on cold cache', readCachedWeather(args) === null)

    // Synthetic result — only need shape to confirm cache roundtrip.
    const stub = {
        current: { temperature: 20, feelsLike: 19, condition: 'clear' as const, conditionLabel: 'Clear', isDay: true, humidity: 50, windSpeed: 2, windDirection: 90, precipitation: 0, pressure: 1013, visibility: 10, uvIndex: 5, cloudCover: 10 },
        hourly: [],
        daily: [{ date: '2026-05-21', condition: 'clear' as const, conditionLabel: 'Clear', temperatureHigh: 25, temperatureLow: 14, precipitationProbability: 0, precipitationSum: 0, uvIndexMax: 6, sunrise: '2026-05-21T05:46:00+03:00', sunset: '2026-05-21T20:34:00+03:00', windSpeedMax: 3 }],
        timezone: 'Europe/Bucharest',
    }
    writeCachedWeather(args, stub, 'open-meteo')
    const hit = readCachedWeather(args)
    check('cache: hit returns stored result', hit !== null && hit.provider === 'open-meteo')
    check('cache: size is 1', weatherCacheSize() === 1)

    // Quantisation: nearby coords should share a bucket.
    const near = { ...args, lat: 44.434, lng: 26.103 }
    check('cache: ~1km neighbour shares bucket', readCachedWeather(near) !== null)

    // Different units must NOT share.
    const otherUnits = { ...args, units: 'imperial' as const }
    check('cache: imperial does not share bucket with metric', readCachedWeather(otherUnits) === null)

    invalidateWeatherCache()
    check('cache: invalidate wipes', weatherCacheSize() === 0)
}

// Live-network tests below — only run when GOOGLE_MAPS_API_KEY is set AND
// SMOKE_NETWORK=1. This is a paid API; CI should not call it on every PR.

if (process.env.SMOKE_NETWORK === '1' && process.env.GOOGLE_MAPS_API_KEY) {
    console.log('\n[network] running live Google Weather smoke...')
    const live = await executeWeatherShow({ location: '44.4326,26.1', units: 'metric', days: 3, hours: 6 })
    if (!live.success) {
        check('WeatherShow (live): direct lat/lng succeeds', false, live.error)
    } else {
        const data = live.data as Record<string, unknown>
        check('WeatherShow (live): returns type', data.type === 'application/vnd.ant.weather')
        check('WeatherShow (live): returns inline display', data.display === 'inline')
        check('WeatherShow (live): body is JSON string',
            typeof data.body === 'string' && (data.body as string).startsWith('{'))
        if (typeof data.body === 'string') {
            const parsed = parseWeatherArtifact(data.body)
            check('WeatherShow (live): body re-parses against schema', parsed.ok, parsed.ok ? null : parsed.error)
            if (parsed.ok) {
                check('WeatherShow (live): daily has at least 1 entry', parsed.value.daily.length >= 1)
                check('WeatherShow (live): provider is google', parsed.value.provider === 'google')
            }
        }
    }
}

// --- summary ---------------------------------------------------------------

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
}
console.log('\nAll weather smoke checks passed.')
