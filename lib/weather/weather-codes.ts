import type { WeatherCondition } from './schema'

// ---------------------------------------------------------------------------
// Provider-agnostic weather code mapping.
//
// The schema's `condition` field is a small normalized enum (clear, cloudy,
// rain, snow, fog, storm, …). Each provider has its own taxonomy:
//   - Google Weather: a `weatherCondition.type` enum like PARTLY_CLOUDY,
//     SCATTERED_THUNDERSTORMS, etc. Documented at:
//     https://developers.google.com/maps/documentation/weather/reference/rest/v1/CurrentConditions#WeatherCondition
//   - Open-Meteo / WMO: integer codes (0..99), documented at:
//     https://open-meteo.com/en/docs (Weather variable section)
//
// The renderer doesn't care which provider produced the data — it only sees
// our normalized enum and maps that to an icon + gradient. Provider strings
// live in `conditionLabel` for display-only purposes.
// ---------------------------------------------------------------------------

/** Google Weather API `weatherCondition.type` strings — copied from the
 *  reference. Used as the key in the mapping table below. */
export type GoogleWeatherType =
    | 'TYPE_UNSPECIFIED'
    | 'CLEAR'
    | 'MOSTLY_CLEAR'
    | 'PARTLY_CLOUDY'
    | 'MOSTLY_CLOUDY'
    | 'CLOUDY'
    | 'WINDY'
    | 'WIND_AND_RAIN'
    | 'LIGHT_RAIN_SHOWERS'
    | 'CHANCE_OF_SHOWERS'
    | 'SCATTERED_SHOWERS'
    | 'RAIN_SHOWERS'
    | 'HEAVY_RAIN_SHOWERS'
    | 'LIGHT_TO_MODERATE_RAIN'
    | 'MODERATE_TO_HEAVY_RAIN'
    | 'RAIN'
    | 'LIGHT_RAIN'
    | 'HEAVY_RAIN'
    | 'RAIN_PERIODICALLY_HEAVY'
    | 'LIGHT_SNOW_SHOWERS'
    | 'CHANCE_OF_SNOW_SHOWERS'
    | 'SCATTERED_SNOW_SHOWERS'
    | 'SNOW_SHOWERS'
    | 'HEAVY_SNOW_SHOWERS'
    | 'LIGHT_TO_MODERATE_SNOW'
    | 'MODERATE_TO_HEAVY_SNOW'
    | 'SNOW'
    | 'LIGHT_SNOW'
    | 'HEAVY_SNOW'
    | 'SNOWSTORM'
    | 'SNOW_PERIODICALLY_HEAVY'
    | 'HEAVY_SNOW_STORM'
    | 'BLOWING_SNOW'
    | 'RAIN_AND_SNOW'
    | 'HAIL'
    | 'HAIL_SHOWERS'
    | 'THUNDERSTORM'
    | 'THUNDERSHOWER'
    | 'LIGHT_THUNDERSTORM_RAIN'
    | 'SCATTERED_THUNDERSTORMS'
    | 'HEAVY_THUNDERSTORM'

/**
 * Map a Google Weather `weatherCondition.type` to our normalized enum.
 * Anything we don't recognise falls back to 'unknown' (renderer shows a
 * generic icon and a neutral gradient).
 */
export function googleTypeToCondition(type: string | undefined | null): WeatherCondition {
    if (!type) return 'unknown'
    switch (type as GoogleWeatherType) {
        case 'CLEAR':
        case 'MOSTLY_CLEAR':
            return 'clear'
        case 'PARTLY_CLOUDY':
            return 'partly-cloudy'
        case 'MOSTLY_CLOUDY':
            return 'cloudy'
        case 'CLOUDY':
            return 'overcast'
        case 'WINDY':
            return 'windy'
        case 'WIND_AND_RAIN':
        case 'LIGHT_RAIN':
        case 'CHANCE_OF_SHOWERS':
        case 'LIGHT_RAIN_SHOWERS':
        case 'SCATTERED_SHOWERS':
        case 'LIGHT_TO_MODERATE_RAIN':
            return 'rain'
        case 'RAIN':
        case 'RAIN_SHOWERS':
        case 'MODERATE_TO_HEAVY_RAIN':
            return 'rain'
        case 'HEAVY_RAIN':
        case 'HEAVY_RAIN_SHOWERS':
        case 'RAIN_PERIODICALLY_HEAVY':
            return 'heavy-rain'
        case 'LIGHT_SNOW':
        case 'LIGHT_SNOW_SHOWERS':
        case 'CHANCE_OF_SNOW_SHOWERS':
        case 'SCATTERED_SNOW_SHOWERS':
        case 'LIGHT_TO_MODERATE_SNOW':
            return 'snow'
        case 'SNOW':
        case 'SNOW_SHOWERS':
        case 'MODERATE_TO_HEAVY_SNOW':
        case 'BLOWING_SNOW':
            return 'snow'
        case 'HEAVY_SNOW':
        case 'HEAVY_SNOW_SHOWERS':
        case 'SNOWSTORM':
        case 'SNOW_PERIODICALLY_HEAVY':
        case 'HEAVY_SNOW_STORM':
            return 'heavy-snow'
        case 'RAIN_AND_SNOW':
            return 'sleet'
        case 'HAIL':
        case 'HAIL_SHOWERS':
            return 'hail'
        case 'THUNDERSTORM':
        case 'THUNDERSHOWER':
        case 'LIGHT_THUNDERSTORM_RAIN':
        case 'SCATTERED_THUNDERSTORMS':
        case 'HEAVY_THUNDERSTORM':
            return 'thunderstorm'
        case 'TYPE_UNSPECIFIED':
        default:
            return 'unknown'
    }
}

