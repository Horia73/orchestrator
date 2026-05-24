import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import { getMapsIntegrationStatus } from "@/lib/integrations/maps"
import {
  geocodeAddresses,
  reverseGeocode,
  type GeocodeFailure,
  type GeocodeResult,
} from "@/lib/maps/google-geocoding"
import {
  computeDirections,
  type DirectionsOptions,
  type MapsRouteWaypoint,
  type MapsTravelMode,
} from "@/lib/maps/google-routes"
import {
  searchPlaces,
  type PlacesRankPreference,
  type PlacesSearchMode,
  type PlacesSearchOptions,
} from "@/lib/maps/google-places"
import {
  optimizeStopOrder,
  type RouteOptimizerStop,
} from "@/lib/maps/route-optimizer"
import {
  getConfiguredHomeAssistantLocationSource,
  listHomeAssistantLocationCandidates,
  resolveCurrentMapLocation,
  saveHomeAssistantLocationSource,
  validateHomeAssistantLocationEntity,
} from "@/lib/maps/current-location"
import { MapArtifactSchema, type MapCoordinate } from "@/lib/maps/schema"

// ---------------------------------------------------------------------------
// MapRender — orchestrator-only map artifact builder.
//
// What it does:
//   The orchestrator calls MapRender with a structured map description
//   (viewport, basemap, pins, routes, polygons, optional days[] for the
//   trip-planner UI). The tool validates the payload against the canonical
//   `MapArtifactSchema` and returns the canonical JSON the orchestrator
//   should drop inside an <artifact type="application/vnd.ant.map"> tag.
//
// Why a tool instead of letting the model just write the artifact:
//   - Schema validation catches the easy mistakes (lat/lng swap, bad hex
//     colour, missing pin id) before the artifact ships to the renderer.
//     A failed artifact in chat is bad UX; a tool error the model can
//     react to is fine.
//   - The tool is granted only to the orchestrator (see
//     `lib/ai/agents/builtins.ts:MAPS_TOOL_IDS` and the orchestrator
//     config). Other agents that want a map happening must delegate to
//     the orchestrator. The executor also rejects Maps tool calls from
//     non-orchestrator caller ids, so this is enforced even if a tool
//     surface regresses later.
//   - When we wire cross-integration painting later (Calendar→Map,
//     Researcher→Map, Gmail/WhatsApp/HA→Map), they all funnel through this
//     same entry point. One place to add features and policy.
// ---------------------------------------------------------------------------

export const MAP_RENDER_TOOL_ID = "MapRender"

export const mapRenderTool: ToolDef = {
  id: MAP_RENDER_TOOL_ID,
  name: MAP_RENDER_TOOL_ID,
  description: [
    "Validate a map description and mount the resulting application/vnd.ant.map artifact inline in chat.",
    "Coordinates are ALWAYS [longitude, latitude] (GeoJSON order). Latitude is the smaller-magnitude axis (-90..90); longitude is the bigger one (-180..180).",
    "Include a top-level `viewport` ({ center: [lng,lat], zoom: 0..22 }) and at least one of pins/routes/polygons/days.",
    "For trip planners, pass a `days[]` array — each day shows up as a button in the in-map toolbar and the camera flies to that day's features when clicked.",
    "On success the artifact is direct-emitted into chat. On failure the tool returns an error pointing at the failing JSON path so you can fix that field and call again.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      identifier: {
        type: "string",
        description:
          'Stable kebab-case handle for the artifact (e.g. "cluj-coffee-shops"). Reuse across turns to update; pick a fresh one for genuinely different content.',
      },
      title: {
        type: "string",
        description: "Short human-readable label shown on the artifact card.",
      },
      viewport: {
        type: "object",
        description:
          "Initial camera. `center` is [lng, lat]; `zoom` 0 (world) .. 22 (street detail). Optional `pitch` 0..85 and `bearing` -360..360.",
        properties: {
          center: {
            type: "array",
            description: "[longitude, latitude] in that order.",
            items: { type: "number" },
          },
          zoom: { type: "number" },
          pitch: { type: "number" },
          bearing: { type: "number" },
        },
        required: ["center", "zoom"],
      },
      basemap: {
        type: "string",
        enum: ["satellite", "satellite-streets"],
        description:
          'Defaults to "satellite". Use "satellite-streets" when road labels matter (navigation, trip planning, real-estate context).',
      },
      pins: {
        type: "array",
        description:
          "Point markers. Each pin needs a stable id and [lng, lat] position. Optional label, address, description, photoUrl, rating, placeId, googleMapsUri, websiteUri, sourceUrl, color (#rrggbb hex), icon.",
        items: { type: "object" },
      },
      routes: {
        type: "array",
        description:
          "Polylines (≥2 coords each). Use for drive/walk paths, GPS traces, OSRM/Directions polylines.",
        items: { type: "object" },
      },
      polygons: {
        type: "array",
        description:
          "Filled polygons (1+ rings, each ring ≥3 coords). Use for zones, isochrones, search areas.",
        items: { type: "object" },
      },
      days: {
        type: "array",
        description:
          'Optional trip-planner days. Each day has id, label ("Day 1 — Arrival"), optional date/startTime/endTime/summary, optional fitBounds [w,s,e,n], pins[], routes[]. Presence enables the day-selector UI and trip sidebar inside the map.',
        items: { type: "object" },
      },
      attribution: {
        type: "string",
        description:
          "Optional short suffix appended after the basemap's default attribution. Use sparingly.",
      },
    },
    required: ["identifier", "title", "viewport"],
  },
  tags: ["maps"],
}

