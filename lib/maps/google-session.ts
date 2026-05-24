import { getEnvValue } from "@/lib/config"

// ---------------------------------------------------------------------------
// Google Maps Platform — shared helpers.
//
// Used to be the server-side tile/session cache; that whole layer is gone now
// that the renderer uses Google Maps JavaScript API directly (loaded
// client-side inside a sandboxed iframe).
//
// What remains here is the env-key reader used by the browser-rendered Maps JS
// iframe and the server-side Maps Platform products we still call (Geocoding,
// Places, Routes, Weather, Air Quality).
// ---------------------------------------------------------------------------

/** Shared key for Maps JavaScript, Geocoding, Places, Routes, Weather, AQ, and Pollen. */
export function readGoogleMapsApiKey(): string | null {
  return getEnvValue("GOOGLE_MAPS_API_KEY")
}
