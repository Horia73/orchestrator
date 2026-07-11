import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { LruCache } from '@/lib/cache/lru-cache'
import { listVersionsForIdentifier } from '@/lib/artifacts/store'
import {
    geocodeAddresses,
    reverseGeocode,
} from '@/lib/maps/google-geocoding'
import {
    coordinateLabel,
    pickCountryName,
    pickLocalityName,
    pickRegionName,
    pickShortName,
    splitFormattedAddress,
} from '@/lib/ai/tools/weather-location-formatting'
import { getWeatherIntegrationStatus } from '@/lib/integrations/weather'
import { readCachedWeather, writeCachedWeather } from '@/lib/weather/cache'
import {
    googleWeatherProvider,
    openMeteoProvider,
    WEATHER_PROVIDER_CHAIN,
    type WeatherProviderClient,
} from '@/lib/weather/providers'
import { WeatherProviderError, type WeatherFetchResult } from '@/lib/weather/providers/types'
import {
    WeatherArtifactSchema,
    type WeatherArtifact,
    type WeatherCalendarContext,
    type WeatherLocation,
    type WeatherUnits,
    type WeatherWhy,
} from '@/lib/weather/schema'
import { enrichWeatherArtifact, type WeatherEnrichmentOptions } from '@/lib/weather/enrichment'

// ---------------------------------------------------------------------------
// WeatherShow — orchestrator-only forecast artifact builder.
//
// One tool, end-to-end:
//   1. Resolve `location` to coordinates (via Google geocoder if available,
//      otherwise via Open-Meteo's free geocoder).
//   2. Pick a provider from `WEATHER_PROVIDER_CHAIN` (Google → Open-Meteo
//      fallback). Skips providers whose `isAvailable()` returns false.
//   3. Check the 10-minute cache for the resolved coords + units; reuse if
//      fresh and `refresh` wasn't set.
//   4. Call the chosen provider's `fetchWeather()`; on
//      `WeatherProviderError` try the next provider; on other errors
//      propagate.
//   5. Validate against `WeatherArtifactSchema`, write to cache, and
//      return the canonical artifact body.
//
// The tool returns a `providerUsed` field so the orchestrator prompt can
// emit the one-time "consider upgrading to Google for richer data" hint
// when Open-Meteo served the response.
// ---------------------------------------------------------------------------

export const WEATHER_SHOW_TOOL_ID = 'WeatherShow'
export const WEATHER_SET_OUTFIT_TOOL_ID = 'WeatherSetOutfit'
export const WEATHER_SET_WHY_TOOL_ID = 'WeatherSetWhy'
export const WEATHER_SET_CALENDAR_CONTEXT_TOOL_ID = 'WeatherSetCalendarContext'

export const weatherShowTool: ToolDef = {
    id: WEATHER_SHOW_TOOL_ID,
    name: WEATHER_SHOW_TOOL_ID,
    description: [
        'Render a live weather forecast as an inline artifact (current conditions + next 24 hours + up to 10-day outlook + UV/wind/sunrise/sunset detail tiles + optional air quality, styled like iOS Weather).',
        'Accepts a place name (geocoded server-side) OR a "lat,lng" pair; coordinate inputs are reverse-geocoded for a city label when Google Geocoding is available.',
        'Provider chain: tries Google Weather first (when GOOGLE_MAPS_API_KEY + Weather API are configured), falls back to Open-Meteo (keyless, ECMWF-backed, excellent for Europe). The returned `providerUsed` field tells you which one answered.',
        'In normal chat turns success mounts the card INSTANTLY (the chat route injects the artifact tag for you) with the live forecast already visible, and returns { directEmitted, identifier, title, modelContext, providerUsed, googleAvailable, suggestGoogleUpgrade }. The Outfit and "Why it feels this way" tiles render a "Working…" placeholder until you fill them. Do not emit an artifact tag yourself.',
        'Use `modelContext` to call WeatherSetWhy and WeatherSetOutfit with the returned `identifier`; each one slots its content into the already-visible card in place (no second card, no flicker). No closing chat message is required — finishing the card is the deliverable.',
        'When `suggestGoogleUpgrade: true`, the orchestrator should ONCE per conversation (and only if the user has not already declined) suggest enabling the Google Weather API for richer condition descriptions and local air quality. Respect prior declines persisted in MEMORY.md.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'Place name ("Bucharest", "Times Square") OR "lat,lng" ("44.43,26.10"). If the user says "my location" and no coordinates are already available, ask for a city instead of guessing. WeatherShow will reverse-geocode a human city label when possible.',
            },
            units: {
                type: 'string',
                enum: ['metric', 'imperial'],
                description: 'Defaults to "metric" (°C, m/s, km, mm). Use "imperial" only when the user explicitly asks for Fahrenheit / mph.',
            },
            days: { type: 'number', description: '1..10. The model should choose what fits the user request: "tomorrow" => 2, "this week" => 7, vague weather => usually 3-7. If omitted, the server uses 5 as a safety fallback.' },
            hours: { type: 'number', description: '1..240. Minimum effective value is days * 24 plus a calendar-boundary buffer so the daily-row expansion has hourly data for every visible day. Leave unset unless you specifically need a longer horizon.' },
            targetDate: { type: 'string', description: 'Optional focus date as YYYY-MM-DD, or "today"/"tomorrow". Use for requests like "tomorrow"; the server still fetches from today but expands days so this date is included.' },
            start: { type: 'string', description: 'Alias for targetDate. Accepted because some schedulers/providers call the requested forecast date "start".' },
            startDate: { type: 'string', description: 'Alias for targetDate.' },
            date: { type: 'string', description: 'Alias for targetDate.' },
            languageCode: { type: 'string', description: 'BCP-47 ("en", "ro", "fr"). Default "en".' },
            identifier: { type: 'string', description: 'Stable kebab-case handle. Reuse to refresh the same location.' },
            title: { type: 'string', description: 'Defaults to "Weather in <resolved name>".' },
            attribution: { type: 'string', description: 'Optional short suffix on the attribution line.' },
            includeAirQuality: { type: 'boolean', description: 'Defaults to true. Set false to skip the AQ fetch (cheaper, slightly faster).' },
            includeAlerts: { type: 'boolean', description: 'Defaults to true. Adds forecast-derived heads-up banners for rain, wind, UV, AQI, heat/cold, fog, or storms.' },
            includeHistorical: { type: 'boolean', description: 'Defaults to true. Adds same-date comparison from Open-Meteo archive when available.' },
            includePollen: { type: 'boolean', description: 'Defaults to true. Adds Open-Meteo pollen signal when available (Europe/seasonal).' },
            includeRadar: { type: 'boolean', description: 'Defaults to true. Adds latest RainViewer radar widget URL when available.' },
            smartGuidance: { type: 'boolean', description: 'Defaults to true in chat turns: mount the card instantly with the live forecast AND reserve "Working…" placeholders for the model-authored Outfit + Why tiles, which you then fill via WeatherSetOutfit / WeatherSetWhy. Set false only when the user explicitly does not want clothing/why guidance — then the base card mounts with no placeholders and you should not call the setters. (Legacy alias: deferDisplay:false has the same effect.)' },
            refresh: { type: 'boolean', description: 'Bypass the 10-minute cache.' },
            preferProvider: {
                type: 'string',
                enum: ['google', 'open-meteo'],
                description: 'Override the provider chain. Use when the user explicitly asked for a specific source (rare).',
            },
        },
        required: ['location'],
    },
    tags: ['weather'],
}

