import { z } from 'zod'

// ---------------------------------------------------------------------------
// Weather artifact domain schema.
//
// A `WeatherArtifact` is the JSON payload the orchestrator emits inside an
// `<artifact type="application/vnd.ant.weather">` block. The renderer parses
// this with Zod and hands the validated shape to a native React UI that
// recreates the iOS Weather look (hero card with gradient, hourly scroll,
// daily forecast with temperature range bars, detail grid).
//
// Design choices that lock the shape in early so it can be versioned cleanly:
//   - Coordinates are [lng, lat] — same order as the map schema, GeoJSON
//     convention. Documented for the model in the prompt because the
//     temptation to write [lat, lng] is real.
//   - Units enum (metric/imperial) is on the payload, not derived. The
//     renderer reads it to suffix °C/°F, km/mi, m/s/mph etc.
//   - `condition` is a normalized internal enum (clear, cloudy, rain, snow,
//     fog, storm, wind, sleet, hail) — the renderer maps each to an icon +
//     gradient. Provider-specific strings ("Mostly Cloudy", "Scattered
//     Showers") live in `conditionLabel` for display only.
//   - `current`, `hourly[]`, `daily[]` are top-level so the renderer can
//     render the iOS-style layout without nesting acrobatics.
//   - `airQuality` is optional — Google's air quality lives on a separate
//     API which the user may or may not have enabled.
//   - `provider` records which backend produced the data — useful for
//     attribution and for switching providers (Open-Meteo, Apple, …) without
//     reshaping the payload.
//
// This module imports nothing but zod — it sits at the bottom of the import
// graph so both the server-side validator and the client-side renderer can
// depend on it without cycles.
// ---------------------------------------------------------------------------

// --- primitives ------------------------------------------------------------

/** GeoJSON-order coordinate: `[longitude, latitude]`. Same convention as
 *  the map schema so coordinates can be threaded between the two without
 *  flipping. */
export const WeatherCoordinateSchema = z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
])
export type WeatherCoordinate = z.infer<typeof WeatherCoordinateSchema>

/** Internal condition taxonomy. Renderer maps each to:
 *    - lucide-react icon
 *    - hero gradient class
 *    - day/night variants
 *  Provider-specific labels ("Light snow showers", "Partly cloudy") go in
 *  `conditionLabel` separately so we can swap providers without breaking
 *  the icon/gradient mapping. */
export const WeatherConditionSchema = z.enum([
    'clear',
    'partly-cloudy',
    'cloudy',
    'overcast',
    'fog',
    'drizzle',
    'rain',
    'heavy-rain',
    'sleet',
    'snow',
    'heavy-snow',
    'hail',
    'thunderstorm',
    'windy',
    'unknown',
])
export type WeatherCondition = z.infer<typeof WeatherConditionSchema>

export const WeatherUnitsSchema = z.enum(['metric', 'imperial'])
export type WeatherUnits = z.infer<typeof WeatherUnitsSchema>

export const WeatherProviderSchema = z.enum(['google', 'open-meteo', 'manual'])
export type WeatherProvider = z.infer<typeof WeatherProviderSchema>

// --- location --------------------------------------------------------------

export const WeatherLocationSchema = z.object({
    /** Display name: "Bucharest", "Times Square", "Eiffel Tower". */
    name: z.string().min(1).max(120),
    /** Optional region/admin1: "Bucharest", "New York", "Île-de-France". */
    region: z.string().max(120).optional(),
    /** Country label or ISO code, depending on the geocoder: "Romania", "United States", "RO", "US". */
    country: z.string().min(2).max(120).optional(),
    /** [longitude, latitude] — GeoJSON order. */
    coordinates: WeatherCoordinateSchema,
    /** IANA timezone id: "Europe/Bucharest", "America/New_York". The
     *  renderer uses this to render sunrise/sunset and day boundaries
     *  in the correct local time instead of the user's browser tz. */
    timezone: z.string().min(1).max(64),
})
export type WeatherLocation = z.infer<typeof WeatherLocationSchema>

// --- current conditions ----------------------------------------------------

