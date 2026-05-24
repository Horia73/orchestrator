import { z } from "zod"

import { isSafeHttpUrl } from "./urls"

// ---------------------------------------------------------------------------
// Map artifact domain schema.
//
// A `MapArtifact` is the JSON payload the model emits inside an
// `<artifact type="application/vnd.ant.map">` block. The renderer parses this
// with Zod and hands the validated shape to a sandboxed Google Maps runtime.
//
// Design choices that lock the shape in early so it can be versioned cleanly:
//   - Coordinates are always [lng, lat] — same order Google Maps overlays and
//     GeoJSON use.
//     The model is told this in the prompt so it doesn't flip the pair.
//   - `viewport` is required; the renderer needs to know where to centre.
//     `pitch`/`bearing` are optional so flat top-down maps remain trivial.
//   - `basemap` is an enum of product-facing style ids. The renderer maps
//     these to Google Maps JS mapTypeIds (`satellite` / `hybrid`) so artifact
//     JSON never contains provider internals or API keys.
//   - `pins`, `routes`, `polygons` are top-level (for simple "drop a few
//     markers" cases) AND nested inside `days[]` (for the trip-planner UI).
//     The renderer merges them when a `days` array is present so a day-1 pin
//     shown when "Day 1" is active is just the union of the global pins and
//     the day-1 pins.
//   - `days[]` is optional. Its presence is what flips the renderer into
//     trip-planner mode (day selector sidebar + flyTo on day click).
//
// This module imports only zod plus the tiny URL predicate — it sits at the
// bottom of the import graph so both the server-side validator and the
// client-side renderer can depend on it without cycles.
// ---------------------------------------------------------------------------

// --- primitives ------------------------------------------------------------

/** GeoJSON-order coordinate: `[longitude, latitude]`. Latitude is the
 *  smaller-magnitude axis (-90..90); longitude is the bigger one (-180..180).
 *  Documented for the model in the prompt because the temptation to write
 *  `[lat, lng]` is real. */
export const MapCoordinateSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
])
export type MapCoordinate = z.infer<typeof MapCoordinateSchema>

/** Axis-aligned bounding box: `[west, south, east, north]`. Used for
 *  `fitBounds` so the renderer can frame a set of features without the model
 *  having to compute zoom/center. */
export const MapBBoxSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
])
export type MapBBox = z.infer<typeof MapBBoxSchema>

/** Hex colour, 6 digits, leading `#`. We deliberately reject 3-digit or
 *  alpha-suffixed forms — keeping a single canonical shape avoids surprises
 *  when CSS interprets `#abc` vs `#aabbcc` differently in some contexts. */
const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb hex colour")
const HttpUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => isSafeHttpUrl(value), "must use http:// or https://")
const HttpsUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(
    (value) => isSafeHttpUrl(value, { httpsOnly: true }),
    "must use https://"
  )

// --- features --------------------------------------------------------------

/** Canonical icon keywords. The renderer dispatches per-icon SVGs for
 *  these; everything else falls back to `default`. Documented in the
 *  orchestrator prompt so the model picks from a guided set, but the
 *  schema stays permissive — an unknown icon string is NOT a validation
 *  error (it just renders as default). Lessens the friction of new
 *  semantic intents the model invents. */
export const CANONICAL_PIN_ICONS = [
  "default",
  "star",
  "flag",
  "heart",
  "dot",
  "food",
  "coffee",
  "drink",
  "hotel",
  "transport",
  "shopping",
  "park",
  "gas",
  "airport",
  "museum",
  "beach",
] as const
export type CanonicalPinIcon = (typeof CANONICAL_PIN_ICONS)[number]

/** A single point marker. `id` must be unique within the artifact so React
 *  reconciliation and pin-click events stay stable across re-renders. */