export const weatherSetCalendarContextTool: ToolDef = {
    id: WEATHER_SET_CALENDAR_CONTEXT_TOOL_ID,
    name: WEATHER_SET_CALENDAR_CONTEXT_TOOL_ID,
    description: [
        'Attach calendar/event context to the latest WeatherShow artifact in this conversation.',
        'Use after you look up calendar events and have a weather card for the event location.',
        'The tool updates the same visible card with a compact event-weather row. Do not emit an artifact tag yourself.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            identifier: {
                type: 'string',
                description: 'Weather artifact identifier returned by WeatherShow, e.g. "cluj-napoca-weather".',
            },
            events: {
                type: 'array',
                description: '1-5 event rows to show on the weather card.',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        startTime: { type: 'string', description: 'ISO timestamp or calendar display timestamp.' },
                        endTime: { type: 'string' },
                        locationName: { type: 'string' },
                        conditionLabel: { type: 'string' },
                        temperature: { type: 'number' },
                        precipitationProbability: { type: 'number' },
                        note: { type: 'string' },
                    },
                    required: ['title', 'startTime'],
                },
            },
        },
        required: ['identifier', 'events'],
    },
    tags: ['weather'],
}

export const weatherSetOutfitTool: ToolDef = {
    id: WEATHER_SET_OUTFIT_TOOL_ID,
    name: WEATHER_SET_OUTFIT_TOOL_ID,
    description: [
        'Fill the Outfit tile of the already-visible WeatherShow card with model-generated clothing guidance.',
        'WeatherShow mounts the card instantly with the Outfit tile showing "Working…"; call this with the returned `identifier` to slot your guidance into that tile in place (no second card, no flicker). Ground it in WeatherShow `modelContext`.',
        'Do not emit an artifact tag yourself, and no closing chat message is required afterwards.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            identifier: {
                type: 'string',
                description: 'Weather artifact identifier returned by WeatherShow, e.g. "cluj-napoca-weather".',
            },
            headline: {
                type: 'string',
                description: 'Short model-written recommendation shown as the tile headline, e.g. "Light jacket" or "Umbrella worth carrying".',
            },
            summary: {
                type: 'string',
                description: 'One concise practical sentence grounded in WeatherShow.modelContext.',
            },
            items: {
                type: 'array',
                items: { type: 'string' },
                description: '1-5 compact chips, e.g. ["Feels 16°C", "35% rain", "Wind 4 m/s"].',
            },
        },
        required: ['identifier', 'headline', 'summary'],
    },
    tags: ['weather'],
}

export const weatherSetWhyTool: ToolDef = {
    id: WEATHER_SET_WHY_TOOL_ID,
    name: WEATHER_SET_WHY_TOOL_ID,
    description: [
        'Fill the "Why it feels this way" tile of the already-visible WeatherShow card with model-generated explanation rows.',
        'WeatherShow mounts the card instantly with this tile showing "Working…"; call this with the returned `identifier` to slot your rows into that tile in place. Ground every row in WeatherShow `modelContext`.',
        'Use localTime from modelContext: at night, explain current comfort and only mention UV as a later daytime factor if useful.',
        'Do not emit an artifact tag yourself, and no closing chat message is required afterwards.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            identifier: {
                type: 'string',
                description: 'Weather artifact identifier returned by WeatherShow, e.g. "cluj-napoca-weather".',
            },
            rows: {
                type: 'array',
                description: '1-5 model-written explanation rows grounded in WeatherShow.modelContext.',
                items: {
                    type: 'object',
                    properties: {
                        kind: {
                            type: 'string',
                            enum: ['feels_like', 'humidity', 'wind', 'uv', 'air_quality', 'pressure', 'precipitation'],
                        },
                        title: { type: 'string', description: 'Short label, e.g. "Cooler than it reads".' },
                        value: { type: 'string', description: 'Compact value, e.g. "15°C", "6 UV", "35%".' },
                        explanation: { type: 'string', description: 'One sentence explaining why this matters now or later today.' },
                        severity: { type: 'string', enum: ['neutral', 'useful', 'caution'] },
                    },
                    required: ['kind', 'title', 'value', 'explanation'],
                },
            },
        },
        required: ['identifier', 'rows'],
    },
    tags: ['weather'],
}

// --- helpers ---------------------------------------------------------------

function slugifyLocation(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'weather'
}

const KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