export const WeatherCurrentSchema = z.object({
    /** Temperature in payload units (°C or °F depending on `units`). */
    temperature: z.number(),
    /** "Feels like" / apparent temperature in the same units. */
    feelsLike: z.number(),
    /** Normalized condition for icon/gradient selection. */
    condition: WeatherConditionSchema,
    /** Provider's display label: "Partly cloudy", "Mostly clear". */
    conditionLabel: z.string().min(1).max(80),
    /** Whether it's currently daytime at the location. Drives night
     *  variants of icons + gradients (crescent moon instead of sun). */
    isDay: z.boolean(),
    /** Relative humidity, percent (0..100). */
    humidity: z.number().min(0).max(100),
    /** Dew point in temperature units. Optional — some providers omit. */
    dewPoint: z.number().optional(),
    /** Wind speed in payload units (m/s for metric, mph for imperial).
     *  Open-Meteo and Google return different units; the fetcher converts. */
    windSpeed: z.number().min(0),
    /** Wind direction in degrees, 0..360 (0 = N, 90 = E, …). */
    windDirection: z.number().min(0).max(360),
    /** Optional gust speed in the same units as windSpeed. */
    windGust: z.number().min(0).optional(),
    /** Precipitation in the last hour, mm or inches. */
    precipitation: z.number().min(0),
    /** Probability of precipitation, percent (0..100). */
    precipitationProbability: z.number().min(0).max(100).optional(),
    /** Atmospheric pressure, hPa (always — humans expect millibars even
     *  in imperial-units regions). */
    pressure: z.number().min(800).max(1100),
    /** Visibility, km for metric / mi for imperial. */
    visibility: z.number().min(0),
    /** UV index, 0..15+. The renderer maps to a Low/Moderate/High/Very
     *  High/Extreme label. */
    uvIndex: z.number().min(0).max(20),
    /** Cloud cover, percent (0..100). */
    cloudCover: z.number().min(0).max(100),
})
export type WeatherCurrent = z.infer<typeof WeatherCurrentSchema>

// --- hourly forecast -------------------------------------------------------

export const WeatherHourlySchema = z.object({
    /** ISO timestamp, e.g. "2025-05-21T14:00:00+03:00" (with timezone). */
    time: z.string().min(1).max(40),
    temperature: z.number(),
    condition: WeatherConditionSchema,
    /** Probability of precipitation for this hour, percent. */
    precipitationProbability: z.number().min(0).max(100),
    /** Whether it's daytime at this hour. */
    isDay: z.boolean(),
    /** UV index at this hour. Optional — providers may not return it for
     *  every hour (especially night hours, where 0 is implicit anyway).
     *  Renderer shows a small chip in the day-expansion view when present. */
    uvIndex: z.number().min(0).max(20).optional(),
})
export type WeatherHourly = z.infer<typeof WeatherHourlySchema>

// --- daily forecast --------------------------------------------------------

export const WeatherDailySchema = z.object({
    /** ISO date (YYYY-MM-DD) in the location's timezone. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO date YYYY-MM-DD'),
    condition: WeatherConditionSchema,
    conditionLabel: z.string().min(1).max(80),
    temperatureHigh: z.number(),
    temperatureLow: z.number(),
    /** Daytime "feels like" max. Optional. */
    feelsLikeHigh: z.number().optional(),
    feelsLikeLow: z.number().optional(),
    precipitationProbability: z.number().min(0).max(100),
    /** Total precipitation expected for the day, mm or inches. */
    precipitationSum: z.number().min(0),
    uvIndexMax: z.number().min(0).max(20),
    /** ISO timestamp for sunrise/sunset in the location's timezone. */
    sunrise: z.string().min(1).max(40),
    sunset: z.string().min(1).max(40),
    windSpeedMax: z.number().min(0),
    windGustMax: z.number().min(0).optional(),
    humidityAvg: z.number().min(0).max(100).optional(),
})
export type WeatherDaily = z.infer<typeof WeatherDailySchema>

// --- air quality (optional) ------------------------------------------------

export const WeatherAirQualitySchema = z.object({
    /** AQI value (0..500 US scale, or 0..500 EU scale — provider-specific). */
    aqi: z.number().min(0).max(1000),
    /** Human label: "Good", "Moderate", "Unhealthy for Sensitive Groups",
     *  "Unhealthy", "Very Unhealthy", "Hazardous". */
    aqiLabel: z.string().min(1).max(40),
    /** µg/m³ for PM2.5 / PM10 if provided. */
    pm25: z.number().min(0).optional(),
    pm10: z.number().min(0).optional(),
    /** µg/m³ for ozone if provided. */
    ozone: z.number().min(0).optional(),
})
export type WeatherAirQuality = z.infer<typeof WeatherAirQualitySchema>

