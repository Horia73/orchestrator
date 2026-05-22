import { getEnvValue } from '@/lib/config'

// ---------------------------------------------------------------------------
// Google Maps Platform — shared helpers.
//
// Used to be the server-side tile/session cache; that whole layer is gone now
// that the renderer uses Google Maps JavaScript API directly (loaded
// client-side inside a sandboxed iframe, key referrer-restricted at GCP).
//
// What remains here is the env-key reader used by the other Maps Platform
// products we still call from the server side (Geocoding API, Weather API,
// Air Quality API). Keeping the function in `google-session.ts` rather
// than renaming the file because multiple sibling modules already import
// `readGoogleMapsApiKey` from this path and a rename would churn them all
// without changing behaviour.
// ---------------------------------------------------------------------------

/** Map-type id passed to Google's various Maps Platform APIs that accept
 *  one. Kept here because both the geocoding wrapper (Phase 2) and the
 *  weather wrappers (added in parallel) reference this label set. */
export type GoogleMapType = 'roadmap' | 'satellite' | 'terrain' | 'hybrid'

/** Read the shared `GOOGLE_MAPS_API_KEY` env var. Returns null when the
 *  variable is missing or empty; callers should fail with an actionable
 *  message ("set GOOGLE_MAPS_API_KEY in your environment") instead of
 *  making upstream requests that will 401. */
export function readGoogleMapsApiKey(): string | null {
    return getEnvValue('GOOGLE_MAPS_API_KEY')
}
