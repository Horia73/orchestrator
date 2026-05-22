import { googleWeatherProvider, invalidateGoogleProbe } from './google'
import { openMeteoProvider, invalidateOpenMeteoProbe } from './open-meteo'
import { invalidateWeatherCache } from '../cache'
import type { WeatherProviderClient } from './types'

// ---------------------------------------------------------------------------
// Provider chain.
//
// Order: Google first (richer descriptions + locality-tuned AQ), Open-Meteo
// as fallback (keyless, ECMWF, always available). The WeatherShow tool
// iterates in this order, calling `isAvailable()` and skipping providers
// that report unavailability so we don't waste a network round-trip on a
// guaranteed failure.
// ---------------------------------------------------------------------------

export const WEATHER_PROVIDER_CHAIN: WeatherProviderClient[] = [
    googleWeatherProvider,
    openMeteoProvider,
]

/** Bust every provider's availability probe + the forecast cache. Call
 *  after SetEnv writes a new GOOGLE_MAPS_API_KEY so the next forecast
 *  re-probes Google. */
export function invalidateWeatherProviderState(): void {
    invalidateGoogleProbe()
    invalidateOpenMeteoProbe()
    invalidateWeatherCache()
}

export { googleWeatherProvider, openMeteoProvider }
export type { WeatherProviderClient } from './types'