function parseLatLng(input: string): { lat: number; lng: number } | null {
    const m = input.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/)
    if (!m) return null
    const lat = parseFloat(m[1]), lng = parseFloat(m[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return { lat, lng }
}

export function effectiveWeatherHours(days: number, requestedHours: unknown): number {
    const safeDays = Math.max(1, Math.min(10, Math.floor(days)))
    // Daily rows are calendar days, but hourly forecasts are rolling windows
    // from "now". Add one extra day so an evening request for a 5-day card
    // still has hourly data on the last displayed calendar day.
    const minimumHoursForVisibleDays = Math.min(240, safeDays * 24 + 24)
    return typeof requestedHours === 'number' && Number.isFinite(requestedHours)
        ? Math.max(minimumHoursForVisibleDays, Math.min(240, Math.floor(requestedHours)))
        : minimumHoursForVisibleDays
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

export function effectiveWeatherDays(requestedDays: number, targetDate: string, todayDate: string): number {
    const safeDays = Math.max(1, Math.min(10, Math.floor(requestedDays)))
    const offset = calendarDayOffset(todayDate, targetDate)
    if (!Number.isFinite(offset) || offset < 0) return safeDays
    return Math.max(safeDays, Math.min(10, offset + 1))
}

function resolveWeatherTargetDate(
    args: Record<string, unknown>,
    timezone: string | undefined,
): { targetDate?: string; todayDate: string } | { error: string } {
    const raw = firstStringArg(args, ['targetDate', 'target_date', 'startDate', 'start', 'date'])
    const todayDate = localDateString(new Date(), timezone || 'UTC')
    if (!raw) return { todayDate }

    const targetDate = normalizeTargetDate(raw, todayDate)
    if (!targetDate) {
        return {
            error: `WeatherShow targetDate/start must be YYYY-MM-DD, "today", or "tomorrow"; received "${raw}".`,
        }
    }
    const offset = calendarDayOffset(todayDate, targetDate)
    if (offset < 0) {
        return {
            error: `WeatherShow only returns current/future forecasts. targetDate/start "${targetDate}" is before today (${todayDate}).`,
        }
    }
    if (offset >= 10) {
        return {
            error: `WeatherShow can forecast up to 10 days ahead. targetDate/start "${targetDate}" is outside that window from today (${todayDate}).`,
        }
    }
    return { targetDate, todayDate }
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function normalizeTargetDate(raw: string, todayDate: string): string | null {
    const value = raw.trim().toLowerCase()
    if (YMD_RE.test(value)) return value
    const ascii = value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    if (ascii === 'today' || ascii === 'azi') return todayDate
    if (ascii === 'tomorrow' || ascii === 'maine') return addCalendarDays(todayDate, 1)
    return null
}

function localDateString(date: Date, timezone: string): string {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date)
        const y = parts.find(part => part.type === 'year')?.value
        const m = parts.find(part => part.type === 'month')?.value
        const d = parts.find(part => part.type === 'day')?.value
        if (y && m && d) return `${y}-${m}-${d}`
    } catch { /* ignore invalid timezone */ }
    return date.toISOString().slice(0, 10)
}

function calendarDayOffset(fromDate: string, toDate: string): number {
    const from = ymdUtcMs(fromDate)
    const to = ymdUtcMs(toDate)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN
    return Math.round((to - from) / DAY_MS)
}

function addCalendarDays(date: string, days: number): string {
    const ms = ymdUtcMs(date)
    if (!Number.isFinite(ms)) return date
    return new Date(ms + days * DAY_MS).toISOString().slice(0, 10)
}

function ymdUtcMs(date: string): number {
    if (!YMD_RE.test(date)) return Number.NaN
    const [y, m, d] = date.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
}

function hourLocalDate(iso: string, timezone: string): string {
    if (!iso) return ''
    if (!hasExplicitTimezone(iso)) return iso.slice(0, 10)
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: timezone,
        }).formatToParts(d)
        const y = parts.find(p => p.type === 'year')?.value
        const m = parts.find(p => p.type === 'month')?.value
        const day = parts.find(p => p.type === 'day')?.value
        if (y && m && day) return `${y}-${m}-${day}`
    } catch { /* ignore */ }
    return iso.slice(0, 10)
}

function hasHourlyForEveryDailyRow(result: WeatherFetchResult, timezone: string): boolean {
    if (result.daily.length <= 1) return result.hourly.length > 0
    const coveredDates = new Set(result.hourly.map(hour => hourLocalDate(hour.time, timezone)).filter(Boolean))
    return result.daily.every(day => coveredDates.has(day.date))
}

// --- geocoding -------------------------------------------------------------

interface ResolvedLocation {
    name: string
    region?: string
    country?: string
    coordinates: [number, number]
    timezone?: string
    /** Source we used — telemetry hint, not returned to the caller. */
    via: 'latlng' | 'reverse-google' | 'google' | 'open-meteo'
}

async function resolveLocation(
    location: string,
    languageCode: string,
    googleUsable: boolean,
): Promise<ResolvedLocation | { error: string }> {
    // Direct lat/lng — no geocode needed.
    const direct = parseLatLng(location)
    if (direct) {
        const fallbackName = coordinateLabel(direct.lat, direct.lng)
        if (googleUsable) {
            const reversed = await reverseGeocode([direct.lng, direct.lat])
            if (!('error' in reversed)) {
                const split = splitFormattedAddress(reversed.formattedAddress)
                return {
                    name: pickLocalityName(reversed.addressComponents) ?? pickShortName(reversed.formattedAddress, fallbackName),
                    region: pickRegionName(reversed.addressComponents) ?? split.region,
                    country: pickCountryName(reversed.addressComponents) ?? split.country,
                    coordinates: [direct.lng, direct.lat],
                    via: 'reverse-google',
                }
            }
        }
        return {
            name: fallbackName,
            coordinates: [direct.lng, direct.lat],
            via: 'latlng',
        }
    }

    // Prefer Google geocoding when the maps key is present — gives canonical
    // addresses + place_id metadata. Falls through to Open-Meteo on miss
    // OR when the maps key isn't configured.
    if (googleUsable) {
        const results = await geocodeAddresses([location])
        const first = results[0]
        if (first && !('error' in first)) {
            const split = splitFormattedAddress(first.formattedAddress)
            return {
                name: pickLocalityName(first.addressComponents) ?? pickShortName(first.formattedAddress, location),
                region: pickRegionName(first.addressComponents) ?? split.region,
                country: pickCountryName(first.addressComponents) ?? split.country,
                coordinates: [first.position[0], first.position[1]],
                via: 'google',
            }
        }
        // Fall through to Open-Meteo geocoder when Google says no results
        // or surfaces a transient error.
    }

    if (!openMeteoProvider.geocode) {
        return { error: `Could not resolve "${location}": no geocoder available.` }
    }
    try {
        const hit = await openMeteoProvider.geocode(location, languageCode)
        if (!hit) return { error: `Could not resolve "${location}": no match.` }
        return {
            name: hit.name,
            region: hit.region,
            country: hit.country,
            coordinates: hit.coordinates,
            timezone: hit.timezone,
            via: 'open-meteo',
        }
    } catch (e) {
        const err = e as Error
        return { error: `Could not resolve "${location}": ${err.message}` }
    }
}

// --- executor --------------------------------------------------------------