export function executeMapRender(args: Record<string, unknown>): ToolResult {
  const identifier =
    typeof args.identifier === "string" ? args.identifier.trim() : ""
  const title = typeof args.title === "string" ? args.title.trim() : ""
  if (!identifier)
    return {
      success: false,
      error: "MapRender requires a non-empty `identifier`.",
    }
  if (!title)
    return { success: false, error: "MapRender requires a non-empty `title`." }
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(identifier)) {
    return {
      success: false,
      error: `MapRender identifier "${identifier}" must be kebab-case (lowercase letters, digits, hyphens; start with a letter or digit).`,
    }
  }

  // Strip the artifact-only fields before schema validation — the schema
  // owns the body shape, not the artifact tag attributes.
  const {
    identifier: _id,
    title: _t,
    ...payload
  } = args as Record<string, unknown>
  void _id
  void _t

  const parsed = MapArtifactSchema.safeParse(payload)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first.path.length ? first.path.join(".") : "(root)"
    return {
      success: false,
      error: `MapRender validation failed at ${path}: ${first.message}`,
    }
  }

  // The canonical body — schema-validated, defaults applied. The
  // orchestrator should drop this verbatim inside the <artifact> tag.
  const body = JSON.stringify(parsed.data)

  return {
    success: true,
    data: {
      identifier,
      title,
      type: "application/vnd.ant.map",
      display: "inline",
      body,
      directEmit: true,
      usage: `Emit:\n<artifact identifier="${identifier}" type="application/vnd.ant.map" title="${escapeAttr(title)}" display="inline">\n${body}\n</artifact>`,
    },
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// ---------------------------------------------------------------------------
// MapsStatus — read-only setup probe.
//
// Lets the orchestrator answer "can I actually paint a map right now?"
// before committing to a long composition turn. Returns:
//   - configured: GOOGLE_MAPS_API_KEY is present in the env
//   - connected:  Geocoding API probe succeeded with the key.
//                 This verifies the server-side maps data tools. The
//                 client-side renderer also needs Maps JavaScript API enabled
//                 and key restrictions configured for production.
//   - needsReconnect: key is set but the geocoding probe failed. The error
//     string carries Google's verbatim message including the activation URL,
//     so the orchestrator can guide the user through fixing it.
// ---------------------------------------------------------------------------

export const MAPS_STATUS_TOOL_ID = "MapsStatus"

export const mapsStatusTool: ToolDef = {
  id: MAPS_STATUS_TOOL_ID,
  name: MAPS_STATUS_TOOL_ID,
  description: [
    "Report Google Maps readiness: whether the key is configured, whether it can call Geocoding API, and any error blocking that.",
    'Call this before emitting a map artifact if you have any reason to doubt the integration is healthy — a fresh install, a reported "Map failed" card, an error mid-conversation.',
    "When `connected` is false but `configured` is true, the most common cause is the Geocoding API not being enabled in the user's GCP project; the error string carries Google's activation URL. The renderer also requires Maps JavaScript API to be enabled and the key restricted before production use.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description:
          "When true, skip the 5-minute probe cache and re-test against Google. Default false.",
      },
    },
  },
  tags: ["maps"],
}

// ---------------------------------------------------------------------------
// MapsCurrentLocation + Home Assistant source setup.
//
// Browser geolocation belongs to the Smart Maps UI and is a fallback only
// when no saved Home Assistant user-location source can be resolved. These
// tools expose the server-side default used by agents, wake jobs, and
// commute/geofence monitors.
// ---------------------------------------------------------------------------

export const MAPS_CURRENT_LOCATION_TOOL_ID = "MapsCurrentLocation"