// --- forecast intelligence (optional, deterministic/model assisted) --------

export const WeatherAlertSchema = z.object({
    /** Stable-ish id for React keys and future dismiss/suppress affordances. */
    id: z.string().min(1).max(80),
    /** Forecast-derived heads-up, not an official government warning. */
    source: z.enum(['forecast', 'official']),
    kind: z.enum(['rain', 'storm', 'snow', 'wind', 'uv', 'air_quality', 'heat', 'cold', 'fog']),
    severity: z.enum(['info', 'advisory', 'watch', 'warning']),
    title: z.string().min(1).max(90),
    summary: z.string().min(1).max(220),
    startsAt: z.string().min(1).max(40).optional(),
    endsAt: z.string().min(1).max(40).optional(),
})
export type WeatherAlert = z.infer<typeof WeatherAlertSchema>

export const WeatherWhySchema = z.object({
    source: z.literal('model').default('model'),
    kind: z.enum(['feels_like', 'humidity', 'wind', 'uv', 'air_quality', 'pressure', 'precipitation']),
    title: z.string().min(1).max(70),
    value: z.string().min(1).max(40),
    explanation: z.string().min(1).max(180),
    severity: z.enum(['neutral', 'useful', 'caution']).default('neutral'),
})
export type WeatherWhy = z.infer<typeof WeatherWhySchema>

export const WeatherHistoricalComparisonSchema = z.object({
    source: z.literal('open-meteo-archive'),
    generatedAt: z.string().min(1).max(40),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sampleYears: z.number().int().min(1).max(80),
    temperatureHigh: z.object({
        current: z.number(),
        normal: z.number(),
        anomaly: z.number(),
    }).optional(),
    temperatureLow: z.object({
        current: z.number(),
        normal: z.number(),
        anomaly: z.number(),
    }).optional(),
    precipitation: z.object({
        current: z.number().min(0),
        normal: z.number().min(0),
        anomaly: z.number(),
    }).optional(),
    summary: z.string().min(1).max(220),
})
export type WeatherHistoricalComparison = z.infer<typeof WeatherHistoricalComparisonSchema>

export const WeatherPollenSpeciesSchema = z.object({
    kind: z.enum(['tree', 'weed', 'alder', 'birch', 'grass', 'mugwort', 'olive', 'ragweed']),
    label: z.string().min(1).max(40),
    value: z.number().min(0),
    level: z.enum(['low', 'moderate', 'high', 'very_high']),
})
export type WeatherPollenSpecies = z.infer<typeof WeatherPollenSpeciesSchema>

export const WeatherPollenSchema = z.object({
    source: z.enum(['google-pollen', 'open-meteo-air-quality']),
    generatedAt: z.string().min(1).max(40),
    primary: WeatherPollenSpeciesSchema.optional(),
    species: z.array(WeatherPollenSpeciesSchema).max(6),
    summary: z.string().min(1).max(180),
})
export type WeatherPollen = z.infer<typeof WeatherPollenSchema>

export const WeatherRadarSchema = z.object({
    source: z.literal('rainviewer'),
    generatedAt: z.string().min(1).max(40),
    frameTime: z.string().min(1).max(40),
    imageUrl: z.string().url().max(2048),
    viewerUrl: z.string().url().max(2048).optional(),
    tileTemplate: z.string().max(2048).optional(),
    attribution: z.string().min(1).max(120),
})
export type WeatherRadar = z.infer<typeof WeatherRadarSchema>

export const WeatherCalendarContextSchema = z.object({
    title: z.string().min(1).max(120),
    startTime: z.string().min(1).max(40),
    endTime: z.string().min(1).max(40).optional(),
    locationName: z.string().min(1).max(120).optional(),
    conditionLabel: z.string().min(1).max(80).optional(),
    temperature: z.number().optional(),
    precipitationProbability: z.number().min(0).max(100).optional(),
    note: z.string().min(1).max(180).optional(),
})
export type WeatherCalendarContext = z.infer<typeof WeatherCalendarContextSchema>

// --- model-authored guidance ----------------------------------------------