export async function executeWeatherShow(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const location = typeof args.location === 'string' ? args.location.trim() : ''
    if (!location) {
        return { success: false, error: 'WeatherShow requires a non-empty `location`. If the user did not specify one and no explicit coordinates are already available, ask the user for a city.' }
    }

    const units: WeatherUnits = args.units === 'imperial' ? 'imperial' : 'metric'
    const requestedDays = typeof args.days === 'number' && Number.isFinite(args.days)
        ? Math.max(1, Math.min(10, Math.floor(args.days))) : 5
    const languageCode = typeof args.languageCode === 'string' && args.languageCode.trim()
        ? args.languageCode.trim() : 'en'
    const includeAirQuality = args.includeAirQuality !== false
    const enrichmentOptions: WeatherEnrichmentOptions = {
        includeAlerts: args.includeAlerts !== false,
        includeHistorical: args.includeHistorical !== false,
        includePollen: args.includePollen !== false,
        includeRadar: args.includeRadar !== false,
    }
    const refresh = args.refresh === true
    const preferProvider = args.preferProvider === 'google' || args.preferProvider === 'open-meteo'
        ? (args.preferProvider as 'google' | 'open-meteo') : null
    const titleArg = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : ''
    const attribution = typeof args.attribution === 'string' && args.attribution.trim()
        ? args.attribution.trim() : undefined
    const identifierArg = typeof args.identifier === 'string' && args.identifier.trim()
        ? args.identifier.trim() : ''
    if (identifierArg && !KEBAB_RE.test(identifierArg)) {
        return {
            success: false,
            error: `WeatherShow identifier "${identifierArg}" must be kebab-case (lowercase letters, digits, hyphens; start with a letter or digit).`,
        }
    }

    // --- availability sweep ----------------------------------------------
    const googleStatus = await getWeatherIntegrationStatus(true)
    const googleAvailable = googleStatus.google.connected
    const googleUsableForGeocoding = googleStatus.configured // maps key present is enough for geocoding even if Weather API isn't enabled yet

    // --- resolve location ------------------------------------------------
    const resolved = await resolveLocation(location, languageCode, googleUsableForGeocoding)
    if ('error' in resolved) {
        return { success: false, error: resolved.error }
    }
    const target = resolveWeatherTargetDate(args, resolved.timezone)
    if ('error' in target) {
        return { success: false, error: target.error }
    }
    const days = target.targetDate
        ? effectiveWeatherDays(requestedDays, target.targetDate, target.todayDate)
        : requestedDays
    // Default hours scale with days so the daily-row "expand to see hourly"
    // gesture has data for every day. Some models still pass hours: 24 for a
    // 3-day card because the top strip says "next 24h"; treat days * 24 as
    // the minimum effective horizon so lower rows do not look broken.
    const hours = effectiveWeatherHours(days, args.hours)
    const [lng, lat] = resolved.coordinates

    // --- pick provider ---------------------------------------------------
    const chain: WeatherProviderClient[] = preferProvider
        ? [preferProvider === 'google' ? googleWeatherProvider : openMeteoProvider]
        : WEATHER_PROVIDER_CHAIN

    // --- cache lookup ----------------------------------------------------
    const cacheKey = { lat, lng, units, days, hours, includeAirQuality, languageCode }
    if (!refresh) {
        const cached = readCachedWeather(cacheKey)
        if (cached) {
            const cacheTimezone = cached.result.timezone ?? resolved.timezone ?? 'UTC'
            if (hasHourlyForEveryDailyRow(cached.result, cacheTimezone)) {
                return await assembleSuccess({
                    resolved, lat, lng, units,
                    result: cached.result,
                    providerUsed: cached.provider,
                    googleAvailable,
                    identifierArg, titleArg, attribution,
                    enrichmentOptions,
                    conversationId: ctx?.conversationId,
                    smartGuidance: wantsSmartGuidance(args, ctx),
                    targetDate: target.targetDate,
                })
            }
        }
    }

    // --- fetch with fallback --------------------------------------------
    const errors: string[] = []
    let providerUsed: 'google' | 'open-meteo' | null = null
    let result: WeatherFetchResult | null = null

    for (const provider of chain) {
        // Cheap skip: ask the provider whether it can run right now.
        let availability
        try { availability = await provider.isAvailable() }
        catch (e) { availability = { available: false, reason: (e as Error).message } }
        if (!availability.available) {
            errors.push(`${provider.id}: ${availability.reason ?? 'unavailable'}`)
            continue
        }

        try {
            result = await provider.fetchWeather({
                lat, lng, units, days, hours, languageCode, includeAirQuality,
            })
            const resultTimezone = result.timezone ?? resolved.timezone ?? 'UTC'
            if (!preferProvider && !hasHourlyForEveryDailyRow(result, resultTimezone)) {
                errors.push(`${provider.id}: hourly forecast covered ${result.hourly.length} hour(s), not every visible daily row`)
                result = null
                continue
            }
            providerUsed = provider.id
            break
        } catch (e) {
            if (e instanceof WeatherProviderError) {
                errors.push(`${e.providerId}: ${e.message}${e.upstreamBody ? ` (${e.upstreamBody})` : ''}`)
                continue
            }
            throw e
        }
    }

    if (!result || !providerUsed) {
        return {
            success: false,
            error: `All weather providers failed: ${errors.join(' | ')}`,
        }
    }

    writeCachedWeather(cacheKey, result, providerUsed)

    return await assembleSuccess({
        resolved, lat, lng, units,
        result,
        providerUsed,
        googleAvailable,
        identifierArg, titleArg, attribution,
        enrichmentOptions,
        conversationId: ctx?.conversationId,
        smartGuidance: wantsSmartGuidance(args, ctx),
        targetDate: target.targetDate,
    })
}

interface AssembleArgs {
    resolved: ResolvedLocation
    lat: number
    lng: number
    units: WeatherUnits
    result: { current: import('@/lib/weather/schema').WeatherCurrent
        hourly: import('@/lib/weather/schema').WeatherHourly[]
        daily: import('@/lib/weather/schema').WeatherDaily[]
        airQuality?: import('@/lib/weather/schema').WeatherAirQuality
        timezone?: string }
    providerUsed: 'google' | 'open-meteo'
    googleAvailable: boolean
    identifierArg: string
    titleArg: string
    attribution?: string
    enrichmentOptions: WeatherEnrichmentOptions
    conversationId?: string
    /** Mount with model-authored Outfit/Why placeholders and stage the card
     *  for in-turn setter merges. False = base card, no placeholders. */
    smartGuidance?: boolean
    targetDate?: string
}

interface PendingWeatherArtifact {
    conversationId: string
    identifier: string
    title: string
    display: 'inline' | 'panel'
    artifact: WeatherArtifact
    providerUsed: 'google' | 'open-meteo'
    googleAvailable: boolean
    createdAt: number
    targetDate?: string
}