export const MapPinSchema = z.object({
  id: z.string().min(1).max(64),
  position: MapCoordinateSchema,
  /** Short heading shown in the popup and the sidebar card title.
   *  Keep it terse — venue name, address, "Meeting 14:00". */
  label: z.string().max(120).optional(),
  /** Secondary line in the sidebar card and the second line of the
   *  popup. Use for address, neighbourhood, time range — short prose,
   *  not a paragraph. */
  address: z.string().max(200).optional(),
  /** Longer body shown in the popup below label/address. Plain text;
   *  markdown rendering is a future follow-up. */
  description: z.string().max(2000).optional(),
  /** Optional image URL shown as the sidebar card thumbnail and in the
   *  popup header. Use absolute https:// URLs that don't require auth.
   *  Be mindful of hotlinking other sites' images; prefer the venue's
   *  own page or a public CDN. */
  photoUrl: HttpsUrlSchema.optional(),
  /** Optional numeric rating (e.g. 4.6 stars). Rendered as a star
   *  number badge on the sidebar card. */
  rating: z.number().min(0).max(5).optional(),
  /** Number of Google/user reviews behind the rating, when available. */
  userRatingCount: z.number().int().min(0).optional(),
  /** Upstream business status, e.g. OPERATIONAL / CLOSED_TEMPORARILY. */
  businessStatus: z.string().max(80).optional(),
  /** Current open state from the upstream provider. */
  openNow: z.boolean().optional(),
  /** Localized weekday opening-hours lines. */
  openingHours: z.array(z.string().max(180)).max(14).optional(),
  /** Public phone number returned by the upstream provider. */
  phoneNumber: z.string().max(80).optional(),
  /** Upstream price level enum or compact label. */
  priceLevel: z.string().max(80).optional(),
  /** Short provider editorial summary, when available. */
  editorialSummary: z.string().max(1000).optional(),
  /** Stable upstream place id when the pin came from a provider such as
   *  Google Places. This lets future click-to-act flows reopen/enrich the
   *  exact same place instead of fuzzy-searching the label again. */
  placeId: z.string().max(256).optional(),
  /** Provider deep link to the place. Rendered as a safe external action
   *  on the pin details card. */
  googleMapsUri: HttpUrlSchema.optional(),
  /** Official website returned by the upstream provider, when present. */
  websiteUri: HttpUrlSchema.optional(),
  /** Generic source URL for researched/listing pins that are not Google
   *  Places results. Kept separate from `websiteUri` because a listing URL
   *  and an official venue website mean different things. */
  sourceUrl: HttpUrlSchema.optional(),
  /** Local Smart Maps saved-place id. Used by the app UI for saved-place
   *  overlays and edit/delete actions. Model-authored artifacts normally
   *  omit this. */
  savedPlaceId: z.string().max(128).optional(),
  /** Local user notes for a saved place. Kept separate from provider
   *  descriptions so user-authored annotations can be edited safely. */
  notes: z.string().max(2000).optional(),
  /** Hex colour for the marker glyph. Falls back to a theme default. */
  color: HexColorSchema.optional(),
  /** Icon keyword. See `CANONICAL_PIN_ICONS` for the renderer's
   *  dispatch list; unknown values render as `default`. Free-form
   *  string so the model never trips on schema validation when it
   *  reaches for a semantic the canonical list doesn't have. */
  icon: z.string().max(32).optional(),
})
export type MapPin = z.infer<typeof MapPinSchema>

/** A polyline drawn between consecutive coordinates. Used for routes and
 *  tracks. For a routing-engine result the model usually emits the decoded
 *  polyline straight from OSRM/Google Directions. */
export const MapRouteSchema = z.object({
  id: z.string().min(1).max(64),
  coordinates: z.array(MapCoordinateSchema).min(2),
  color: HexColorSchema.optional(),
  /** Visual stroke style. Solid is the default; dashed is used for secondary
   *  access legs such as the last walking segment after a driving route. */
  style: z.enum(["solid", "dashed"]).optional(),
  /** Stroke width in CSS pixels. */
  width: z.number().int().min(1).max(20).optional(),
  /** Optional label shown when the route is hovered/clicked. */
  label: z.string().max(120).optional(),
})
export type MapRoute = z.infer<typeof MapRouteSchema>

/** A filled polygon with one outer ring and zero or more holes. Each ring
 *  is an array of coordinates; the renderer closes them automatically. */
export const MapPolygonSchema = z.object({
  id: z.string().min(1).max(64),
  rings: z.array(z.array(MapCoordinateSchema).min(3)).min(1),
  color: HexColorSchema.optional(),
  /** 0..1, applied to the fill only — the stroke uses `color` at 100%. */
  fillOpacity: z.number().min(0).max(1).optional(),
  label: z.string().max(120).optional(),
})
export type MapPolygon = z.infer<typeof MapPolygonSchema>

// --- trip planner ----------------------------------------------------------

