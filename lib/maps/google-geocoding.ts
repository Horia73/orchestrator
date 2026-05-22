import { readGoogleMapsApiKey } from './google-session'

// ---------------------------------------------------------------------------
// Google Geocoding API client.
//
// Used by `MapsGeocode` (address → coords) and `MapsReverseGeocode`
// (coords → address). Same API key as Maps JavaScript API, different Google
// service — the user must enable the **Geocoding API** in their GCP
// project (separate from Maps JavaScript). When it's not enabled the upstream
// returns a clear "REQUEST_DENIED" status with a link to enable; we pass
// that through verbatim so the orchestrator can guide the fix.
//
// Cost: $5 / 1000 requests, with $200/month free credit shared with the
// rest of Maps Platform — solidly covers any single-user workload.
// ---------------------------------------------------------------------------

const GOOGLE_GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json'

export interface GeocodeResult {
    /** The input address as the caller supplied it. Echoed back so a
     *  batched response can be aligned with the request. */
    query: string
    /** Google's canonical formatted address. Often more useful than the
     *  raw input ("Bd Magheru 1, Cluj-Napoca 400069, Romania" vs the
     *  user's terse "Magheru 1"). */
    formattedAddress: string
    /** GeoJSON-order coordinate [longitude, latitude]. Matches the rest
     *  of the map schema. */
    position: [number, number]
    /** Stable Google place id. Useful for follow-up Places API calls or
     *  de-duplicating across calls. */
    placeId: string | null
    /** Google's location_type — ROOFTOP / RANGE_INTERPOLATED /
     *  GEOMETRIC_CENTER / APPROXIMATE. ROOFTOP is the highest precision. */
    locationType: string | null
    /** Normalized Google address components for display-name extraction. */
    addressComponents?: NormalizedAddressComponent[]
}

export interface GeocodeFailure {
    query: string
    error: string
}

interface GeocodeApiResponse {
    status: string
    error_message?: string
    results?: Array<{
        formatted_address: string
        geometry?: { location?: { lat: number; lng: number }; location_type?: string }
        place_id?: string
        address_components?: GoogleAddressComponent[]
    }>
}

export interface NormalizedAddressComponent {
    longName: string
    shortName: string
    types: string[]
}

interface GoogleAddressComponent {
    long_name: string
    short_name: string
    types?: string[]
}

function normalizeAddressComponents(components: GoogleAddressComponent[] | undefined): NormalizedAddressComponent[] | undefined {
    if (!components?.length) return undefined
    return components.map(component => ({
        longName: component.long_name,
        shortName: component.short_name,
        types: component.types ?? [],
    }))
}

async function geocodeOne(address: string, apiKey: string, region: string | undefined): Promise<GeocodeResult | GeocodeFailure> {
    const params = new URLSearchParams({ address, key: apiKey })
    if (region) params.set('region', region)
    let resp: Response
    try {
        resp = await fetch(`${GOOGLE_GEOCODE_BASE}?${params.toString()}`)
    } catch (e) {
        return { query: address, error: `network: ${(e as Error).message}` }
    }
    if (!resp.ok) {
        return { query: address, error: `HTTP ${resp.status}` }
    }
    let data: GeocodeApiResponse
    try {
        data = await resp.json() as GeocodeApiResponse
    } catch (e) {
        return { query: address, error: `bad json: ${(e as Error).message}` }
    }
    if (data.status === 'OK' && data.results && data.results[0]) {
        const top = data.results[0]
        const loc = top.geometry?.location
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
            return { query: address, error: 'no usable geometry in upstream response' }
        }
        return {
            query: address,
            formattedAddress: top.formatted_address,
            position: [loc.lng, loc.lat],
            placeId: top.place_id ?? null,
            locationType: top.geometry?.location_type ?? null,
            addressComponents: normalizeAddressComponents(top.address_components),
        }
    }
    if (data.status === 'ZERO_RESULTS') {
        return { query: address, error: 'no results' }
    }
    // REQUEST_DENIED / INVALID_REQUEST / OVER_QUERY_LIMIT / UNKNOWN_ERROR — forward verbatim so the orchestrator can act on it.
    return {
        query: address,
        error: `${data.status}: ${data.error_message ?? '(no message)'}`,
    }
}

/** Concurrency-limited batch geocoder. Returns one result per input
 *  address in order. Errors stay in-band as `GeocodeFailure` so the
 *  caller can decide which addresses to drop vs retry. */
export async function geocodeAddresses(
    addresses: string[],
    options: { region?: string; concurrency?: number } = {},
): Promise<Array<GeocodeResult | GeocodeFailure>> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) {
        return addresses.map(a => ({ query: a, error: 'GOOGLE_MAPS_API_KEY is not set' }))
    }
    const keyForClosure: string = apiKey
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 10))
    const out: Array<GeocodeResult | GeocodeFailure> = new Array(addresses.length)
    let cursor = 0
    async function worker(): Promise<void> {
        while (true) {
            const idx = cursor++
            if (idx >= addresses.length) return
            out[idx] = await geocodeOne(addresses[idx], keyForClosure, options.region)
        }
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) workers.push(worker())
    await Promise.all(workers)
    return out
}

interface ReverseGeocodeApiResponse {
    status: string
    error_message?: string
    results?: Array<{
        formatted_address: string
        place_id?: string
        types?: string[]
        address_components?: GoogleAddressComponent[]
    }>
}

export interface ReverseGeocodeResult {
    position: [number, number]
    formattedAddress: string
    placeId: string | null
    types: string[]
    addressComponents?: NormalizedAddressComponent[]
}

export interface ReverseGeocodeFailure {
    position: [number, number]
    error: string
}

/** Convert [lng, lat] → best-match address. Useful when the user clicks
 *  somewhere on a map and the orchestrator needs to name the spot. */
export async function reverseGeocode(
    position: [number, number],
): Promise<ReverseGeocodeResult | ReverseGeocodeFailure> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) return { position, error: 'GOOGLE_MAPS_API_KEY is not set' }
    const [lng, lat] = position
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return { position, error: 'invalid coordinate' }
    }
    const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: apiKey })
    let resp: Response
    try {
        resp = await fetch(`${GOOGLE_GEOCODE_BASE}?${params.toString()}`)
    } catch (e) {
        return { position, error: `network: ${(e as Error).message}` }
    }
    if (!resp.ok) return { position, error: `HTTP ${resp.status}` }
    let data: ReverseGeocodeApiResponse
    try {
        data = await resp.json() as ReverseGeocodeApiResponse
    } catch (e) {
        return { position, error: `bad json: ${(e as Error).message}` }
    }
    if (data.status === 'OK' && data.results && data.results[0]) {
        const top = data.results[0]
        return {
            position,
            formattedAddress: top.formatted_address,
            placeId: top.place_id ?? null,
            types: top.types ?? [],
            addressComponents: normalizeAddressComponents(top.address_components),
        }
    }
    if (data.status === 'ZERO_RESULTS') {
        return { position, error: 'no results' }
    }
    return { position, error: `${data.status}: ${data.error_message ?? '(no message)'}` }
}