const pendingWeatherArtifacts = new LruCache<string, PendingWeatherArtifact>({
    maxEntries: 200,
})
const PENDING_WEATHER_TTL_MS = 10 * 60 * 1000

/** Smart guidance (instant card + Outfit/Why "Working…" placeholders the
 *  orchestrator fills via the setters) is the default in chat turns. It needs
 *  a conversation so the staged copy can be merged in-turn; the user can opt
 *  out with `smartGuidance:false` (legacy: `deferDisplay:false`), which mounts
 *  a plain card and expects no setter calls. */
function wantsSmartGuidance(args: Record<string, unknown>, ctx?: ToolExecutionContext): boolean {
    if (!ctx?.conversationId) return false
    if (args.smartGuidance === false) return false
    if (args.deferDisplay === false) return false
    return true
}

/** Remove a filled smart field from the pending list, returning undefined when
 *  nothing is left so the key drops out of the serialized body entirely. */
function clearPendingField(
    pending: WeatherArtifact['pending'],
    field: 'outfit' | 'why',
): WeatherArtifact['pending'] {
    const next = (pending ?? []).filter((entry) => entry !== field)
    return next.length ? next : undefined
}

function pendingWeatherKey(conversationId: string, identifier: string): string {
    return `${conversationId}::${identifier}`
}

function prunePendingWeatherArtifacts(): void {
    const cutoff = Date.now() - PENDING_WEATHER_TTL_MS
    for (const [key, entry] of pendingWeatherArtifacts) {
        if (entry.createdAt < cutoff) pendingWeatherArtifacts.delete(key)
    }
}

function stagePendingWeatherArtifact(entry: PendingWeatherArtifact): void {
    prunePendingWeatherArtifacts()
    pendingWeatherArtifacts.set(pendingWeatherKey(entry.conversationId, entry.identifier), entry)
}

function readPendingWeatherArtifact(conversationId: string, identifier: string): PendingWeatherArtifact | null {
    prunePendingWeatherArtifacts()
    return pendingWeatherArtifacts.get(pendingWeatherKey(conversationId, identifier)) ?? null
}

function updatePendingWeatherArtifact(entry: PendingWeatherArtifact, artifact: WeatherArtifact): void {
    pendingWeatherArtifacts.set(pendingWeatherKey(entry.conversationId, entry.identifier), {
        ...entry,
        artifact,
        createdAt: Date.now(),
    })
}

function clearPendingWeatherArtifact(entry: PendingWeatherArtifact): void {
    pendingWeatherArtifacts.delete(pendingWeatherKey(entry.conversationId, entry.identifier))
}

/** Build the `artifactUpdate` result a setter returns to patch the visible
 *  card in place. The chat route persists `body` as a new version and pushes
 *  it to the client, which re-renders the same card with the merged field —
 *  prop change, not a remount. */
function weatherArtifactUpdateData(args: {
    identifier: string
    title: string
    display: 'inline' | 'panel' | 'fullscreen'
    artifact: WeatherArtifact
    field: 'outfit' | 'why' | 'calendarContext'
}): Record<string, unknown> {
    const label = args.field === 'calendarContext' ? 'Calendar context' : args.field === 'why' ? 'Why rows' : 'Outfit'
    return {
        artifactUpdate: true,
        identifier: args.identifier,
        title: args.title,
        type: 'application/vnd.ant.weather',
        display: args.display,
        body: JSON.stringify(args.artifact),
        [args.field]: args.artifact[args.field],
        note: `${label} written into the visible weather card in place. Do not emit an artifact tag.`,
    }
}

function normalizeWeatherDisplay(value: unknown): 'inline' | 'panel' | 'fullscreen' {
    return value === 'panel' || value === 'fullscreen' ? value : 'inline'
}

/** Shared merge-and-patch path for the WeatherSet* setters. Prefers the staged
 *  in-turn copy (so a card mounted this same turn can be patched without
 *  depending on DB persistence timing); otherwise reads the latest persisted
 *  version. Either way it returns an `artifactUpdate` so the visible card is
 *  patched in place. `merge` must set its field and, for the smart fields,
 *  clear its own `pending` entry. */
function applyWeatherFieldUpdate(opts: {
    conversationId: string
    identifier: string
    toolLabel: string
    field: 'outfit' | 'why' | 'calendarContext'
    merge: (base: WeatherArtifact) => WeatherArtifact
}): ToolResult {
    const { conversationId, identifier, toolLabel, field, merge } = opts

    const validate = (enriched: WeatherArtifact) => {
        const parsed = WeatherArtifactSchema.safeParse(enriched)
        if (!parsed.success) {
            const first = parsed.error.issues[0]
            const path = first.path.length ? first.path.join('.') : '(root)'
            return { ok: false as const, error: `${toolLabel} validation failed at ${path}: ${first.message}` }
        }
        return { ok: true as const, value: parsed.data }
    }

    const staged = readPendingWeatherArtifact(conversationId, identifier)
    if (staged) {
        const result = validate(merge(staged.artifact))
        if (!result.ok) return { success: false, error: result.error }
        const nextEntry: PendingWeatherArtifact = { ...staged, artifact: result.value, createdAt: Date.now() }
        // Keep the staged copy alive for further in-turn merges until both
        // smart fields have landed; drop it once nothing is pending.
        if (result.value.pending?.length) updatePendingWeatherArtifact(nextEntry, result.value)
        else clearPendingWeatherArtifact(staged)
        return {
            success: true,
            data: weatherArtifactUpdateData({
                identifier,
                title: staged.title,
                display: staged.display,
                artifact: result.value,
                field,
            }),
        }
    }

    const read = readLatestWeatherArtifact(conversationId, identifier)
    if (!read.ok) return { success: false, error: read.error }
    const result = validate(merge(read.artifact))
    if (!result.ok) return { success: false, error: result.error }
    return {
        success: true,
        data: weatherArtifactUpdateData({
            identifier,
            title: read.latest.title,
            display: normalizeWeatherDisplay(read.latest.display),
            artifact: result.value,
            field,
        }),
    }
}