/** One day in a trip-planner map. The renderer shows a sidebar with one
 *  button per day; clicking flies the camera to `fitBounds` (or, if absent,
 *  the bounds of that day's pins) and highlights that day's features. */
export const MapDaySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  /** Optional calendar label or date for the day. Kept as a short string
   *  instead of a strict ISO date because trip plans often use labels like
   *  "Sat, Jun 8" or "Arrival day" before exact dates are known. */
  date: z.string().max(80).optional(),
  /** Optional rough time window for the visible itinerary. */
  startTime: z.string().max(40).optional(),
  endTime: z.string().max(40).optional(),
  /** Short prose shown in the trip sidebar. Keep it concise: one sentence
   *  describing the day's theme, not the full itinerary write-up. */
  summary: z.string().max(500).optional(),
  /** Optional explicit bounding box — useful when a day's pins are widely
   *  spread and the auto-computed bounds would zoom out too much. */
  fitBounds: MapBBoxSchema.optional(),
  pins: z.array(MapPinSchema).default([]),
  routes: z.array(MapRouteSchema).default([]),
})
export type MapDay = z.infer<typeof MapDaySchema>

// --- viewport + basemap ----------------------------------------------------

export const MapViewportSchema = z.object({
  center: MapCoordinateSchema,
  /** Google Maps zoom: 0 (world) .. 22 (street-detail). */
  zoom: z.number().min(0).max(22),
  /** Camera tilt in degrees; 0 = top-down, 60 = oblique. */
  pitch: z.number().min(0).max(85).optional(),
  /** Camera rotation in degrees; 0 = north up. */
  bearing: z.number().min(-360).max(360).optional(),
})
export type MapViewport = z.infer<typeof MapViewportSchema>

/** Product-facing basemap ids. Resolved by the Google Maps JS iframe runtime.
 *  Only the two satellite flavours are exposed — this is intentionally a
 *  satellite-first map surface and pure-roadmap views are not part of v1. */
export const MapBasemapSchema = z.enum(["satellite", "satellite-streets"])
export type MapBasemap = z.infer<typeof MapBasemapSchema>

// --- root ------------------------------------------------------------------

export const MapArtifactSchema = z
  .object({
    viewport: MapViewportSchema,
    basemap: MapBasemapSchema.default("satellite"),
    pins: z.array(MapPinSchema).default([]),
    routes: z.array(MapRouteSchema).default([]),
    polygons: z.array(MapPolygonSchema).default([]),
    /** Optional trip-planner days. Presence flips the renderer into
     *  multi-day mode (sidebar + flyTo). When absent, the map is a single
     *  scene. */
    days: z.array(MapDaySchema).optional(),
    /** Free-form attribution suffix appended after the basemap's default
     *  attribution. Use sparingly — the basemap provider's attribution is
     *  already shown automatically. */
    attribution: z.string().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const dayFeatureCount = (value.days ?? []).reduce(
      (sum, day) => sum + day.pins.length + day.routes.length,
      0
    )
    const featureCount =
      value.pins.length +
      value.routes.length +
      value.polygons.length +
      dayFeatureCount
    if (featureCount === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "Map artifact must include at least one pin, route, polygon, or day feature.",
        path: ["pins"],
      })
    }
  })
export type MapArtifact = z.infer<typeof MapArtifactSchema>

/** Result wrapper so the renderer can show a clear error message instead of
 *  silently rendering a blank map when the model emits malformed JSON. */
export type MapArtifactParseResult =
  | { ok: true; value: MapArtifact }
  | { ok: false; error: string }

/** Parse a raw artifact body (the string content of an
 *  `application/vnd.ant.map` artifact). Returns a discriminated union so
 *  call sites can present a styled error in place of the map without
 *  throwing. */
export function parseMapArtifact(rawJson: string): MapArtifactParseResult {
  let value: unknown
  try {
    value = JSON.parse(rawJson)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }
  const parsed = MapArtifactSchema.safeParse(value)
  if (!parsed.success) {
    // Surface the first issue — the model can usually fix one thing at a
    // time, and a wall of issues is harder to act on.
    const first = parsed.error.issues[0]
    const path = first.path.length ? first.path.join(".") : "(root)"
    return { ok: false, error: `${path}: ${first.message}` }
  }
  return { ok: true, value: parsed.data }
}