export const WeatherOutfitSchema = z.object({
    /** The UI treats this as model-authored advice, not provider data. */
    source: z.literal('model'),
    /** ISO timestamp for when the recommendation was generated. */
    generatedAt: z.string().min(1).max(40),
    /** Short headline, e.g. "Light jacket" or "Umbrella worth carrying". */
    headline: z.string().min(1).max(70),
    /** One practical sentence explaining the recommendation. */
    summary: z.string().min(1).max(240),
    /** Compact visual chips shown under the headline. */
    items: z.array(z.string().min(1).max(36)).min(1).max(5).optional(),
})
export type WeatherOutfit = z.infer<typeof WeatherOutfitSchema>

// --- root ------------------------------------------------------------------

export const WeatherArtifactSchema = z.object({
    location: WeatherLocationSchema,
    units: WeatherUnitsSchema,
    /** ISO timestamp of when the data was fetched. Renderer shows "Updated
     *  Nm ago" relative to this. */
    fetchedAt: z.string().min(1).max(40),
    /** Which backend produced this data. Drives the attribution string. */
    provider: WeatherProviderSchema,
    current: WeatherCurrentSchema,
    /** Up to 240 forecast hours plus up to 24 history hours. The hero strip
     *  renders a next-24h slice; daily-row expansion can still use morning
     *  history for today's row. Provider may return fewer if truncated. */
    hourly: z.array(WeatherHourlySchema).max(264),
    /** Next ~10 days. Each row in the iOS-style daily list. */
    daily: z.array(WeatherDailySchema).min(1).max(16),
    /** Optional — Google Air Quality API is a separate enable. */
    airQuality: WeatherAirQualitySchema.optional(),
    /** Optional model-authored clothing guidance written after forecast fetch. */
    outfit: WeatherOutfitSchema.optional(),
    /** Forecast-derived heads-up banners. These are not official warnings
     *  unless source="official". */
    alerts: z.array(WeatherAlertSchema).max(6).optional(),
    /** Deterministic "why it feels like this" rows. */
    why: z.array(WeatherWhySchema).max(5).optional(),
    /** Same-date comparison against recent Open-Meteo archive years. */
    historical: WeatherHistoricalComparisonSchema.optional(),
    /** Google Pollen API first; Open-Meteo Air Quality pollen as fallback. */
    pollen: WeatherPollenSchema.optional(),
    /** RainViewer latest radar widget URL. */
    radar: WeatherRadarSchema.optional(),
    /** Event-weather overlay written by the orchestrator after Calendar lookup. */
    calendarContext: z.array(WeatherCalendarContextSchema).max(5).optional(),
    /** Model-authored fields the card is still waiting on. WeatherShow mounts
     *  the card instantly with the live forecast and lists here the smart
     *  fields it expects the orchestrator to fill (`outfit`, `why`); the
     *  renderer reserves their tile footprint and shows a "Working…" skeleton
     *  so the later WeatherSetOutfit/WeatherSetWhy updates slot in without any
     *  reflow. Each setter removes its own entry; an empty/absent list means
     *  nothing is pending. */
    pending: z.array(z.enum(['outfit', 'why'])).max(2).optional(),
    /** Free-form attribution suffix. The renderer always appends the
     *  provider's default attribution; use this for "Updated by Orchestrator"
     *  tag or similar. */
    attribution: z.string().max(200).optional(),
})
export type WeatherArtifact = z.infer<typeof WeatherArtifactSchema>

/** Result wrapper so the renderer can show a clear error message instead of
 *  silently rendering an empty card when the model emits malformed JSON. */
export type WeatherArtifactParseResult =
    | { ok: true; value: WeatherArtifact }
    | { ok: false; error: string }

/** Parse a raw artifact body (the string content of an
 *  `application/vnd.ant.weather` artifact). Returns a discriminated union so
 *  call sites can present a styled error in place of the forecast without
 *  throwing. */
export function parseWeatherArtifact(rawJson: string): WeatherArtifactParseResult {
    let value: unknown
    try {
        value = JSON.parse(rawJson)
    } catch (e) {
        return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
    const parsed = WeatherArtifactSchema.safeParse(value)
    if (!parsed.success) {
        // Surface the first issue — the model can usually fix one thing at a
        // time, and a wall of issues is harder to act on.
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `${path}: ${first.message}` }
    }
    return { ok: true, value: parsed.data }
}