async function assembleSuccess(args: AssembleArgs): Promise<ToolResult> {
    const location: WeatherLocation = {
        name: args.resolved.name,
        region: args.resolved.region,
        country: args.resolved.country,
        coordinates: [args.lng, args.lat],
        timezone: args.result.timezone ?? args.resolved.timezone ?? 'UTC',
    }
    const baseArtifact: WeatherArtifact = {
        location,
        units: args.units,
        fetchedAt: new Date().toISOString(),
        provider: args.providerUsed,
        current: args.result.current,
        hourly: args.result.hourly,
        daily: args.result.daily,
        ...(args.result.airQuality ? { airQuality: args.result.airQuality } : {}),
        ...(args.attribution ? { attribution: args.attribution } : {}),
    }
    const artifact = await enrichWeatherArtifact(baseArtifact, args.enrichmentOptions)

    const parsed = WeatherArtifactSchema.safeParse(artifact)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `WeatherShow validation failed at ${path}: ${first.message}` }
    }

    const identifier = args.identifierArg || `${slugifyLocation(args.resolved.name)}-weather`
    const title = args.titleArg || `Weather in ${args.resolved.name}`

    // Smart path: mount the live forecast INSTANTLY via `directEmit` with the
    // Outfit + Why tiles flagged `pending` so the renderer shows a "Working…"
    // placeholder at the final tile footprint. We also stage the card in-memory
    // so the in-turn WeatherSetWhy/WeatherSetOutfit calls can merge their field
    // and patch the already-visible card in place (no second card, no reflow).
    if (args.smartGuidance && args.conversationId) {
        const stagedCandidate: WeatherArtifact = { ...parsed.data, pending: ['why', 'outfit'] }
        const stagedParsed = WeatherArtifactSchema.safeParse(stagedCandidate)
        const stagedArtifact = stagedParsed.success ? stagedParsed.data : stagedCandidate
        stagePendingWeatherArtifact({
            conversationId: args.conversationId,
            identifier,
            title,
            display: 'inline',
            artifact: stagedArtifact,
            providerUsed: args.providerUsed,
            googleAvailable: args.googleAvailable,
            createdAt: Date.now(),
            targetDate: args.targetDate,
        })
        return {
            success: true,
            data: {
                directEmit: true,
                identifier,
                title,
                type: 'application/vnd.ant.weather',
                display: 'inline',
                body: JSON.stringify(stagedArtifact),
                modelContext: buildWeatherModelContext(stagedArtifact, args.targetDate),
                providerUsed: args.providerUsed,
                googleAvailable: args.googleAvailable,
                suggestGoogleUpgrade: args.providerUsed === 'open-meteo' && !args.googleAvailable,
                nextStepUsage: weatherRefinementUsage(identifier),
                usage: `Card is ALREADY visible — do NOT emit an <artifact> tag. Its Outfit and "Why it feels this way" tiles show a "Working…" placeholder. Fill them by calling WeatherSetWhy then WeatherSetOutfit with identifier "${identifier}"; each one slots into the live card in place. ${weatherRefinementUsage(identifier)} No closing chat message is required — completing the two tiles is the deliverable.`,
            },
        }
    }

    // Base path: smart guidance disabled (or no conversation context, e.g. the
    // refresh route) — mount the live forecast with no placeholders. The
    // `directEmit` body is also what the refresh route reads back directly.
    const body = JSON.stringify(parsed.data)
    return {
        success: true,
        data: {
            directEmit: true,
            identifier,
            title,
            type: 'application/vnd.ant.weather',
            display: 'inline',
            body,
            modelContext: buildWeatherModelContext(parsed.data, args.targetDate),
            providerUsed: args.providerUsed,
            googleAvailable: args.googleAvailable,
            suggestGoogleUpgrade: args.providerUsed === 'open-meteo' && !args.googleAvailable,
            usage: `Card mounted automatically — do NOT emit an <artifact> tag. Smart guidance is off, so no WeatherSetWhy/WeatherSetOutfit calls are needed. No closing message is required.`,
        },
    }
}

function buildWeatherModelContext(artifact: WeatherArtifact, targetDate?: string): Record<string, unknown> {
    const current = artifact.current
    const next12 = nextForecastHours(artifact, 12)
    const next24 = nextForecastHours(artifact, 24)
    const localNow = localTimeContext(artifact.fetchedAt, artifact.location.timezone)
    const rain12 = Math.max(
        current.precipitationProbability ?? 0,
        ...next12.map(hour => hour.precipitationProbability),
    )
    const rain24 = Math.max(
        current.precipitationProbability ?? 0,
        ...next24.map(hour => hour.precipitationProbability),
    )
    const tempUnit = artifact.units === 'metric' ? 'C' : 'F'
    const windUnit = artifact.units === 'metric' ? 'm/s' : 'mph'

    const daily = artifact.daily.slice(0, 5).map(compactDailyForModel)
    const targetDay = targetDate
        ? artifact.daily.find(day => day.date === targetDate)
        : undefined
    return {
        location: artifact.location.name,
        timezone: artifact.location.timezone,
        units: artifact.units,
        ...(targetDate ? {
            targetDate,
            targetDay: targetDay ? compactDailyForModel(targetDay) : null,
        } : {}),
        localTime: localNow,
        now: {
            temperature: Math.round(current.temperature),
            feelsLike: Math.round(current.feelsLike),
            tempUnit,
            condition: current.conditionLabel,
            isDay: current.isDay,
            precipitationProbability: current.precipitationProbability ?? null,
            windSpeed: Math.round(current.windSpeed),
            windUnit,
            humidity: Math.round(current.humidity),
            uvIndex: Math.round(current.uvIndex),
            airQuality: artifact.airQuality
                ? { aqi: Math.round(artifact.airQuality.aqi), label: artifact.airQuality.aqiLabel }
                : null,
        },
        next12h: {
            maxPrecipitationProbability: Math.round(rain12),
            windSpeed: Math.round(current.windSpeed),
            windUnit,
        },
        next24h: {
            maxPrecipitationProbability: Math.round(rain24),
        },
        alerts: artifact.alerts?.map(alert => ({
            kind: alert.kind,
            severity: alert.severity,
            title: alert.title,
            summary: alert.summary,
        })) ?? [],
        why: artifact.why?.map(row => ({
            kind: row.kind,
            title: row.title,
            value: row.value,
            explanation: row.explanation,
        })) ?? [],
        historical: artifact.historical ? {
            targetDate: artifact.historical.targetDate,
            sampleYears: artifact.historical.sampleYears,
            temperatureHigh: artifact.historical.temperatureHigh ?? null,
            precipitation: artifact.historical.precipitation ?? null,
            summary: artifact.historical.summary,
        } : null,
        pollen: artifact.pollen ? {
            primary: artifact.pollen.primary ?? null,
            summary: artifact.pollen.summary,
        } : null,
        daily,
        proseGuidance: [
            'Use this compact weather context to write any outfit/clothing suggestion yourself.',
            'Keep it short and practical; mention umbrella/jacket/sun protection only when the numbers justify it.',
            'Respect localTime. If it is night or early morning, separate what is useful right now from what matters later today; do not present midday UV as a current condition.',
        ],
    }
}

