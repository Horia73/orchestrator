import type {
    WeatherAirQuality,
    WeatherCurrent,
    WeatherDaily,
    WeatherHourly,
    WeatherUnits,
} from '../schema'

// ---------------------------------------------------------------------------
// Weather provider abstraction.
//
// Both Google Weather and Open-Meteo expose the same canonical shape after
// transformation — current + hourly + daily + optional air quality. The
// provider abstraction lets WeatherShow try one backend and fall back to
// another without each call site re-implementing the orchestration.
//
// Design:
//   - `id` matches the schema's `provider` enum so the assembled artifact
//     carries it through to the renderer's attribution line.
//   - `isAvailable()` is cheap (cache-aware probe) — used to skip providers
//     that obviously can't answer right now (no key, API not enabled).
//   - `geocode()` is optional — Google reuses the maps integration's
//     geocoder; Open-Meteo ships its own keyless one. WeatherShow uses the
//     geocoder from the provider it ultimately fetches from, so each
//     provider stays self-contained.
//   - `fetchWeather()` returns the parts of WeatherArtifact that come from
//     a forecast call — location + units + provider id + fetchedAt are
//     filled by the WeatherShow tool after picking a provider.
// ---------------------------------------------------------------------------

export interface WeatherFetchOptions {
    lat: number
    lng: number
    units: WeatherUnits
    /** Forecast days, 1..16. Providers clamp to their own max. */
    days?: number
    /** Hourly forecast horizon, 1..240. */
    hours?: number
    /** BCP-47 language code for condition descriptions ("en", "ro", …).
     *  Open-Meteo ignores this for descriptions but accepts it for
     *  geocoding hints. */
    languageCode?: string
    /** Whether to also fetch air quality. Each provider opts in if it
     *  supports AQ. Failures don't block weather. */
    includeAirQuality?: boolean
}

export interface WeatherFetchResult {
    current: WeatherCurrent
    hourly: WeatherHourly[]
    daily: WeatherDaily[]
    airQuality?: WeatherAirQuality
    /** IANA tz the provider reports for the requested coordinate. */
    timezone?: string
}

export interface WeatherGeocodeHit {
    /** Display name: "Cluj-Napoca", "Times Square". */
    name: string
    /** Region/admin1 if the provider returns it. */
    region?: string
    /** Country name or ISO code, whichever the provider gives. */
    country?: string
    /** [longitude, latitude] in GeoJSON order. */
    coordinates: [number, number]
    /** IANA tz if available — saves a separate lookup. */
    timezone?: string
}

export interface WeatherAvailability {
    /** This provider can run a successful fetch right now. */
    available: boolean
    /** Why it's unavailable, when applicable. Forwarded to MEMORY.md /
     *  WeatherStatus output for the orchestrator to act on. */
    reason?: string
    /** Human-actionable hint (e.g. enable-API URL) when available. */
    detail?: string
}

export interface WeatherProviderClient {
    /** Stable id matching `WeatherProviderSchema`. */
    readonly id: 'google' | 'open-meteo'
    /** Display name used in attribution + onboarding copy. */
    readonly name: string

    /** Cheap readiness probe. Implementations cache aggressively. */
    isAvailable(): Promise<WeatherAvailability>

    /** Resolve a free-form place name to coordinates. Optional — when
     *  absent the WeatherShow tool falls back to its global geocoder
     *  (Google Geocoding via the maps integration). */
    geocode?(query: string, languageCode?: string): Promise<WeatherGeocodeHit | null>

    /** Fetch a complete forecast. Throws a `WeatherProviderError` if the
     *  upstream is unreachable or rejects the request; the WeatherShow
     *  tool catches that and tries the next provider in the chain. */
    fetchWeather(opts: WeatherFetchOptions): Promise<WeatherFetchResult>
}

/** Errors thrown by provider implementations. WeatherShow treats these as
 *  "try next provider" signals; other errors propagate up unchanged. */
export class WeatherProviderError extends Error {
    constructor(
        public readonly providerId: 'google' | 'open-meteo',
        message: string,
        public readonly upstreamStatus?: number,
        public readonly upstreamBody?: string,
    ) {
        super(message)
        this.name = 'WeatherProviderError'
    }
}