export const mapsCurrentLocationTool: ToolDef = {
  id: MAPS_CURRENT_LOCATION_TOOL_ID,
  name: MAPS_CURRENT_LOCATION_TOOL_ID,
  description: [
    "Return the current server-side location default for maps and location-aware monitors.",
    "Priority is the saved Home Assistant live location entity that represents the user, then saved profile location from USER.md. Browser geolocation is intentionally not available to tools; the Smart Maps page uses it only when the Home Assistant source is missing or unavailable.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {},
  },
  tags: ["maps", "location"],
}

export async function executeMapsCurrentLocation(): Promise<ToolResult> {
  try {
    const location = await resolveCurrentMapLocation()
    return {
      success: true,
      data: {
        location,
        configuredHomeAssistantSource:
          getConfiguredHomeAssistantLocationSource(),
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

export const MAPS_LIST_LOCATION_SOURCES_TOOL_ID = "MapsListLocationSources"

export const mapsListLocationSourcesTool: ToolDef = {
  id: MAPS_LIST_LOCATION_SOURCES_TOOL_ID,
  name: MAPS_LIST_LOCATION_SOURCES_TOOL_ID,
  description: [
    "List likely Home Assistant location entities (`person.*`, `device_tracker.*`, `zone.*`, and entities with latitude/longitude attributes).",
    "Use during Home Assistant onboarding after connection succeeds. Infer the user's person/device tracker and save a high-confidence match; ask only when candidates are ambiguous.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {},
  },
  tags: ["maps", "location", "home-assistant", "setup"],
}

export async function executeMapsListLocationSources(): Promise<ToolResult> {
  try {
    const candidates = await listHomeAssistantLocationCandidates()
    return {
      success: true,
      data: {
        configuredHomeAssistantSource:
          getConfiguredHomeAssistantLocationSource(),
        candidates,
        instruction:
          "Infer the current user's own person.* or device_tracker.* from profile/name, friendly name, entity id, and device naming. Save a single high-confidence match with MapsSetLocationSource; ask the user only if multiple candidates remain plausible. Smart Maps will use browser geolocation as fallback when no Home Assistant source is saved or resolvable.",
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

export const MAPS_SET_LOCATION_SOURCE_TOOL_ID = "MapsSetLocationSource"

export const mapsSetLocationSourceTool: ToolDef = {
  id: MAPS_SET_LOCATION_SOURCE_TOOL_ID,
  name: MAPS_SET_LOCATION_SOURCE_TOOL_ID,
  description: [
    "Persist the Home Assistant entity_id that represents the user as the default server-side live location source for Smart Maps, commute, geofence, and location-aware monitors.",
    "Call this after the model identifies a high-confidence user match, or after the user chooses among ambiguous candidates. Stores only the non-secret entity_id and optional label; it does not store GPS history.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      entityId: {
        type: "string",
        description:
          "Home Assistant entity_id inferred or chosen as the user location source, usually person.* or device_tracker.*.",
      },
      label: {
        type: "string",
        description: "Optional friendly label shown in Smart Maps.",
      },
    },
    required: ["entityId"],
  },
  tags: ["maps", "location", "home-assistant", "setup"],
}

export async function executeMapsSetLocationSource(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const entityId = typeof args.entityId === "string" ? args.entityId.trim() : ""
  const label = typeof args.label === "string" ? args.label.trim() : null
  if (!entityId)
    return {
      success: false,
      error: "MapsSetLocationSource requires a Home Assistant `entityId`.",
    }

  try {
    const validated = await validateHomeAssistantLocationEntity(entityId)
    const source = saveHomeAssistantLocationSource({
      entityId,
      label: label || validated.location.label,
    })
    return {
      success: true,
      data: {
        source,
        location: await resolveCurrentMapLocation(),
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// MapsPlaces — POI/place discovery.
//
// This is a data tool, not a renderer. It returns normalized Google Places
// hits plus `pinReady[]`; the orchestrator still owns composition and calls
// MapRender once it has decided which results belong on the map.
// ---------------------------------------------------------------------------

export const MAPS_PLACES_TOOL_ID = "MapsPlaces"

export const mapsPlacesTool: ToolDef = {
  id: MAPS_PLACES_TOOL_ID,
  name: MAPS_PLACES_TOOL_ID,
  description: [
    "Search Google Places API (New) for places/POIs and return normalized results plus MapRender-ready pins.",
    'Use `mode: "text"` for natural queries like "specialty coffee near me" or "hotels in Naxos"; pass `center` + `radiusMeters` to bias near a known location.',
    'Use `mode: "nearby"` for strict type-based searches around a coordinate; it requires `center` and at least one `includedTypes` or `includedPrimaryTypes` value such as "restaurant", "cafe", "hotel", "tourist_attraction".',
    'For "near me", call MapsCurrentLocation first and pass its `location.position` as `center`.',
    "Default field mask is cost-aware. Set `includeRatings: true` only when rating/ranking matters; set `includeWebsite: true` only when you need outbound website links; set `includePhotos: true` only for user-facing maps where thumbnails materially improve the answer.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["text", "nearby"],
        description:
          "Defaults to text when query is present, otherwise nearby.",
      },
      query: {
        type: "string",
        description:
          'Text Search query. Required for mode=text. Examples: "specialty coffee", "best hotels in Naxos", "pharmacy near me".',
      },
      center: {
        type: "array",
        description:
          "Optional/required search center as [longitude, latitude]. Required for mode=nearby; optional bias for mode=text.",
        items: { type: "number" },
      },
      radiusMeters: {
        type: "number",
        description:
          "Search circle radius in meters, 1..50000. Defaults to 2500.",
      },
      includedTypes: {
        type: "array",
        description:
          'Nearby Search place types. Up to 50. Examples: ["restaurant"], ["cafe"], ["tourist_attraction"].',
        items: { type: "string" },
      },
      includedPrimaryTypes: {
        type: "array",
        description: "Nearby Search primary place types. Up to 50.",
        items: { type: "string" },
      },
      excludedTypes: { type: "array", items: { type: "string" } },
      excludedPrimaryTypes: { type: "array", items: { type: "string" } },
      maxResults: {
        type: "number",
        description: "1..20 results. Defaults to 10.",
      },
      openNow: {
        type: "boolean",
        description:
          "When true, only return places open now where Google has opening-hours data.",
      },
      rankPreference: {
        type: "string",
        enum: ["relevance", "distance", "popularity"],
        description:
          "Text supports relevance/distance. Nearby supports distance/popularity. Invalid combinations are ignored.",
      },
      languageCode: {
        type: "string",
        description: "Optional BCP-47 language code, e.g. ro-RO or en-US.",
      },
      regionCode: {
        type: "string",
        description: "Optional CLDR region code, e.g. RO.",
      },
      pageToken: {
        type: "string",
        description:
          "Optional nextPageToken returned by a previous Places search.",
      },
      includeRatings: {
        type: "boolean",
        description:
          "Include rating and userRatingCount. This can raise the Places API billing SKU.",
      },
      includeWebsite: {
        type: "boolean",
        description:
          "Include websiteUri. This can raise the Places API billing SKU.",
      },
      includePhotos: {
        type: "boolean",
        description:
          "Resolve one https photo URL per returned place when available. This adds extra Places Media calls, so use sparingly for visual map results.",
      },
    },
  },
  tags: ["maps", "places"],
}

export async function executeMapsPlaces(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const inferredMode =
    typeof args.mode === "string"
      ? args.mode
      : typeof args.query === "string" && args.query.trim()
        ? "text"
        : "nearby"
  const mode = parsePlacesMode(inferredMode)
  if (!mode)
    return { success: false, error: 'mode must be "text" or "nearby".' }

  let center: MapCoordinate | undefined
  if (args.center !== undefined) {
    center = parseCoordinate(args.center) ?? undefined
  }
  if (args.center !== undefined && !center) {
    return {
      success: false,
      error: "center must be [lng (-180..180), lat (-90..90)].",
    }
  }
  const query = stringOption(args.query)
  if (mode === "text" && !query) {
    return {
      success: false,
      error: "MapsPlaces text search requires a non-empty `query`.",
    }
  }

  const rankPreference = parsePlacesRankPreference(args.rankPreference)
  if (args.rankPreference !== undefined && !rankPreference) {
    return {
      success: false,
      error: "rankPreference must be one of relevance, distance, popularity.",
    }
  }

  const includedTypes = stringListOption(args.includedTypes)
  const includedPrimaryTypes = stringListOption(args.includedPrimaryTypes)
  if (mode === "nearby" && !center) {
    return {
      success: false,
      error: "MapsPlaces nearby search requires `center` as [lng, lat].",
    }
  }
  if (
    mode === "nearby" &&
    !includedTypes?.length &&
    !includedPrimaryTypes?.length
  ) {
    return {
      success: false,
      error:
        "MapsPlaces nearby search requires at least one included type or primary type.",
    }
  }

  const options: PlacesSearchOptions = {
    mode,
    query,
    center,
    radiusMeters: numberOption(args.radiusMeters),
    includedTypes,
    includedPrimaryTypes,
    excludedTypes: stringListOption(args.excludedTypes),
    excludedPrimaryTypes: stringListOption(args.excludedPrimaryTypes),
    maxResults: numberOption(args.maxResults),
    openNow: args.openNow === true,
    rankPreference,
    languageCode: stringOption(args.languageCode),
    regionCode: stringOption(args.regionCode),
    pageToken: stringOption(args.pageToken),
    includeRatings: args.includeRatings === true,
    includeWebsite: args.includeWebsite === true,
    includePhotos: args.includePhotos === true,
  }

  try {
    const result = await searchPlaces(options)
    return {
      success: true,
      data: {
        ...result,
        hitCount: result.places.length,
        mapPins: result.pinReady,
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// MapsOptimizeStops — coordinate order optimizer.
//
// This is intentionally local and deterministic: it uses straight-line
// distance (nearest-neighbour seed + 2-opt refinement) to choose a sensible
// visit order, then returns `waypointPositions` ready for MapsDirections.
// It does not claim live-traffic optimality; MapsDirections remains the
// Google-backed step for real road geometry and ETA.
// ---------------------------------------------------------------------------

export const MAPS_OPTIMIZE_STOPS_TOOL_ID = "MapsOptimizeStops"

export const mapsOptimizeStopsTool: ToolDef = {
  id: MAPS_OPTIMIZE_STOPS_TOOL_ID,
  name: MAPS_OPTIMIZE_STOPS_TOOL_ID,
  description: [
    "Optimize the visit order for already-geocoded map stops using local straight-line distance.",
    "Use after MapsGeocode/MapsPlaces/MapsCurrentLocation and before MapsDirections when the user asks for an efficient order, errands route, or multi-stop plan.",
    "Returns orderedStops, stopOrder, and waypointPositions. Pass waypointPositions directly to MapsDirections for real route geometry/ETA, then paint the returned mapRoute in MapRender.",
    "This is not live-traffic optimization; it is a deterministic nearest-neighbor + 2-opt planner for small personal itineraries.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      stops: {
        type: "array",
        description:
          "Already-geocoded stops to reorder. Each stop needs position as [longitude, latitude]; id/label are preserved in the output.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            position: {
              type: "array",
              description: "[longitude, latitude]",
              items: { type: "number" },
            },
          },
          required: ["position"],
        },
      },
      start: {
        type: "array",
        description:
          'Optional fixed start coordinate as [longitude, latitude]. For "from me", call MapsCurrentLocation first and pass its position.',
        items: { type: "number" },
      },
      startLabel: { type: "string" },
      end: {
        type: "array",
        description:
          "Optional fixed end coordinate as [longitude, latitude]. Do not set together with returnToStart.",
        items: { type: "number" },
      },
      endLabel: { type: "string" },
      returnToStart: {
        type: "boolean",
        description:
          "When true, append the start point again as the final waypoint. Do not combine with end.",
      },
      preserveFirstStop: {
        type: "boolean",
        description:
          "When true and no explicit start is supplied, keep stops[0] as the first visit and optimize the remaining stops after it.",
      },
    },
    required: ["stops"],
  },
  tags: ["maps", "routing"],
}

export async function executeMapsOptimizeStops(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const rawStops = args.stops
  if (!Array.isArray(rawStops) || rawStops.length === 0) {
    return {
      success: false,
      error: "MapsOptimizeStops requires a non-empty `stops` array.",
    }
  }
  if (rawStops.length > MAX_DIRECTIONS_WAYPOINTS) {
    return {
      success: false,
      error: `MapsOptimizeStops accepts at most ${MAX_DIRECTIONS_WAYPOINTS} stops. Got ${rawStops.length}.`,
    }
  }

  const start =
    args.start === undefined ? undefined : (parseCoordinate(args.start) ?? null)
  if (start === null)
    return {
      success: false,
      error: "start must be [lng (-180..180), lat (-90..90)].",
    }
  const end =
    args.end === undefined ? undefined : (parseCoordinate(args.end) ?? null)
  if (end === null)
    return {
      success: false,
      error: "end must be [lng (-180..180), lat (-90..90)].",
    }
  const returnToStart = args.returnToStart === true
  if (end && returnToStart)
    return {
      success: false,
      error: "Set either end or returnToStart, not both.",
    }

  const stops: RouteOptimizerStop[] = []
  for (let i = 0; i < rawStops.length; i++) {
    const item = rawStops[i]
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        success: false,
        error: `stops.${i} must be an object with position.`,
      }
    }
    const record = item as Record<string, unknown>
    const position = parseCoordinate(record.position)
    if (!position)
      return {
        success: false,
        error: `stops.${i}.position must be [lng (-180..180), lat (-90..90)].`,
      }
    stops.push({
      id: stringOption(record.id),
      label: stringOption(record.label),
      position,
    })
  }

  const projectedWaypointCount =
    stops.length + (start ? 1 : 0) + (end || returnToStart ? 1 : 0)
  if (projectedWaypointCount < 2) {
    return {
      success: false,
      error:
        "MapsOptimizeStops needs at least two total route points after start/end options are applied.",
    }
  }
  if (projectedWaypointCount > MAX_DIRECTIONS_WAYPOINTS) {
    return {
      success: false,
      error: `The optimized route would contain ${projectedWaypointCount} waypoints; MapsDirections supports at most ${MAX_DIRECTIONS_WAYPOINTS}. Remove stops or avoid returnToStart/start/end duplication.`,
    }
  }

  const result = optimizeStopOrder(stops, {
    start: start ?? undefined,
    startLabel: stringOption(args.startLabel),
    end: end ?? undefined,
    endLabel: stringOption(args.endLabel),
    returnToStart,
    preserveFirstStop: args.preserveFirstStop === true,
  })

  return {
    success: true,
    data: {
      ...result,
      routeInstruction:
        "Pass `waypointPositions` to MapsDirections.waypoints, then add MapsDirections.bestRoute.mapRoute to MapRender.routes[].",
    },
  }
}

// ---------------------------------------------------------------------------
// MapsGeocode — address → coordinates.
//
// Accepts one address as a string, or a batch of up to 10. Returns one
// entry per input in the same order, each either a hit ({ position,
// formattedAddress, … }) or a miss ({ error }). The orchestrator should
// keep the misses in chat ("couldn't find X") rather than silently
// dropping them — partial maps with phantom missing items are worse UX
// than acknowledged gaps.
// ---------------------------------------------------------------------------

export const MAPS_GEOCODE_TOOL_ID = "MapsGeocode"
const MAX_GEOCODE_BATCH = 10

export const mapsGeocodeTool: ToolDef = {
  id: MAPS_GEOCODE_TOOL_ID,
  name: MAPS_GEOCODE_TOOL_ID,
  description: [
    "Resolve a list of addresses or place names to [longitude, latitude] coordinates via Google Geocoding API.",
    "Accepts up to 10 addresses per call. Returns one result per input in order — each entry has either { position, formattedAddress, placeId, locationType } on success or { error } on failure (no results, API not enabled, malformed query).",
    "Use this whenever you need to drop something on a map and only have an address or place name. Batch as many addresses as you have in a single call — it is dramatically cheaper than one call per address.",
    "Requires the **Geocoding API** to be enabled in the user's GCP project (separate enable step from Maps JavaScript API). On REQUEST_DENIED, surface the actionable error to the user and the activation URL from `MapsStatus`.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      addresses: {
        type: "array",
        description: `Up to ${MAX_GEOCODE_BATCH} address strings. Examples: "Strada Iuliu Maniu 5, Cluj-Napoca", "Piața Unirii, Cluj", "Cluj Airport".`,
        items: { type: "string" },
      },
      region: {
        type: "string",
        description:
          'Optional ccTLD region bias, e.g. "ro" to prefer Romanian results. Improves accuracy when addresses are terse.',
      },
    },
    required: ["addresses"],
  },
  tags: ["maps"],
}

export async function executeMapsGeocode(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const rawList = args.addresses
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return {
      success: false,
      error: "MapsGeocode requires a non-empty `addresses` array.",
    }
  }
  if (rawList.length > MAX_GEOCODE_BATCH) {
    return {
      success: false,
      error: `MapsGeocode accepts at most ${MAX_GEOCODE_BATCH} addresses per call. Got ${rawList.length}.`,
    }
  }
  const addresses: string[] = []
  for (const a of rawList) {
    if (typeof a !== "string" || a.trim().length === 0) {
      return {
        success: false,
        error: "Every address must be a non-empty string.",
      }
    }
    addresses.push(a.trim())
  }
  const region =
    typeof args.region === "string" && args.region.trim()
      ? args.region.trim()
      : undefined

  const results = await geocodeAddresses(addresses, { region })
  const hits = results.filter((r): r is GeocodeResult => !("error" in r))
  const misses = results.filter((r): r is GeocodeFailure => "error" in r)
  return {
    success: true,
    data: {
      results,
      hitCount: hits.length,
      missCount: misses.length,
      // Convenience flat array of just the hits, in input order, so
      // the orchestrator can drop it straight into a pins[] field
      // when every address resolved cleanly.
      pinReady: hits.map((h) => ({
        position: h.position,
        label: h.formattedAddress,
        placeId: h.placeId,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// MapsReverseGeocode — coordinates → address.
//
// Single-point lookup. Use when the orchestrator already has a [lng, lat]
// (from HA device_tracker, EXIF GPS, watchlist item, …) and needs a
// human-readable name to label a pin or describe a location to the user.
// ---------------------------------------------------------------------------

export const MAPS_REVERSE_GEOCODE_TOOL_ID = "MapsReverseGeocode"

export const mapsReverseGeocodeTool: ToolDef = {
  id: MAPS_REVERSE_GEOCODE_TOOL_ID,
  name: MAPS_REVERSE_GEOCODE_TOOL_ID,
  description: [
    "Resolve a [longitude, latitude] coordinate to a human-readable address via Google Geocoding API.",
    "Returns { position, formattedAddress, placeId, types } on success or { error } on failure.",
    "Use sparingly — single-point only. For batches, do client-side lookups via your own data sources first.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      position: {
        type: "array",
        description:
          "[longitude, latitude] — GeoJSON order. Latitude is the smaller-magnitude axis (-90..90).",
        items: { type: "number" },
      },
    },
    required: ["position"],
  },
  tags: ["maps"],
}

export async function executeMapsReverseGeocode(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const pos = args.position
  if (!Array.isArray(pos) || pos.length !== 2) {
    return {
      success: false,
      error: "MapsReverseGeocode requires `position` as a [lng, lat] pair.",
    }
  }
  const lng = Number(pos[0]),
    lat = Number(pos[1])
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    return {
      success: false,
      error:
        "position out of range — must be [lng (-180..180), lat (-90..90)].",
    }
  }
  const result = await reverseGeocode([lng, lat])
  return { success: true, data: result }
}

// ---------------------------------------------------------------------------
// MapsDirections — ordered waypoints → route geometry.
//
// Takes trusted coordinates and, when available, Google Place IDs. Address
// resolution still belongs in MapsGeocode / MapsPlaces so the orchestrator
// can inspect misses before routing, but Place IDs should be preserved because
// Google Routes can snap to the real routable place/entrance more accurately
// than a raw coordinate alone.
// ---------------------------------------------------------------------------

export const MAPS_DIRECTIONS_TOOL_ID = "MapsDirections"
const MAX_DIRECTIONS_WAYPOINTS = 25

export const mapsDirectionsTool: ToolDef = {
  id: MAPS_DIRECTIONS_TOOL_ID,
  name: MAPS_DIRECTIONS_TOOL_ID,
  description: [
    "Compute route geometry for 2-25 trusted waypoints via Google Routes API.",
    "Each waypoint can be [longitude, latitude] or { position: [longitude, latitude], placeId }. Prefer preserving Google Places placeId when you have one so routing targets the exact Google place, not only a raw coordinate.",
    "Use MapsGeocode/MapsPlaces first for addresses, then pass only trusted coordinates/place IDs here. The output includes routes[0].mapRoute and routes[0].fitBounds, ready to include in MapRender routes[] and day.fitBounds.",
    "Travel modes: driving (default), walking, bicycling, transit, two_wheeler. Driving/two_wheeler use traffic-aware routing.",
    "Requires the **Routes API** to be enabled in the same Google Maps Platform project as GOOGLE_MAPS_API_KEY.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      waypoints: {
        type: "array",
        description: `Ordered waypoints, each [longitude, latitude] or { position: [longitude, latitude], placeId }. Minimum 2, maximum ${MAX_DIRECTIONS_WAYPOINTS}.`,
        items: {
          type: "object",
          description:
            "Waypoint object. Use { position: [longitude, latitude], placeId? }. The executor also accepts bare [longitude, latitude] arrays for backward compatibility.",
          properties: {
            position: {
              type: "array",
              description: "[longitude, latitude]",
              items: { type: "number" },
            },
            placeId: {
              type: "string",
              description: "Google Place ID, when available.",
            },
          },
        },
      },
      travelMode: {
        type: "string",
        enum: ["driving", "walking", "bicycling", "transit", "two_wheeler"],
        description: "Defaults to driving.",
      },
      departureTime: {
        type: "string",
        description:
          "Optional RFC3339 departure timestamp. Do not set together with arrivalTime.",
      },
      arrivalTime: {
        type: "string",
        description:
          "Optional RFC3339 arrival timestamp. Transit only; do not set together with departureTime.",
      },
      avoidTolls: { type: "boolean" },
      avoidHighways: { type: "boolean" },
      avoidFerries: { type: "boolean" },
      regionCode: {
        type: "string",
        description: "Optional ccTLD region code, e.g. RO.",
      },
      languageCode: {
        type: "string",
        description: "Optional BCP-47 language code, e.g. ro-RO or en-US.",
      },
    },
    required: ["waypoints"],
  },
  tags: ["maps"],
}

export async function executeMapsDirections(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const rawWaypoints = args.waypoints
  if (!Array.isArray(rawWaypoints) || rawWaypoints.length < 2) {
    return {
      success: false,
      error: "MapsDirections requires at least two waypoints.",
    }
  }
  if (rawWaypoints.length > MAX_DIRECTIONS_WAYPOINTS) {
    return {
      success: false,
      error: `MapsDirections accepts at most ${MAX_DIRECTIONS_WAYPOINTS} waypoints. Got ${rawWaypoints.length}.`,
    }
  }

  const waypoints: MapsRouteWaypoint[] = []
  for (let i = 0; i < rawWaypoints.length; i++) {
    const parsed = parseRouteWaypoint(rawWaypoints[i], `waypoints.${i}`)
    if ("error" in parsed) return { success: false, error: parsed.error }
    waypoints.push(parsed.waypoint)
  }

  const travelMode = parseTravelMode(args.travelMode)
  if (args.travelMode !== undefined && !travelMode) {
    return {
      success: false,
      error:
        "travelMode must be one of driving, walking, bicycling, transit, two_wheeler.",
    }
  }
  if (
    typeof args.departureTime === "string" &&
    typeof args.arrivalTime === "string"
  ) {
    return {
      success: false,
      error: "Set either departureTime or arrivalTime, not both.",
    }
  }
  if (
    typeof args.arrivalTime === "string" &&
    args.arrivalTime.trim() &&
    (travelMode ?? "driving") !== "transit"
  ) {
    return {
      success: false,
      error: "arrivalTime is supported only when travelMode is transit.",
    }
  }

  const options: DirectionsOptions = {
    travelMode: travelMode ?? "driving",
    departureTime: stringOption(args.departureTime),
    arrivalTime: stringOption(args.arrivalTime),
    regionCode: stringOption(args.regionCode),
    languageCode: stringOption(args.languageCode),
    avoidTolls: args.avoidTolls === true,
    avoidHighways: args.avoidHighways === true,
    avoidFerries: args.avoidFerries === true,
  }

  try {
    const result = await computeDirections(waypoints, options)
    return {
      success: true,
      data: {
        ...result,
        bestRoute: result.routes[0],
        mapRoute: result.routes[0]?.mapRoute,
        fitBounds: result.routes[0]?.fitBounds,
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

export async function executeMapsStatus(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const refresh = args.refresh === true
  try {
    const status = await getMapsIntegrationStatus(!refresh)
    return {
      success: true,
      data: {
        configured: status.configured,
        connected: status.connected,
        needsReconnect: status.needsReconnect,
        keyEnvVar: "GOOGLE_MAPS_API_KEY",
        mapIdEnvVar: "GOOGLE_MAPS_MAP_ID",
        mapIdConfigured: status.mapIdConfigured,
        mapIdSource: status.mapIdSource,
        mapIdLabel: status.mapIdLabel,
        vectorMap: status.vectorMap,
        earth3d: status.earth3d,
        error: status.error,
      },
    }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

function parseCoordinate(value: unknown): MapCoordinate | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const lng = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null
  return [lng, lat]
}

function parseRouteWaypoint(
  value: unknown,
  path: string
): { waypoint: MapsRouteWaypoint } | { error: string } {
  const coordinate = parseCoordinate(value)
  if (coordinate) return { waypoint: { position: coordinate } }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `${path} must be [lng (-180..180), lat (-90..90)] or { position: [lng, lat], placeId }.`,
    }
  }

  const record = value as { position?: unknown; placeId?: unknown }
  let position: MapCoordinate | undefined
  if (record.position !== undefined) {
    const parsedPosition = parseCoordinate(record.position)
    if (!parsedPosition) {
      return {
        error: `${path}.position must be [lng (-180..180), lat (-90..90)].`,
      }
    }
    position = parsedPosition
  }

  const placeId = parsePlaceId(record.placeId)
  if (record.placeId !== undefined && !placeId) {
    return { error: `${path}.placeId must be a non-empty string.` }
  }
  if (!position && !placeId) {
    return { error: `${path} must include position or placeId.` }
  }

  const waypoint: MapsRouteWaypoint = {}
  if (position) waypoint.position = position
  if (placeId) waypoint.placeId = placeId
  return { waypoint }
}

function parsePlaceId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cleaned = value.trim().replace(/^places\//, "")
  return cleaned ? cleaned.slice(0, 256) : null
}

function parsePlacesMode(value: unknown): PlacesSearchMode | null {
  if (value === "text" || value === "nearby") return value
  return null
}

function parsePlacesRankPreference(
  value: unknown
): PlacesRankPreference | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value === "relevance" || value === "distance" || value === "popularity")
    return value
  return undefined
}

function parseTravelMode(value: unknown): MapsTravelMode | null {
  if (value === undefined || value === null || value === "") return null
  if (
    value === "driving" ||
    value === "walking" ||
    value === "bicycling" ||
    value === "transit" ||
    value === "two_wheeler"
  ) {
    return value
  }
  return null
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function stringListOption(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50)
  return out.length > 0 ? out : undefined
}