function compactDailyForModel(day: WeatherArtifact['daily'][number]): Record<string, unknown> {
    return {
        date: day.date,
        condition: day.conditionLabel,
        low: Math.round(day.temperatureLow),
        high: Math.round(day.temperatureHigh),
        precipitationProbability: Math.round(day.precipitationProbability),
        uvIndexMax: Math.round(day.uvIndexMax),
    }
}

function weatherRefinementUsage(identifier: string): string {
    return `Use WeatherSetWhy arguments {"identifier":"${identifier}","rows":[{"kind":"precipitation","title":"Rain chance","value":"45%","explanation":"One grounded sentence from modelContext.","severity":"caution"}]} and WeatherSetOutfit arguments {"identifier":"${identifier}","headline":"Short practical headline","summary":"One grounded sentence","items":["26 C high","45% rain"]}. If direct schemas are not visible, run both via RunActivatedIntegrationTool.`
}

function localTimeContext(iso: string, timezone: string): Record<string, unknown> {
    const ms = Date.parse(iso)
    const date = Number.isFinite(ms) ? new Date(ms) : new Date()
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        weekday: 'short',
    }).formatToParts(date)
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    const hour = Number(get('hour'))
    const minute = Number(get('minute'))
    const dateText = `${get('year')}-${get('month')}-${get('day')}`
    const timeText = `${get('hour')}:${get('minute')}`
    return {
        timezone,
        date: dateText,
        time: timeText,
        weekday: get('weekday'),
        hour: Number.isFinite(hour) ? hour : null,
        minute: Number.isFinite(minute) ? minute : null,
        isNight: Number.isFinite(hour) ? hour < 6 || hour >= 21 : null,
    }
}

function nextForecastHours(artifact: WeatherArtifact, count: number): WeatherArtifact['hourly'] {
    const fetchedMs = Date.parse(artifact.fetchedAt)
    if (!Number.isFinite(fetchedMs)) return artifact.hourly.slice(0, count)
    return artifact.hourly
        .filter(hour => {
            const ms = hourMs(hour.time)
            return Number.isFinite(ms) && ms >= fetchedMs - 60 * 60 * 1000
        })
        .slice(0, count)
}

function hourMs(iso: string): number {
    if (!iso) return Number.NaN
    return Date.parse(hasExplicitTimezone(iso) ? iso : `${iso}Z`)
}

function hasExplicitTimezone(iso: string): boolean {
    return /(?:Z|[+\-]\d\d:?\d\d)$/i.test(iso)
}

type ArtifactVersionRow = ReturnType<typeof listVersionsForIdentifier>[number]

function readLatestWeatherArtifact(
    conversationId: string,
    identifier: string,
): { ok: true; artifact: WeatherArtifact; latest: ArtifactVersionRow } | { ok: false; error: string } {
    const versions = listVersionsForIdentifier(conversationId, identifier)
    const latest = [...versions].reverse().find(row => row.type === 'application/vnd.ant.weather')
    if (!latest) {
        return {
            ok: false,
            error: `No weather artifact "${identifier}" found in this conversation. Call WeatherShow first.`,
        }
    }

    let current: unknown
    try {
        current = JSON.parse(latest.content)
    } catch (e) {
        return { ok: false, error: `Weather artifact JSON is invalid: ${(e as Error).message}` }
    }

    const existing = WeatherArtifactSchema.safeParse(current)
    if (!existing.success) {
        const first = existing.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `Existing weather artifact is invalid at ${path}: ${first.message}` }
    }
    return { ok: true, artifact: existing.data, latest }
}

export async function executeWeatherSetOutfit(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
        return { success: false, error: 'WeatherSetOutfit requires conversation context.' }
    }

    const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : ''
    if (!identifier) {
        return { success: false, error: 'WeatherSetOutfit requires the WeatherShow identifier.' }
    }
    if (!KEBAB_RE.test(identifier)) {
        return { success: false, error: `WeatherSetOutfit identifier "${identifier}" must be kebab-case.` }
    }

    const headline = cleanOutfitText(args.headline, 70)
    const summary = cleanOutfitText(args.summary, 240)
    const items = cleanOutfitItems(args.items)
    if (!headline || !summary) {
        return { success: false, error: 'WeatherSetOutfit requires non-empty headline and summary.' }
    }

    return applyWeatherFieldUpdate({
        conversationId,
        identifier,
        toolLabel: 'WeatherSetOutfit',
        field: 'outfit',
        merge: (base) => ({
            ...base,
            outfit: {
                source: 'model',
                generatedAt: new Date().toISOString(),
                headline,
                summary,
                ...(items.length > 0 ? { items } : {}),
            },
            pending: clearPendingField(base.pending, 'outfit'),
        }),
    })
}

export async function executeWeatherSetWhy(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
        return { success: false, error: 'WeatherSetWhy requires conversation context.' }
    }

    const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : ''
    if (!identifier) {
        return { success: false, error: 'WeatherSetWhy requires the WeatherShow identifier.' }
    }
    if (!KEBAB_RE.test(identifier)) {
        return { success: false, error: `WeatherSetWhy identifier "${identifier}" must be kebab-case.` }
    }

    const rows = cleanWhyRows(args.rows ?? args.why ?? args.items)
    if (rows.length === 0) {
        return { success: false, error: 'WeatherSetWhy requires at least one valid row.' }
    }

    return applyWeatherFieldUpdate({
        conversationId,
        identifier,
        toolLabel: 'WeatherSetWhy',
        field: 'why',
        merge: (base) => ({
            ...base,
            why: rows,
            pending: clearPendingField(base.pending, 'why'),
        }),
    })
}

export async function executeWeatherSetCalendarContext(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
        return { success: false, error: 'WeatherSetCalendarContext requires conversation context.' }
    }

    const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : ''
    if (!identifier) {
        return { success: false, error: 'WeatherSetCalendarContext requires the WeatherShow identifier.' }
    }
    if (!KEBAB_RE.test(identifier)) {
        return { success: false, error: `WeatherSetCalendarContext identifier "${identifier}" must be kebab-case.` }
    }

    const events = cleanCalendarContext(args.events)
    if (events.length === 0) {
        return { success: false, error: 'WeatherSetCalendarContext requires at least one valid event with title and startTime.' }
    }

    // Calendar context is not a smart-guidance placeholder, so it leaves
    // `pending` untouched — it simply patches the visible card with the
    // event-weather row.
    return applyWeatherFieldUpdate({
        conversationId,
        identifier,
        toolLabel: 'WeatherSetCalendarContext',
        field: 'calendarContext',
        merge: (base) => ({ ...base, calendarContext: events }),
    })
}