/**
 * Human-readable label fallback when the provider didn't include one.
 * Google always returns a `description.text` field so this is rarely used;
 * it exists so the renderer can still show something sane if the provider
 * goes silent.
 */
export function conditionLabel(condition: WeatherCondition): string {
    switch (condition) {
        case 'clear': return 'Clear'
        case 'partly-cloudy': return 'Partly cloudy'
        case 'cloudy': return 'Mostly cloudy'
        case 'overcast': return 'Overcast'
        case 'fog': return 'Fog'
        case 'drizzle': return 'Drizzle'
        case 'rain': return 'Rain'
        case 'heavy-rain': return 'Heavy rain'
        case 'sleet': return 'Sleet'
        case 'snow': return 'Snow'
        case 'heavy-snow': return 'Heavy snow'
        case 'hail': return 'Hail'
        case 'thunderstorm': return 'Thunderstorm'
        case 'windy': return 'Windy'
        case 'unknown': return 'Unknown'
    }
}

export function conditionLabelForLocale(condition: WeatherCondition, languageCode?: string): string {
    const lang = languageCode?.toLowerCase() ?? ''
    if (lang === 'ro' || lang.startsWith('ro-')) {
        switch (condition) {
            case 'clear': return 'Senin'
            case 'partly-cloudy': return 'Parțial înnorat'
            case 'cloudy': return 'Mai mult înnorat'
            case 'overcast': return 'Înnorat'
            case 'fog': return 'Ceață'
            case 'drizzle': return 'Burniță'
            case 'rain': return 'Ploaie'
            case 'heavy-rain': return 'Ploaie puternică'
            case 'sleet': return 'Lapoviță'
            case 'snow': return 'Ninsoare'
            case 'heavy-snow': return 'Ninsoare puternică'
            case 'hail': return 'Grindină'
            case 'thunderstorm': return 'Furtună'
            case 'windy': return 'Vânt'
            case 'unknown': return 'Necunoscut'
        }
    }
    return conditionLabel(condition)
}

/**
 * UV index → severity label (matches the iOS Weather convention).
 * Used by the detail tile in the renderer.
 */
export function uvLabel(uvIndex: number): 'Low' | 'Moderate' | 'High' | 'Very High' | 'Extreme' {
    if (uvIndex < 3) return 'Low'
    if (uvIndex < 6) return 'Moderate'
    if (uvIndex < 8) return 'High'
    if (uvIndex < 11) return 'Very High'
    return 'Extreme'
}

/**
 * Wind direction in degrees → 16-point compass label (N, NNE, NE, …).
 * iOS Weather uses cardinal labels in the wind tile; this matches.
 */
export function windCompass(degrees: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    const idx = Math.round(((degrees % 360 + 360) % 360) / 22.5) % 16
    return dirs[idx]
}

/**
 * AQI value → label (US EPA scale).
 * Google's air quality API returns its own categoryLabel field, but if
 * we ever fetch raw PM values we fall back to this.
 */
export function aqiLabel(aqi: number): string {
    if (aqi <= 50) return 'Good'
    if (aqi <= 100) return 'Moderate'
    if (aqi <= 150) return 'Unhealthy for Sensitive Groups'
    if (aqi <= 200) return 'Unhealthy'
    if (aqi <= 300) return 'Very Unhealthy'
    return 'Hazardous'
}
