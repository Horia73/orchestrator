import { evaluateRule, type WeatherCandidate } from '../rules'
import type { MonitorRule, MonitorWatch, WatchState } from '../schema'
import { openMeteoProvider, WEATHER_PROVIDER_CHAIN, type WeatherProviderClient } from '@/lib/weather/providers'
import type { WeatherFetchResult, WeatherGeocodeHit } from '@/lib/weather/providers/types'
import { extractWeatherLocationsFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type SourceAdapter,
} from './types'

const DEFAULT_WINDOW_HOURS = 12
const MAX_WINDOW_HOURS = 48

interface WeatherExtraState {
    lastMatched?: boolean
    lastFetchedAt?: number
}

interface ResolvedWeatherLocation {
    query: string
    name: string
    coordinates: [number, number]
    timezone: string | null
}

export const weatherSourceAdapter: SourceAdapter = {
    source: 'weather',
    supportedRuleKinds: [
        'weather_precip_probability',
        'weather_temperature',
        'weather_wind',
        'weather_uv',
        'weather_aqi',
        'weather_condition',
    ],
    supportedActionKinds: ['notify_inbox'],

    async isAvailable(): Promise<AvailabilityResult> {
        const unavailable: string[] = []
        for (const provider of WEATHER_PROVIDER_CHAIN) {
            try {
                const status = await provider.isAvailable()
                if (status.available) return { available: true }
                unavailable.push(`${provider.name}: ${status.reason ?? 'unavailable'}`)
            } catch (err) {
                unavailable.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
        return {
            available: false,
            reason: unavailable.length ? unavailable.join('; ') : 'No weather provider is available.',
        }
    },

    async cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('weather cheap-check', async () => {
            const locations = weatherLocationsForWatch(input.watch)
            const windowHours = weatherWindowHours(input.watch.rule)
            const extra = { ...(input.watch.state.extra ?? {}) } as Record<string, unknown>
            const matches: MatchedCandidate[] = []
            let candidatesSeen = 0
            const errors: string[] = []

            for (const location of locations) {
                const result = await checkOneLocation(input.watch, location, windowHours, input.now, input.timeoutMs, extra)
                candidatesSeen += result.candidatesSeen
                matches.push(...result.matches)
                Object.assign(extra, result.extraPatch)
                if (result.error) errors.push(result.error)
            }

            return {
                ok: errors.length === 0,
                error: errors.length ? errors.join('; ') : undefined,
                matches,
                candidatesSeen,
                stateUpdate: { extra },
                fetchedAt: input.now,
            }
        })
    },
}

async function checkOneLocation(
    watch: MonitorWatch,
    locationQuery: string,
    windowHours: number,
    now: number,
    timeoutMs: number,
    accumulatedExtra: Record<string, unknown>,
): Promise<{
    matches: MatchedCandidate[]
    candidatesSeen: number
    extraPatch: Record<string, unknown>
    error?: string
}> {
    const provider = await firstAvailableProvider()
    if (!provider) {
        return {
            matches: [],
            candidatesSeen: 0,
            extraPatch: {},
            error: 'No weather provider is available.',
        }
    }

    const location = await resolveLocation(provider, locationQuery)
    if (!location) {
        return {
            matches: [],
            candidatesSeen: 0,
            extraPatch: {},
            error: `Could not resolve weather location "${locationQuery}".`,
        }
    }

    const forecast = await withTimeout(
        provider.fetchWeather({
            lat: location.coordinates[1],
            lng: location.coordinates[0],
            units: 'metric',
            days: 1,
            hours: windowHours,
            includeAirQuality: true,
        }),
        timeoutMs,
        `weather fetch ${locationQuery}`,
    )

    const candidate = buildCandidate(location, forecast, windowHours, now)
    const matched = evaluateRule(watch.rule, candidate)
    const key = `weather::${location.query}`
    const previous = readPrevious({ ...watch.state, extra: accumulatedExtra }, key)
    const extraPatch = {
        [key]: {
            lastMatched: matched,
            lastFetchedAt: now,
        } satisfies WeatherExtraState,
    }

    if (!matched || previous.lastMatched === true) {
        return { matches: [], candidatesSeen: 1, extraPatch }
    }

    return {
        matches: [
            {
                candidate,
                summary: `${candidate.location}: ${candidate.currentCondition}, ${Math.round(candidate.currentTemperature)}°`,
                externalId: `${location.query}@${now}`,
                details: {
                    location: candidate.location,
                    timezone: candidate.timezone,
                    currentTemperature: candidate.currentTemperature,
                    feelsLike: candidate.feelsLike,
                    highTemperature: candidate.highTemperature,
                    lowTemperature: candidate.lowTemperature,
                    maxPrecipProbability: candidate.maxPrecipProbability,
                    maxUvIndex: candidate.maxUvIndex,
                    windSpeed: candidate.windSpeed,
                    windGust: candidate.windGust,
                    aqi: candidate.aqi,
                    conditions: candidate.conditions,
                    windowHours,
                },
            },
        ],
        candidatesSeen: 1,
        extraPatch,
    }
}

async function firstAvailableProvider(): Promise<WeatherProviderClient | null> {
    for (const provider of WEATHER_PROVIDER_CHAIN) {
        try {
            const status = await provider.isAvailable()
            if (status.available) return provider
        } catch {
            // Try the next provider.
        }
    }
    return null
}

async function resolveLocation(
    provider: WeatherProviderClient,
    query: string,
): Promise<ResolvedWeatherLocation | null> {
    const coordinate = parseLatLng(query)
    if (coordinate) {
        return {
            query,
            name: query,
            coordinates: coordinate,
            timezone: null,
        }
    }

    const geocoders = provider.geocode
        ? [provider]
        : [openMeteoProvider]

    for (const geocoder of geocoders) {
        if (!geocoder.geocode) continue
        const hit = await geocoder.geocode(query)
        if (!hit) continue
        return {
            query,
            name: displayLocation(hit),
            coordinates: hit.coordinates,
            timezone: hit.timezone ?? null,
        }
    }
    return null
}

function buildCandidate(
    location: ResolvedWeatherLocation,
    forecast: WeatherFetchResult,
    windowHours: number,
    now: number,
): WeatherCandidate {
    const hourlyWindow = forecast.hourly.slice(0, windowHours)
    const today = forecast.daily[0]
    const precipitationValues = [
        forecast.current.precipitationProbability ?? 0,
        ...hourlyWindow.map((hour) => hour.precipitationProbability),
        today?.precipitationProbability ?? 0,
    ]
    const uvValues = [
        forecast.current.uvIndex,
        ...hourlyWindow.map((hour) => hour.uvIndex ?? 0),
        today?.uvIndexMax ?? 0,
    ]
    const conditions = uniqueStrings([
        forecast.current.condition,
        ...hourlyWindow.map((hour) => hour.condition),
        ...(today ? [today.condition] : []),
    ])

    return {
        source: 'weather',
        location: location.name,
        timezone: forecast.timezone ?? location.timezone ?? 'UTC',
        fetchedAt: now,
        currentTemperature: forecast.current.temperature,
        feelsLike: forecast.current.feelsLike,
        highTemperature: today?.temperatureHigh ?? forecast.current.temperature,
        lowTemperature: today?.temperatureLow ?? forecast.current.temperature,
        maxPrecipProbability: Math.max(...precipitationValues),
        maxUvIndex: Math.max(...uvValues),
        windSpeed: forecast.current.windSpeed,
        windGust: forecast.current.windGust ?? today?.windGustMax ?? null,
        aqi: forecast.airQuality?.aqi ?? null,
        currentCondition: forecast.current.condition,
        conditions,
        windowHours,
    }
}

function weatherLocationsForWatch(watch: MonitorWatch): string[] {
    const fromRule = extractWeatherLocationsFromRule(watch.rule)
    const locations = fromRule.length ? fromRule : [watch.target]
    return uniqueStrings(locations.map((location) => location.trim()).filter(Boolean))
}

function weatherWindowHours(rule: MonitorRule): number {
    let max = DEFAULT_WINDOW_HOURS
    walkWeatherRules(rule, (leaf) => {
        if (
            leaf.kind === 'weather_precip_probability' ||
            leaf.kind === 'weather_uv' ||
            leaf.kind === 'weather_condition'
        ) {
            max = Math.max(max, leaf.windowHours ?? DEFAULT_WINDOW_HOURS)
        }
    })
    return Math.min(Math.max(Math.floor(max), 1), MAX_WINDOW_HOURS)
}

function walkWeatherRules(rule: MonitorRule, visit: (leaf: MonitorRule) => void): void {
    if (rule.kind === 'any_of' || rule.kind === 'all_of') {
        for (const child of rule.rules) walkWeatherRules(child, visit)
        return
    }
    visit(rule)
}

function readPrevious(state: WatchState, key: string): WeatherExtraState {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as WeatherExtraState
}

function parseLatLng(value: string): [number, number] | null {
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
    if (!match) return null
    const lat = Number(match[1])
    const lng = Number(match[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
}

function displayLocation(hit: WeatherGeocodeHit): string {
    return [hit.name, hit.region, hit.country].filter(Boolean).join(', ')
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values)]
}
