import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { listVersionsForIdentifier } from '@/lib/artifacts/store'
import {
    geocodeAddresses,
    reverseGeocode,
    type NormalizedAddressComponent,
} from '@/lib/maps/google-geocoding'
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
        'In normal chat turns, success stages the card invisibly and returns { pendingArtifact, identifier, title, modelContext, providerUsed, googleAvailable, suggestGoogleUpgrade }; do not emit an artifact tag.',
        'Use `modelContext` to generate WeatherSetWhy and WeatherSetOutfit. Once both are present, the second tool mounts the complete card automatically.',
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
            languageCode: { type: 'string', description: 'BCP-47 ("en", "ro", "fr"). Default "en".' },
            identifier: { type: 'string', description: 'Stable kebab-case handle. Reuse to refresh the same location.' },
            title: { type: 'string', description: 'Defaults to "Weather in <resolved name>".' },
            attribution: { type: 'string', description: 'Optional short suffix on the attribution line.' },
            includeAirQuality: { type: 'boolean', description: 'Defaults to true. Set false to skip the AQ fetch (cheaper, slightly faster).' },
            includeAlerts: { type: 'boolean', description: 'Defaults to true. Adds forecast-derived heads-up banners for rain, wind, UV, AQI, heat/cold, fog, or storms.' },
            includeHistorical: { type: 'boolean', description: 'Defaults to true. Adds same-date comparison from Open-Meteo archive when available.' },
            includePollen: { type: 'boolean', description: 'Defaults to true. Adds Open-Meteo pollen signal when available (Europe/seasonal).' },
            includeRadar: { type: 'boolean', description: 'Defaults to true. Adds latest RainViewer radar widget URL when available.' },
            deferDisplay: { type: 'boolean', description: 'Defaults to true in chat turns: stage the weather card invisibly until WeatherSetWhy and WeatherSetOutfit both complete. Set false only when the user explicitly does not want smart guidance/outfit.' },
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
        'Attach model-generated outfit guidance to the latest WeatherShow artifact in this conversation.',
        'Call this after WeatherShow returns `modelContext` and before final prose when a weather card should include clothing guidance.',
        'If WeatherShow staged a hidden card, this writes `outfit` into that staged data; when `why` is also present, it mounts the complete card once. For existing visible cards, it updates the same card. Do not emit an artifact tag yourself.',
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
        'Attach model-generated "Why it feels this way" rows to the latest WeatherShow artifact in this conversation.',
        'Call this after WeatherShow returns `modelContext` when the card should explain comfort drivers.',
        'Use localTime from modelContext: at night, explain current comfort and only mention UV as a later daytime factor if useful.',
        'If WeatherShow staged a hidden card, this writes `why` into that staged data; when `outfit` is also present, it mounts the complete card once. For existing visible cards, it updates the same card. Do not emit an artifact tag yourself.',
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

function cleanAddressPart(part: string): string {
    return part
        .replace(/^\d{3,}(?:[-\s]\d+)?\s+/, '')
        .replace(/\s+\d{3,}(?:[-\s]\d+)?(?:\s.*)?$/, '')
        .trim()
}

function splitFormattedAddress(formatted: string): { region?: string; country?: string } {
    const parts = formatted.split(',').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) return {}
    const country = parts[parts.length - 1]
    const region = parts.length >= 2 ? cleanAddressPart(parts[parts.length - 2]) : undefined
    return { region, country }
}

function pickShortName(formatted: string, fallback: string): string {
    const parts = formatted.split(',').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) return fallback
    if (parts.length >= 3) {
        const candidate = cleanAddressPart(parts[parts.length - 2])
        if (/^[A-Z]{2,3}$/.test(candidate) && parts.length >= 4) {
            return cleanAddressPart(parts[parts.length - 3]) || fallback
        }
        return candidate || fallback
    }
    return cleanAddressPart(parts[0]) || fallback
}

function findAddressComponent(
    components: NormalizedAddressComponent[] | undefined,
    types: string[],
): NormalizedAddressComponent | undefined {
    if (!components?.length) return undefined
    for (const type of types) {
        const component = components.find(candidate => candidate.types.includes(type))
        if (component) return component
    }
    return undefined
}