function cleanOutfitText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return ''
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function cleanOutfitItems(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of value) {
        const item = cleanOutfitText(raw, 36)
        if (!item || seen.has(item)) continue
        seen.add(item)
        out.push(item)
        if (out.length >= 5) break
    }
    return out
}

function cleanWhyRows(value: unknown): WeatherWhy[] {
    if (!Array.isArray(value)) return []
    const kinds = new Set<WeatherWhy['kind']>([
        'feels_like',
        'humidity',
        'wind',
        'uv',
        'air_quality',
        'pressure',
        'precipitation',
    ])
    const severities = new Set<WeatherWhy['severity']>(['neutral', 'useful', 'caution'])
    const out: WeatherWhy[] = []
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const item = raw as Record<string, unknown>
        const kind = typeof item.kind === 'string' && kinds.has(item.kind as WeatherWhy['kind'])
            ? item.kind as WeatherWhy['kind']
            : inferWeatherWhyKind(item)
        const title = cleanOutfitText(item.title, 70)
            || cleanOutfitText(item.label, 70)
            || fallbackWeatherWhyTitle(kind)
        const explanation = cleanOutfitText(item.explanation, 180)
            || cleanOutfitText(item.body, 180)
            || cleanOutfitText(item.text, 180)
            || cleanOutfitText(item.summary, 180)
            || cleanOutfitText(item.value, 180)
        const rowValue = cleanOutfitText(item.value, 40)
            || cleanOutfitText(item.metric, 40)
            || cleanOutfitText(item.label, 40)
            || cleanOutfitText(item.title, 40)
        if (!kind || !title || !rowValue || !explanation) continue
        const severity = typeof item.severity === 'string' && severities.has(item.severity as WeatherWhy['severity'])
            ? item.severity as WeatherWhy['severity']
            : 'neutral'
        out.push({
            source: 'model',
            kind,
            title,
            value: rowValue,
            explanation,
            severity,
        })
        if (out.length >= 5) break
    }
    return out
}

function inferWeatherWhyKind(item: Record<string, unknown>): WeatherWhy['kind'] {
    const haystack = [
        item.title,
        item.label,
        item.value,
        item.explanation,
        item.body,
        item.text,
        item.summary,
    ]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
    if (/rain|ploaie|precip|umbrela|snow|ninsoare|storm|furtuna/.test(haystack)) return 'precipitation'
    if (/\buv\b|solar|soare|sun/.test(haystack)) return 'uv'
    if (/wind|vant|vint|gust/.test(haystack)) return 'wind'
    if (/humid|umid|dew/.test(haystack)) return 'humidity'
    if (/air|aer|aqi|pollen|polen|pollut|polu/.test(haystack)) return 'air_quality'
    if (/pressure|presiune|hpa|mbar/.test(haystack)) return 'pressure'
    return 'feels_like'
}

function fallbackWeatherWhyTitle(kind: WeatherWhy['kind']): string {
    switch (kind) {
        case 'precipitation': return 'Precipitation'
        case 'uv': return 'UV'
        case 'wind': return 'Wind'
        case 'humidity': return 'Humidity'
        case 'air_quality': return 'Air quality'
        case 'pressure': return 'Pressure'
        case 'feels_like':
        default:
            return 'Feels like'
    }
}

function cleanCalendarContext(value: unknown): WeatherCalendarContext[] {
    if (!Array.isArray(value)) return []
    const out: WeatherCalendarContext[] = []
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const item = raw as Record<string, unknown>
        const title = cleanOutfitText(item.title, 120)
        const startTime = cleanOutfitText(item.startTime, 40)
        if (!title || !startTime) continue
        const event: WeatherCalendarContext = {
            title,
            startTime,
            ...(cleanOutfitText(item.endTime, 40) ? { endTime: cleanOutfitText(item.endTime, 40) } : {}),
            ...(cleanOutfitText(item.locationName, 120) ? { locationName: cleanOutfitText(item.locationName, 120) } : {}),
            ...(cleanOutfitText(item.conditionLabel, 80) ? { conditionLabel: cleanOutfitText(item.conditionLabel, 80) } : {}),
            ...(typeof item.temperature === 'number' && Number.isFinite(item.temperature) ? { temperature: item.temperature } : {}),
            ...(typeof item.precipitationProbability === 'number' && Number.isFinite(item.precipitationProbability)
                ? { precipitationProbability: Math.max(0, Math.min(100, item.precipitationProbability)) }
                : {}),
            ...(cleanOutfitText(item.note, 180) ? { note: cleanOutfitText(item.note, 180) } : {}),
        }
        out.push(event)
        if (out.length >= 5) break
    }
    return out
}

// ---------------------------------------------------------------------------
// WeatherStatus — multi-provider readiness probe.
// ---------------------------------------------------------------------------

export const WEATHER_STATUS_TOOL_ID = 'WeatherStatus'

export const weatherStatusTool: ToolDef = {
    id: WEATHER_STATUS_TOOL_ID,
    name: WEATHER_STATUS_TOOL_ID,
    description: [
        'Report weather provider readiness. Returns Google Weather configured/connected state AND Open-Meteo availability.',
        'Open-Meteo is keyless and always available unless the network is down — its `available: true` means weather always works for anyone, regardless of GCP setup.',
        'When Google is not connected but Open-Meteo is, forecasts still render — just with synthesized condition descriptions plus keyless AQ/pollen fallback instead of Google Weather/Air Quality/Pollen.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            refresh: { type: 'boolean', description: 'Skip 5-minute probe cache.' },
        },
    },
    tags: ['weather'],
}

export async function executeWeatherStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const refresh = args.refresh === true
    try {
        const status = await getWeatherIntegrationStatus(!refresh)
        return {
            success: true,
            data: {
                google: {
                    configured: status.google.configured,
                    connected: status.google.connected,
                    needsReconnect: status.google.needsReconnect,
                    keyEnvVar: 'GOOGLE_MAPS_API_KEY',
                    error: status.google.error,
                },
                openMeteo: {
                    available: status.openMeteo.available,
                    error: status.openMeteo.error,
                },
                anyProviderReady: status.anyProviderReady,
                providerInUse: status.providerInUse,
            },
        }
    } catch (e) {
        return { success: false, error: (e as Error).message }
    }
}
