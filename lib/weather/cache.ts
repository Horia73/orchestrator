import type { WeatherFetchResult } from './providers/types'
import type { WeatherUnits } from './schema'

// ---------------------------------------------------------------------------
// In-memory weather cache.
//
// Forecasts don't update faster than ~10 minutes upstream; hitting the API
// for every "what's the weather" within a few minutes burns quota and is
// observably slower than serving from memory. Process-local Map keyed on
// the full request shape — coordinates are quantised to ~1km buckets so
// two requests "right next to each other" share a hit.
//
// Bypassed with the `refresh` flag in the tool input.
// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000

interface CacheEntry {
    result: WeatherFetchResult
    provider: 'google' | 'open-meteo'
    at: number
}

const cache = new Map<string, CacheEntry>()

interface CacheKeyArgs {
    lat: number
    lng: number
    units: WeatherUnits
    days: number
    hours: number
    includeAirQuality: boolean
    languageCode: string
}

function cacheKey(args: CacheKeyArgs): string {
    // Bucket to 2 decimal places (~1.1km) — covers neighbouring streets but
    // not different neighbourhoods.
    const lat = Math.round(args.lat * 100) / 100
    const lng = Math.round(args.lng * 100) / 100
    return [
        lat.toFixed(2), lng.toFixed(2),
        args.units, args.days, args.hours,
        args.includeAirQuality ? 'aq' : 'noaq',
        args.languageCode,
    ].join('|')
}

export function readCachedWeather(args: CacheKeyArgs): { result: WeatherFetchResult; provider: 'google' | 'open-meteo' } | null {
    const key = cacheKey(args)
    const hit = cache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > TTL_MS) {
        cache.delete(key)
        return null
    }
    return { result: hit.result, provider: hit.provider }
}

export function writeCachedWeather(
    args: CacheKeyArgs,
    result: WeatherFetchResult,
    provider: 'google' | 'open-meteo',
): void {
    const key = cacheKey(args)
    cache.set(key, { result, provider, at: Date.now() })
    // Light-touch bound: if the map grows past 200 entries, drop the
    // oldest 50. Saves a periodic eviction sweep.
    if (cache.size > 200) {
        const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)
        for (let i = 0; i < 50; i++) cache.delete(entries[i][0])
    }
}

/** Wipe the entire cache. Called after env changes that affect which
 *  provider answers — otherwise a stale "Google said no, fell to OM" entry
 *  would keep serving Open-Meteo data after the user enabled Weather API. */
export function invalidateWeatherCache(): void {
    cache.clear()
}

/** Test/debug helper — number of live entries. */
export function weatherCacheSize(): number {
    return cache.size
}