function pickLocalityName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, [
        'locality',
        'postal_town',
        'administrative_area_level_3',
        'administrative_area_level_2',
    ])?.longName
}

function pickRegionName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, [
        'administrative_area_level_1',
        'administrative_area_level_2',
    ])?.longName
}

function pickCountryName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, ['country'])?.longName
}

function coordinateLabel(lat: number, lng: number): string {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
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
    const days = typeof args.days === 'number' && Number.isFinite(args.days)
        ? Math.max(1, Math.min(10, Math.floor(args.days))) : 5
    // Default hours scale with days so the daily-row "expand to see hourly"
    // gesture has data for every day. Some models still pass hours: 24 for a
    // 3-day card because the top strip says "next 24h"; treat days * 24 as
    // the minimum effective horizon so lower rows do not look broken.
    const hours = effectiveWeatherHours(days, args.hours)
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
                    deferDisplay: shouldDeferWeatherDisplay(args, ctx),
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
        deferDisplay: shouldDeferWeatherDisplay(args, ctx),
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
    deferDisplay?: boolean
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
}

const pendingWeatherArtifacts = new Map<string, PendingWeatherArtifact>()
const PENDING_WEATHER_TTL_MS = 10 * 60 * 1000

function shouldDeferWeatherDisplay(args: Record<string, unknown>, ctx?: ToolExecutionContext): boolean {
    if (!ctx?.conversationId) return false
    if (args.deferDisplay === false) return false
    return true
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

function hasRequiredSmartWeather(entry: PendingWeatherArtifact): boolean {
    return Boolean(entry.artifact.outfit && entry.artifact.why?.length)
}

function pendingWeatherWaitingFor(entry: PendingWeatherArtifact): string[] {
    const waiting: string[] = []
    if (!entry.artifact.why?.length) waiting.push('WeatherSetWhy')
    if (!entry.artifact.outfit) waiting.push('WeatherSetOutfit')
    return waiting
}

function weatherDirectEmitData(entry: PendingWeatherArtifact): Record<string, unknown> {
    clearPendingWeatherArtifact(entry)
    return {
        directEmit: true,
        identifier: entry.identifier,
        title: entry.title,
        type: 'application/vnd.ant.weather',
        display: entry.display,
        body: JSON.stringify(entry.artifact),
        modelContext: buildWeatherModelContext(entry.artifact),
        providerUsed: entry.providerUsed,
        googleAvailable: entry.googleAvailable,
        suggestGoogleUpgrade: entry.providerUsed === 'open-meteo' && !entry.googleAvailable,
        note: 'Weather artifact is complete and mounted once. Do not emit an artifact tag.',
    }
}

function pendingWeatherResult(entry: PendingWeatherArtifact, updated: string, extra: Record<string, unknown> = {}): ToolResult {
    const waitingFor = pendingWeatherWaitingFor(entry)
    return {
        success: true,
        data: {
            pendingArtifact: true,
            mounted: false,
            identifier: entry.identifier,
            title: entry.title,
            updated,
            waitingFor,
            ...extra,
            note: waitingFor.length
                ? `Weather artifact is still hidden until ${waitingFor.join(' and ')} completes.`
                : 'Weather artifact is ready to mount.',
        },
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
    const body = JSON.stringify(parsed.data)

    if (args.deferDisplay && args.conversationId) {
        stagePendingWeatherArtifact({
            conversationId: args.conversationId,
            identifier,
            title,
            display: 'inline',
            artifact: parsed.data,
            providerUsed: args.providerUsed,
            googleAvailable: args.googleAvailable,
            createdAt: Date.now(),
        })
        return {
            success: true,
            data: {
                pendingArtifact: true,
                mounted: false,
                identifier,
                title,
                type: 'application/vnd.ant.weather',
                display: 'inline',
                modelContext: buildWeatherModelContext(parsed.data),
                providerUsed: args.providerUsed,
                googleAvailable: args.googleAvailable,
                suggestGoogleUpgrade: args.providerUsed === 'open-meteo' && !args.googleAvailable,
                waitingFor: ['WeatherSetWhy', 'WeatherSetOutfit'],
                note: 'Weather data is staged but not mounted yet. Call WeatherSetWhy and WeatherSetOutfit; the card mounts once both are present.',
            },
        }
    }

    return {
        success: true,
        data: {
            // `directEmit: true` tells the chat route to inject the
            // <artifact>BODY</artifact> tag into the assistant message
            // body itself. The parser then mounts the card exactly as if
            // the model wrote the tag — but instantly, and without burning
            // model tokens on JSON.
            directEmit: true,
            identifier,
            title,
            type: 'application/vnd.ant.weather',
            display: 'inline',
            body,
            modelContext: buildWeatherModelContext(parsed.data),
            providerUsed: args.providerUsed,
            googleAvailable: args.googleAvailable,
            suggestGoogleUpgrade: args.providerUsed === 'open-meteo' && !args.googleAvailable,
            usage: `Card mounted automatically — do NOT emit an <artifact> tag. Use modelContext with WeatherSetWhy and WeatherSetOutfit when those smart rows belong in the card, then write 1-2 sentences of framing prose. Identifier "${identifier}".`,
        },
    }
}

function buildWeatherModelContext(artifact: WeatherArtifact): Record<string, unknown> {
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

    return {
        location: artifact.location.name,
        timezone: artifact.location.timezone,
        units: artifact.units,
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
        daily: artifact.daily.slice(0, 5).map(day => ({
            date: day.date,
            condition: day.conditionLabel,
            low: Math.round(day.temperatureLow),
            high: Math.round(day.temperatureHigh),
            precipitationProbability: Math.round(day.precipitationProbability),
            uvIndexMax: Math.round(day.uvIndexMax),
        })),
        proseGuidance: [
            'Use this compact weather context to write any outfit/clothing suggestion yourself.',
            'Keep it short and practical; mention umbrella/jacket/sun protection only when the numbers justify it.',
            'Respect localTime. If it is night or early morning, separate what is useful right now from what matters later today; do not present midday UV as a current condition.',
        ],
    }
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

    const pending = readPendingWeatherArtifact(conversationId, identifier)
    if (pending) {
        const enriched: WeatherArtifact = {
            ...pending.artifact,
            outfit: {
                source: 'model',
                generatedAt: new Date().toISOString(),
                headline,
                summary,
                ...(items.length > 0 ? { items } : {}),
            },
        }

        const parsed = WeatherArtifactSchema.safeParse(enriched)
        if (!parsed.success) {
            const first = parsed.error.issues[0]
            const path = first.path.length ? first.path.join('.') : '(root)'
            return { success: false, error: `WeatherSetOutfit validation failed at ${path}: ${first.message}` }
        }

        const nextPending: PendingWeatherArtifact = {
            ...pending,
            artifact: parsed.data,
            createdAt: Date.now(),
        }
        updatePendingWeatherArtifact(nextPending, parsed.data)
        if (hasRequiredSmartWeather(nextPending)) {
            return {
                success: true,
                data: weatherDirectEmitData(nextPending),
            }
        }
        return pendingWeatherResult(nextPending, 'outfit', { outfit: parsed.data.outfit })
    }

    const read = readLatestWeatherArtifact(conversationId, identifier)
    if (!read.ok) return { success: false, error: read.error }

    const enriched: WeatherArtifact = {
        ...read.artifact,
        outfit: {
            source: 'model',
            generatedAt: new Date().toISOString(),
            headline,
            summary,
            ...(items.length > 0 ? { items } : {}),
        },
    }

    const parsed = WeatherArtifactSchema.safeParse(enriched)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `WeatherSetOutfit validation failed at ${path}: ${first.message}` }
    }

    return {
        success: true,
        data: {
            artifactUpdate: true,
            identifier,
            title: read.latest.title,
            type: 'application/vnd.ant.weather',
            display: read.latest.display ?? 'inline',
            body: JSON.stringify(parsed.data),
            outfit: parsed.data.outfit,
            note: 'Outfit written into weather artifact data. Do not emit another artifact tag.',
        },
    }
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

    const rows = cleanWhyRows(args.rows)
    if (rows.length === 0) {
        return { success: false, error: 'WeatherSetWhy requires at least one valid row.' }
    }

    const pending = readPendingWeatherArtifact(conversationId, identifier)
    if (pending) {
        const enriched: WeatherArtifact = {
            ...pending.artifact,
            why: rows,
        }

        const parsed = WeatherArtifactSchema.safeParse(enriched)
        if (!parsed.success) {
            const first = parsed.error.issues[0]
            const path = first.path.length ? first.path.join('.') : '(root)'
            return { success: false, error: `WeatherSetWhy validation failed at ${path}: ${first.message}` }
        }

        const nextPending: PendingWeatherArtifact = {
            ...pending,
            artifact: parsed.data,
            createdAt: Date.now(),
        }
        updatePendingWeatherArtifact(nextPending, parsed.data)
        if (hasRequiredSmartWeather(nextPending)) {
            return {
                success: true,
                data: weatherDirectEmitData(nextPending),
            }
        }
        return pendingWeatherResult(nextPending, 'why', { why: parsed.data.why })
    }

    const read = readLatestWeatherArtifact(conversationId, identifier)
    if (!read.ok) return { success: false, error: read.error }

    const enriched: WeatherArtifact = {
        ...read.artifact,
        why: rows,
    }

    const parsed = WeatherArtifactSchema.safeParse(enriched)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `WeatherSetWhy validation failed at ${path}: ${first.message}` }
    }

    return {
        success: true,
        data: {
            artifactUpdate: true,
            identifier,
            title: read.latest.title,
            type: 'application/vnd.ant.weather',
            display: read.latest.display ?? 'inline',
            body: JSON.stringify(parsed.data),
            why: parsed.data.why,
            note: 'Why rows written into weather artifact data. Do not emit another artifact tag.',
        },
    }
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

    const pending = readPendingWeatherArtifact(conversationId, identifier)
    if (pending) {
        const enriched: WeatherArtifact = {
            ...pending.artifact,
            calendarContext: events,
        }

        const parsed = WeatherArtifactSchema.safeParse(enriched)
        if (!parsed.success) {
            const first = parsed.error.issues[0]
            const path = first.path.length ? first.path.join('.') : '(root)'
            return { success: false, error: `WeatherSetCalendarContext validation failed at ${path}: ${first.message}` }
        }

        const nextPending: PendingWeatherArtifact = {
            ...pending,
            artifact: parsed.data,
            createdAt: Date.now(),
        }
        updatePendingWeatherArtifact(nextPending, parsed.data)
        if (hasRequiredSmartWeather(nextPending)) {
            return {
                success: true,
                data: weatherDirectEmitData(nextPending),
            }
        }
        return pendingWeatherResult(nextPending, 'calendarContext', { calendarContext: parsed.data.calendarContext })
    }

    const read = readLatestWeatherArtifact(conversationId, identifier)
    if (!read.ok) return { success: false, error: read.error }

    const enriched: WeatherArtifact = {
        ...read.artifact,
        calendarContext: events,
    }

    const parsed = WeatherArtifactSchema.safeParse(enriched)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `WeatherSetCalendarContext validation failed at ${path}: ${first.message}` }
    }

    return {
        success: true,
        data: {
            artifactUpdate: true,
            identifier,
            title: read.latest.title,
            type: 'application/vnd.ant.weather',
            display: read.latest.display ?? 'inline',
            body: JSON.stringify(parsed.data),
            calendarContext: parsed.data.calendarContext,
            note: 'Calendar context written into weather artifact data. Do not emit another artifact tag.',
        },
    }
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
            : null
        const title = cleanOutfitText(item.title, 70)
        const rowValue = cleanOutfitText(item.value, 40)
        const explanation = cleanOutfitText(item.explanation, 180)
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
