/**
 * Smoke test for the map artifact pure-logic surface.
 *
 * Covers:
 *   - Schema parses minimal and rich valid inputs (defaults applied).
 *   - Schema rejects malformed inputs with a useful error path.
 *   - Extended pin fields (photoUrl, address, rating, flexible icon).
 *   - MapRender tool returns canonical body + direct-emits-as-artifact hint.
 *   - MapsGeocode / MapsReverseGeocode / MapsPlaces / MapsOptimizeStops / MapsDirections input validation.
 *   - Orchestrator-only Maps tool grants.
 *   - Saved places / areas / Smart Maps persistence round-trips.
 *   - Maps API response headers for non-cacheable config and saved-map metadata.
 *   - Env-key helper.
 *
 * No network — the renderer (Google Maps JavaScript API loaded inside a
 * sandboxed iframe) is verified by browser preview; here we cover
 * everything the model can break by emitting a bad artifact JSON.
 *
 * Run: npx tsx scripts/smoke-maps.ts
 */
import { randomUUID } from "crypto"

import { GET as mapsConfigApiGet } from "@/app/api/maps/config/route"
import { GET as mapsIntegrationConfigApiGet } from "@/app/api/integrations/maps/config/route"
import { POST as mapsStaticApiPost } from "@/app/api/maps/static/route"
import {
  GET as mapsArtifactsApiGet,
  POST as mapsArtifactsApiPost,
} from "@/app/api/maps/artifacts/route"
import { POST as directionsApiPost } from "@/app/api/maps/directions/route"
import { GET as savedAreasApiGet } from "@/app/api/maps/saved-areas/route"
import { GET as savedPlacesApiGet } from "@/app/api/maps/saved-places/route"
import { getAllAgents } from "@/lib/ai/agents/registry"
import { MAPS_TOOL_IDS } from "@/lib/ai/agents/builtins"
import { isOrchestratorClassAgent } from "@/lib/ai/agents/orchestrator-class"
import { executeTool } from "@/lib/ai/tools/executor"
import { MapArtifactSchema, parseMapArtifact } from "@/lib/maps/schema"
import { readGoogleMapsApiKey } from "@/lib/maps/google-session"
import { normalizeRouteWaypoints } from "@/lib/maps/google-routes"
import { buildGoogleStaticMapUrl } from "@/lib/maps/static-map"
import {
  deleteStaticMapCacheEntry,
  getStaticMapCacheKey,
  readStaticMapCache,
  writeStaticMapCache,
} from "@/lib/maps/static-map-cache"
import {
  deleteSmartMapArtifact,
  saveSmartMapArtifact,
  SMART_MAPS_CONVERSATION_ID,
} from "@/lib/maps/saved-map-artifacts"
import {
  addSavedMapPlace,
  deleteSavedMapPlace,
  getSavedMapPlace,
  listSavedMapPlaces,
  updateSavedMapPlaceNotes,
} from "@/lib/maps/saved-places"
import {
  addSavedMapArea,
  deleteSavedMapArea,
  getSavedMapArea,
  listSavedMapAreas,
  updateSavedMapArea,
} from "@/lib/maps/saved-areas"
import {
  executeMapRender,
  executeMapsDirections,
  executeMapsGeocode,
  executeMapsOptimizeStops,
  executeMapsPlaces,
  executeMapsReverseGeocode,
  mapRenderTool,
} from "@/lib/ai/tools/maps"

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
  const ok = Boolean(cond)
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`
  )
  if (!ok) failures++
}

// --- schema: minimal valid -------------------------------------------------

const minimalRaw = JSON.stringify({
  viewport: { center: [23.6, 46.77], zoom: 12 },
  pins: [{ id: "p1", position: [23.6, 46.77], label: "Cluj" }],
})
{
  const r = parseMapArtifact(minimalRaw)
  check("schema: minimal input parses", r.ok)
  if (r.ok) {
    check(
      "schema: basemap defaults to satellite",
      r.value.basemap === "satellite",
      r.value.basemap
    )
    check(
      "schema: routes/polygons default to empty arrays",
      Array.isArray(r.value.routes) &&
        r.value.routes.length === 0 &&
        Array.isArray(r.value.polygons) &&
        r.value.polygons.length === 0
    )
    check(
      "schema: days stays undefined when not provided",
      r.value.days === undefined
    )
  }
}

// --- schema: rich valid (trip planner shape) -------------------------------

// --- schema: extended pin fields (photoUrl, address, rating, flexible icon) ---

{
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [23.5894, 46.7712], zoom: 14 },
      pins: [
        {
          id: "unagi",
          position: [23.5894, 46.7704],
          label: "Unagi",
          address: "Strada Iuliu Maniu 7, Cluj",
          description: "Specialty coffee + light bites",
          photoUrl: "https://example.com/photo.jpg",
          rating: 4.7,
          savedPlaceId: "local-saved-place-id",
          notes: "Try the back patio.",
          color: "#22c55e",
          icon: "coffee",
        },
      ],
    })
  )
  check("schema: extended pin fields parse", r.ok)
  if (r.ok) {
    const pin = r.value.pins[0]
    check(
      "schema: photoUrl preserved",
      pin.photoUrl === "https://example.com/photo.jpg"
    )
    check(
      "schema: address preserved",
      pin.address === "Strada Iuliu Maniu 7, Cluj"
    )
    check("schema: rating preserved", pin.rating === 4.7)
    check("schema: canonical icon preserved", pin.icon === "coffee")
    check(
      "schema: savedPlaceId preserved",
      pin.savedPlaceId === "local-saved-place-id"
    )
    check("schema: notes preserved", pin.notes === "Try the back patio.")
  }
}

{
  // Icon is now free-form string — unknown icons must NOT fail validation;
  // the renderer falls back to default. This is the model-friendliness fix.
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "x", position: [0, 0], icon: "a-totally-novel-icon-name" }],
    })
  )
  check("schema: unknown icon does NOT trigger validation error", r.ok)
}

{
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [23.6, 46.77], zoom: 14 },
      pins: [{ id: "p", position: [23.6, 46.77] }],
      routes: [
        {
          id: "walk-leg",
          coordinates: [
            [23.6, 46.77],
            [23.601, 46.771],
          ],
          style: "dashed",
        },
      ],
    })
  )
  check(
    "schema: route style preserved",
    r.ok && r.value.routes[0]?.style === "dashed"
  )
}

// --- static map URL generation --------------------------------------------

{
  const built = buildGoogleStaticMapUrl({ source: minimalRaw }, "test-key")
  const url = new URL(built.url)
  check("StaticMap: uses Google Static Maps endpoint", url.hostname === "maps.googleapis.com")
  check("StaticMap: keeps key server-side in generated upstream URL", url.searchParams.get("key") === "test-key")
  check("StaticMap: defaults to 640x360@2x", url.searchParams.get("size") === "640x360" && url.searchParams.get("scale") === "2")
  check("StaticMap: defaults to satellite", url.searchParams.get("maptype") === "satellite")
  check("StaticMap: emits one marker", built.markerCount === 1)
  check("StaticMap: converts [lng,lat] to Google lat,lng", (url.searchParams.get("markers") ?? "").includes("46.77,23.6"))
}

{
  const built = buildGoogleStaticMapUrl(
    {
      artifact: {
        viewport: { center: [23.6, 46.77], zoom: 12 },
        basemap: "satellite-streets",
        days: [
          {
            id: "day-1",
            label: "Day 1",
            pins: [{ id: "a", position: [23.61, 46.78], label: "A" }],
            routes: [
              {
                id: "r1",
                coordinates: [
                  [23.61, 46.78],
                  [23.62, 46.79],
                ],
              },
            ],
          },
        ],
      },
      dayId: "day-1",
      width: 320,
      height: 180,
    },
    "test-key"
  )
  const url = new URL(built.url)
  check("StaticMap: satellite-streets maps to hybrid", url.searchParams.get("maptype") === "hybrid")
  check("StaticMap: selected day contributes marker", built.markerCount === 1)
  check("StaticMap: selected day contributes route path", built.pathCount === 1)
  check("StaticMap: custom size applied", url.searchParams.get("size") === "320x180")
}

{
  let failed = false
  try {
    buildGoogleStaticMapUrl({ source: "{not-json" }, "test-key")
  } catch {
    failed = true
  }
  check("StaticMap: rejects invalid JSON source", failed)
}

{
  const built = buildGoogleStaticMapUrl({ source: minimalRaw }, "cache-test-key")
  const cacheKey = getStaticMapCacheKey(built.url)
  deleteStaticMapCacheEntry(built.url)
  writeStaticMapCache(
    built.url,
    Buffer.from("static-map-cache-smoke"),
    "image/png"
  )
  const cached = readStaticMapCache(built.url)
  check(
    "StaticMap cache: key is opaque and does not leak provider key",
    /^[a-f0-9]{64}$/.test(cacheKey) && !cacheKey.includes("cache-test-key"),
    cacheKey
  )
  check(
    "StaticMap cache: reads written image bytes",
    cached?.bytes.toString("utf8") === "static-map-cache-smoke",
    cached?.bytes.toString("utf8")
  )
  check(
    "StaticMap cache: preserves content type",
    cached?.contentType === "image/png",
    cached?.contentType
  )
  deleteStaticMapCacheEntry(built.url)
}

{
  // Rating out of range still rejected.
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "x", position: [0, 0], rating: 7 }],
    })
  )
  check("schema: rejects rating > 5", !r.ok && /rating/.test(r.error ?? ""))
}

{
  // photoUrl must be a valid URL.
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "x", position: [0, 0], photoUrl: "not a url" }],
    })
  )
  check(
    "schema: rejects malformed photoUrl",
    !r.ok && /photoUrl/.test(r.error ?? "")
  )
}

for (const [field, value] of [
  ["photoUrl", "http://example.com/insecure.jpg"],
  ["photoUrl", "javascript:alert(1)"],
  ["websiteUri", "javascript:alert(1)"],
  ["sourceUrl", "data:text/html,hi"],
  ["googleMapsUri", "ftp://example.com/place"],
] as const) {
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "x", position: [0, 0], [field]: value }],
    })
  )
  check(
    `schema: rejects unsafe ${field} scheme`,
    !r.ok && new RegExp(field).test(r.error ?? ""),
    r
  )
}

{
  const r = parseMapArtifact(
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "x", position: [0, 0], websiteUri: "http://example.com" }],
    })
  )
  check("schema: allows http(s) non-image links", r.ok, r)
}

const tripRaw = JSON.stringify({
  viewport: { center: [25.97, 44.43], zoom: 11, pitch: 30, bearing: -15 },
  basemap: "satellite-streets",
  pins: [
    {
      id: "home",
      position: [26.1, 44.42],
      label: "Home",
      icon: "star",
      color: "#22c55e",
    },
  ],
  routes: [
    {
      id: "commute",
      coordinates: [
        [26.1, 44.42],
        [26.08, 44.43],
        [26.06, 44.45],
      ],
      color: "#3b82f6",
      width: 5,
    },
  ],
  polygons: [
    {
      id: "sector1",
      rings: [
        [
          [26.05, 44.45],
          [26.12, 44.45],
          [26.12, 44.52],
          [26.05, 44.52],
          [26.05, 44.45],
        ],
      ],
      fillOpacity: 0.2,
    },
  ],
  days: [
    {
      id: "d1",
      label: "Day 1 — Arrival",
      date: "2026-06-12",
      startTime: "14:00",
      endTime: "19:00",
      summary: "Arrival, hotel check-in, and an easy first dinner.",
      pins: [{ id: "hotel", position: [26.1, 44.43] }],
      routes: [],
    },
    {
      id: "d2",
      label: "Day 2 — Old Town",
      fitBounds: [26.08, 44.42, 26.12, 44.45],
      pins: [
        { id: "curtea", position: [26.1, 44.43], icon: "flag" },
        { id: "palatul", position: [26.09, 44.435] },
      ],
      routes: [],
    },
  ],
  attribution: "Itinerary by Orchestrator",
})
{
  const r = parseMapArtifact(tripRaw)
  check("schema: trip planner input parses", r.ok)
  if (r.ok) {
    check("schema: pitch is preserved", r.value.viewport.pitch === 30)
    check("schema: bearing is preserved", r.value.viewport.bearing === -15)
    check("schema: trip planner has 2 days", r.value.days?.length === 2)
    check(
      "schema: day metadata preserved",
      r.value.days?.[0]?.date === "2026-06-12" &&
        r.value.days?.[0]?.startTime === "14:00" &&
        r.value.days?.[0]?.summary ===
          "Arrival, hotel check-in, and an easy first dinner."
    )
    check(
      "schema: day fitBounds preserved",
      r.value.days?.[1]?.fitBounds?.[0] === 26.08 &&
        r.value.days?.[1]?.fitBounds?.[3] === 44.45
    )
  }
}

// --- schema: rejections ----------------------------------------------------

const badCases: Array<[string, string, RegExp]> = [
  ["rejects non-JSON", "{not json", /Invalid JSON/],
  ["rejects missing viewport", JSON.stringify({}), /viewport/],
  [
    "rejects out-of-range latitude",
    JSON.stringify({ viewport: { center: [10, 99], zoom: 5 } }),
    /viewport\.center/,
  ],
  [
    "rejects out-of-range zoom",
    JSON.stringify({ viewport: { center: [0, 0], zoom: 30 } }),
    /viewport\.zoom/,
  ],
  [
    "rejects bad basemap",
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      basemap: "pirate-map",
    }),
    /basemap/,
  ],
  [
    "rejects empty map with no features",
    JSON.stringify({ viewport: { center: [0, 0], zoom: 5 } }),
    /pins/,
  ],
  [
    "rejects retired basemap (streets)",
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      basemap: "streets",
    }),
    /basemap/,
  ],
  [
    "rejects pin without id",
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ position: [0, 0] }],
    }),
    /pins\.0\.id/,
  ],
  [
    "rejects bad colour",
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      pins: [{ id: "a", position: [0, 0], color: "red" }],
    }),
    /pins\.0\.color/,
  ],
  [
    "rejects route with fewer than 2 coords",
    JSON.stringify({
      viewport: { center: [0, 0], zoom: 5 },
      routes: [{ id: "r", coordinates: [[0, 0]] }],
    }),
    /routes\.0\.coordinates/,
  ],
]
for (const [label, raw, pathRe] of badCases) {
  const r = parseMapArtifact(raw)
  const matched = !r.ok && pathRe.test(r.error)
  check(`schema: ${label}`, matched, r.ok ? "unexpectedly parsed" : r.error)
}

// --- saved places persistence ---------------------------------------------

{
  const suffix = randomUUID()
  const placeId = `smoke-place-${suffix}`
  const first = addSavedMapPlace({
    title: `Smoke Saved Place ${suffix}`,
    address: "Piața Unirii, Cluj-Napoca",
    description: "Temporary smoke-test location.",
    position: [23.5894, 46.7704],
    placeId,
    googleMapsUri: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
    websiteUri: "javascript:alert(1)",
    sourceUrl: "data:text/html,hi",
    photoUrl: "http://example.com/insecure.jpg",
    rating: 4.6,
    userRatingCount: 42,
    openNow: true,
    phoneNumber: "+40 700 000 000",
  })
  check(
    "SavedPlaces: add returns id",
    typeof first.id === "string" && first.id.length > 0
  )
  check(
    "SavedPlaces: add preserves tuple position",
    first.position[0] === 23.5894 && first.position[1] === 46.7704,
    first.position
  )
  check(
    "SavedPlaces: strips unsafe URLs",
    first.websiteUri === null &&
      first.sourceUrl === null &&
      first.photoUrl === null,
    first
  )

  const fetched = getSavedMapPlace(first.id)
  check(
    "SavedPlaces: get round-trip works",
    fetched?.placeId === placeId,
    fetched
  )

  const updated = addSavedMapPlace({
    title: `Smoke Saved Place Updated ${suffix}`,
    address: "Updated address",
    position: [23.5895, 46.7705],
    placeId,
    notes: "Keep existing note test.",
  })
  check("SavedPlaces: upsert preserves id", updated.id === first.id, {
    first: first.id,
    updated: updated.id,
  })
  check(
    "SavedPlaces: upsert updates title",
    updated.title === `Smoke Saved Place Updated ${suffix}`,
    updated.title
  )
  const withNotes = updateSavedMapPlaceNotes(
    first.id,
    "Remember the upstairs room."
  )
  check(
    "SavedPlaces: notes update returns place",
    withNotes?.notes === "Remember the upstairs room.",
    withNotes
  )
  const clearedNotes = updateSavedMapPlaceNotes(first.id, "")
  check(
    "SavedPlaces: blank notes clears to null",
    clearedNotes?.notes === null,
    clearedNotes
  )
  check(
    "SavedPlaces: list includes saved place",
    listSavedMapPlaces(500).some((place) => place.id === first.id)
  )
  check("SavedPlaces: delete returns true", deleteSavedMapPlace(first.id))
  check(
    "SavedPlaces: deleted place is gone",
    getSavedMapPlace(first.id) === null
  )
  check(
    "SavedPlaces: second delete returns false",
    !deleteSavedMapPlace(first.id)
  )
}

// --- saved Smart Maps artifacts -------------------------------------------

{
  const suffix = randomUUID()
  const artifact = saveSmartMapArtifact({
    title: `Smoke Smart Map ${suffix}`,
    identifier: `smoke-smart-map-${suffix.slice(0, 8)}`,
    content: JSON.stringify({
      viewport: { center: [23.5894, 46.7712], zoom: 14 },
      pins: [{ id: "pin", position: [23.5894, 46.7712], label: "Smoke pin" }],
    }),
  })
  check(
    "SavedSmartMap: saves into Smart Maps conversation",
    artifact.conversationId === SMART_MAPS_CONVERSATION_ID,
    artifact.conversationId
  )
  check(
    "SavedSmartMap: delete returns true",
    deleteSmartMapArtifact(artifact.id)
  )
  check(
    "SavedSmartMap: second delete returns false",
    !deleteSmartMapArtifact(artifact.id)
  )
}

// --- maps API response metadata -------------------------------------------

{
  const configResponse = await mapsConfigApiGet(
    new Request("http://127.0.0.1/api/maps/config", {
      headers: { host: "127.0.0.1" },
    })
  )
  check(
    "/api/maps/config: never cache client key config",
    /no-store/i.test(configResponse.headers.get("cache-control") ?? ""),
    configResponse.headers.get("cache-control")
  )

  const integrationConfigResponse = mapsIntegrationConfigApiGet(
    new Request("http://127.0.0.1/api/integrations/maps/config", {
      headers: { host: "127.0.0.1" },
    })
  )
  const integrationConfigBody = (await integrationConfigResponse.json()) as {
    maps?: Record<string, unknown>
  }
  check(
    "/api/integrations/maps/config GET: never caches sidebar config",
    /no-store/i.test(
      integrationConfigResponse.headers.get("cache-control") ?? ""
    ),
    integrationConfigResponse.headers.get("cache-control")
  )
  check(
    "/api/integrations/maps/config GET: returns only non-secret metadata",
    integrationConfigResponse.status === 200 &&
      typeof integrationConfigBody.maps?.configured === "boolean" &&
      !("key" in (integrationConfigBody.maps ?? {})) &&
      !("apiKey" in (integrationConfigBody.maps ?? {})),
    integrationConfigBody
  )

  const listResponse = await mapsArtifactsApiGet(
    new Request("http://127.0.0.1/api/maps/artifacts?limit=999999", {
      headers: { host: "127.0.0.1" },
    })
  )
  const listBody = (await listResponse.json()) as { maps?: unknown[] }
  check(
    "/api/maps/artifacts GET: never caches map library",
    /no-store/i.test(listResponse.headers.get("cache-control") ?? ""),
    listResponse.headers.get("cache-control")
  )
  check(
    "/api/maps/artifacts GET: returns a bounded map list",
    listResponse.status === 200 &&
      Array.isArray(listBody.maps) &&
      listBody.maps.length <= 250,
    listBody
  )

  const staticMapInvalidBodyResponse = await mapsStaticApiPost(
    new Request("http://127.0.0.1/api/maps/static", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: "null",
    })
  )
  check(
    "/api/maps/static POST: rejects non-object bodies before provider calls",
    staticMapInvalidBodyResponse.status === 400,
    staticMapInvalidBodyResponse.status
  )
  check(
    "/api/maps/static POST: validation errors are not cacheable",
    /no-store/i.test(
      staticMapInvalidBodyResponse.headers.get("cache-control") ?? ""
    ),
    staticMapInvalidBodyResponse.headers.get("cache-control")
  )

  const response = await mapsArtifactsApiPost(
    new Request("http://127.0.0.1/api/maps/artifacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({
        title: "Smoke API Saved Map",
        identifier: `smoke-api-map-${randomUUID().slice(0, 8)}`,
        content: JSON.stringify({
          viewport: { center: [23.5894, 46.7712], zoom: 14 },
          pins: [
            {
              id: "pin",
              position: [23.5894, 46.7712],
              label: "Smoke API pin",
            },
          ],
        }),
      }),
    })
  )
  const body = (await response.json()) as {
    map?: { id?: string; deletable?: boolean }
    error?: string
  }
  check(
    "/api/maps/artifacts POST: returns deletable Smart Maps item",
    response.status === 200 &&
      typeof body.map?.id === "string" &&
      body.map.deletable === true,
    body
  )
  if (body.map?.id) {
    check(
      "/api/maps/artifacts POST: cleanup saved map succeeds",
      deleteSmartMapArtifact(body.map.id)
    )
  }

  const savedPlacesListResponse = await savedPlacesApiGet(
    new Request("http://127.0.0.1/api/maps/saved-places?limit=999999", {
      headers: { host: "127.0.0.1" },
    })
  )
  const savedPlacesListBody = (await savedPlacesListResponse.json()) as {
    places?: unknown[]
  }
  check(
    "/api/maps/saved-places GET: returns a bounded list",
    savedPlacesListResponse.status === 200 &&
      Array.isArray(savedPlacesListBody.places) &&
      savedPlacesListBody.places.length <= 500,
    savedPlacesListBody
  )

  const savedAreasListResponse = await savedAreasApiGet(
    new Request("http://127.0.0.1/api/maps/saved-areas?limit=999999", {
      headers: { host: "127.0.0.1" },
    })
  )
  const savedAreasListBody = (await savedAreasListResponse.json()) as {
    areas?: unknown[]
  }
  check(
    "/api/maps/saved-areas GET: returns a bounded list",
    savedAreasListResponse.status === 200 &&
      Array.isArray(savedAreasListBody.areas) &&
      savedAreasListBody.areas.length <= 500,
    savedAreasListBody
  )
}

// --- saved areas persistence ----------------------------------------------

{
  const suffix = randomUUID()
  const ring: Array<[number, number]> = [
    [23.58, 46.76],
    [23.6, 46.76],
    [23.6, 46.78],
    [23.58, 46.78],
  ]
  const first = addSavedMapArea({
    title: `Smoke Saved Area ${suffix}`,
    description: "Temporary smoke-test polygon.",
    ring,
    color: "#1a73e8",
    notes: "Area notes.",
  })
  check(
    "SavedAreas: add returns id",
    typeof first.id === "string" && first.id.length > 0
  )
  check(
    "SavedAreas: computes bbox",
    first.bbox[0] === 23.58 && first.bbox[3] === 46.78,
    first.bbox
  )
  check(
    "SavedAreas: get round-trip works",
    getSavedMapArea(first.id)?.title === `Smoke Saved Area ${suffix}`
  )

  const updated = updateSavedMapArea(first.id, {
    title: `Smoke Saved Area Updated ${suffix}`,
    notes: null,
  })
  check(
    "SavedAreas: update returns area",
    updated?.title === `Smoke Saved Area Updated ${suffix}`,
    updated
  )
  check(
    "SavedAreas: list includes saved area",
    listSavedMapAreas(500).some((area) => area.id === first.id)
  )
  check("SavedAreas: delete returns true", deleteSavedMapArea(first.id))
  check("SavedAreas: deleted area is gone", getSavedMapArea(first.id) === null)
  check(
    "SavedAreas: second delete returns false",
    !deleteSavedMapArea(first.id)
  )
}

// --- env key helper --------------------------------------------------------
//
// The tile pipeline is gone (Maps JS API loads client-side from Google's
// CDN). Server side, all we need is the env-key reader to gate Geocoding
// and the integrations status probe.

{
  const key = readGoogleMapsApiKey()
  check(
    "env: readGoogleMapsApiKey returns string or null",
    key === null || typeof key === "string"
  )
}

// --- schema: defaults are applied even when fields omitted -----------------

{
  const raw = JSON.stringify({
    viewport: { center: [0, 0], zoom: 1 },
    pins: [{ id: "origin", position: [0, 0] }],
  })
  const parsed = MapArtifactSchema.safeParse(JSON.parse(raw))
  check(
    "schema (direct): defaults applied via safeParse",
    parsed.success &&
      parsed.data.basemap === "satellite" &&
      parsed.data.routes.length === 0 &&
      parsed.data.polygons.length === 0
  )
}

// --- MapRender tool --------------------------------------------------------

{
  const ok = executeMapRender({
    identifier: "cluj-overview",
    title: "Cluj Overview",
    viewport: { center: [23.5894, 46.7712], zoom: 13 },
    pins: [
      { id: "unirii", position: [23.5894, 46.7704], label: "Piața Unirii" },
    ],
  })
  check("MapRender: valid payload returns success", ok.success)
  if (ok.success && ok.data) {
    const data = ok.data as Record<string, unknown>
    check("MapRender: returns identifier", data.identifier === "cluj-overview")
    check("MapRender: returns type", data.type === "application/vnd.ant.map")
    check("MapRender: returns inline display", data.display === "inline")
    check("MapRender: requests direct emit", data.directEmit === true)
    check(
      "MapRender: body is a JSON string",
      typeof data.body === "string" && (data.body as string).startsWith("{")
    )
    check(
      "MapRender: usage embeds the artifact tag",
      typeof data.usage === "string" &&
        (data.usage as string).includes("<artifact")
    )
  }
}

{
  const badId = executeMapRender({
    identifier: "Bad Id",
    title: "T",
    viewport: { center: [0, 0], zoom: 1 },
  })
  check(
    "MapRender: rejects non-kebab-case identifier",
    !badId.success && /kebab-case/.test(badId.error ?? "")
  )

  const missingTitle = executeMapRender({
    identifier: "x",
    title: "",
    viewport: { center: [0, 0], zoom: 1 },
  })
  check(
    "MapRender: rejects empty title",
    !missingTitle.success && /title/.test(missingTitle.error ?? "")
  )

  const badCoords = executeMapRender({
    identifier: "x",
    title: "T",
    viewport: { center: [200, 0], zoom: 1 },
  })
  check(
    "MapRender: rejects out-of-range lng",
    !badCoords.success && /viewport\.center/.test(badCoords.error ?? "")
  )
}

// --- orchestrator-only tool grant -----------------------------------------

{
  const agents = getAllAgents()
  const orchestratorClassAgents = agents.filter((agent) =>
    isOrchestratorClassAgent(agent.id)
  )
  const nonOrchestratorClassMapsTools = agents
    .filter((agent) => !isOrchestratorClassAgent(agent.id))
    .flatMap((agent) =>
      agent.tools
        .filter((toolId) => MAPS_TOOL_IDS.includes(toolId))
        .map((toolId) => `${agent.id}:${toolId}`)
    )
  const orchestratorAgent = agents.find((agent) => agent.id === "orchestrator")
  check(
    "Agent grants: orchestrator has every Maps tool",
    MAPS_TOOL_IDS.every((toolId) => orchestratorAgent?.tools.includes(toolId)),
    orchestratorAgent?.tools
  )
  check(
    "Agent grants: orchestrator-class agents have every Maps tool",
    orchestratorClassAgents.every((agent) =>
      MAPS_TOOL_IDS.every((toolId) => agent.tools.includes(toolId))
    ),
    orchestratorClassAgents.map((agent) => [agent.id, agent.tools])
  )
  check(
    "Agent grants: non-orchestrator-class agents have no Maps tools",
    nonOrchestratorClassMapsTools.length === 0,
    nonOrchestratorClassMapsTools
  )

  const renderArgs = {
    identifier: "runtime-guard-map",
    title: "Runtime Guard Map",
    viewport: { center: [23.5894, 46.7712], zoom: 14 },
    pins: [{ id: "pin", position: [23.5894, 46.7712], label: "Guard pin" }],
  }
  const blocked = await executeTool(mapRenderTool, renderArgs, {
    callerAgentId: "researcher",
    depth: 1,
    conversationId: "smoke-maps",
    parentRequestId: "smoke-parent",
  })
  check(
    "Agent grants: runtime blocks non-orchestrator MapRender",
    !blocked.success && /orchestrator-only/.test(blocked.error ?? ""),
    blocked
  )
  const blockedWithoutContext = await executeTool(mapRenderTool, renderArgs)
  check(
    "Agent grants: runtime blocks Maps tools without caller context",
    !blockedWithoutContext.success &&
      /orchestrator-only/.test(blockedWithoutContext.error ?? ""),
    blockedWithoutContext
  )
  const allowed = await executeTool(mapRenderTool, renderArgs, {
    callerAgentId: "orchestrator",
    depth: 0,
    conversationId: "smoke-maps",
    parentRequestId: "smoke-parent",
  })
  check(
    "Agent grants: runtime allows orchestrator MapRender",
    allowed.success,
    allowed
  )
  const aliasAllowed = await executeTool(mapRenderTool, renderArgs, {
    callerAgentId: "inbox-agent",
    depth: 0,
    conversationId: "smoke-maps",
    parentRequestId: "smoke-parent",
  })
  check(
    "Agent grants: runtime allows orchestrator-class MapRender",
    aliasAllowed.success,
    aliasAllowed
  )
}

// --- MapsGeocode / MapsReverseGeocode input validation --------------------

{
  const empty = await executeMapsGeocode({ addresses: [] })
  check(
    "MapsGeocode: rejects empty addresses array",
    !empty.success && /non-empty/.test(empty.error ?? "")
  )

  const over = await executeMapsGeocode({ addresses: Array(11).fill("x") })
  check(
    "MapsGeocode: rejects > 10 addresses",
    !over.success && /at most/.test(over.error ?? "")
  )

  const blank = await executeMapsGeocode({
    addresses: ["Cluj", "", "București"],
  })
  check(
    "MapsGeocode: rejects blank address in batch",
    !blank.success && /non-empty string/.test(blank.error ?? "")
  )

  const badType = await executeMapsGeocode({
    addresses: ["Cluj", 42 as unknown as string],
  })
  check(
    "MapsGeocode: rejects non-string address",
    !badType.success && /non-empty string/.test(badType.error ?? "")
  )
}

{
  const badShape = await executeMapsReverseGeocode({ position: [25] })
  check(
    "MapsReverseGeocode: rejects non-pair position",
    !badShape.success && /lng, lat/.test(badShape.error ?? "")
  )

  const oor = await executeMapsReverseGeocode({ position: [200, 0] })
  check(
    "MapsReverseGeocode: rejects out-of-range lng",
    !oor.success && /out of range/.test(oor.error ?? "")
  )

  const oorLat = await executeMapsReverseGeocode({ position: [0, 100] })
  check(
    "MapsReverseGeocode: rejects out-of-range lat",
    !oorLat.success && /out of range/.test(oorLat.error ?? "")
  )
}

// --- MapsPlaces input validation ------------------------------------------

{
  const missingQuery = await executeMapsPlaces({ mode: "text" })
  check(
    "MapsPlaces: rejects text search without query",
    !missingQuery.success && /query/.test(missingQuery.error ?? "")
  )

  const badMode = await executeMapsPlaces({
    mode: "geoportal",
    query: "coffee",
  })
  check(
    "MapsPlaces: rejects invalid mode",
    !badMode.success && /mode/.test(badMode.error ?? "")
  )

  const badCenter = await executeMapsPlaces({
    mode: "text",
    query: "coffee",
    center: [200, 0],
  })
  check(
    "MapsPlaces: rejects out-of-range center",
    !badCenter.success && /center/.test(badCenter.error ?? "")
  )

  const nearbyNoCenter = await executeMapsPlaces({
    mode: "nearby",
    includedTypes: ["restaurant"],
  })
  check(
    "MapsPlaces: rejects nearby search without center",
    !nearbyNoCenter.success && /center/.test(nearbyNoCenter.error ?? "")
  )

  const nearbyNoTypes = await executeMapsPlaces({
    mode: "nearby",
    center: [23.5894, 46.7712],
  })
  check(
    "MapsPlaces: rejects nearby search without included types",
    !nearbyNoTypes.success && /included type/.test(nearbyNoTypes.error ?? "")
  )

  const badRank = await executeMapsPlaces({
    mode: "text",
    query: "coffee",
    rankPreference: "vibes",
  })
  check(
    "MapsPlaces: rejects invalid rankPreference",
    !badRank.success && /rankPreference/.test(badRank.error ?? "")
  )
}

// --- MapsOptimizeStops local optimizer ------------------------------------

{
  const optimized = await executeMapsOptimizeStops({
    start: [23.5894, 46.7712],
    startLabel: "Current location",
    stops: [
      { id: "far", label: "Far stop", position: [23.65, 46.8] },
      { id: "near", label: "Near stop", position: [23.5905, 46.772] },
      { id: "mid", label: "Mid stop", position: [23.61, 46.78] },
    ],
  })
  check(
    "MapsOptimizeStops: valid start + stops returns success",
    optimized.success
  )
  if (optimized.success && optimized.data) {
    const data = optimized.data as {
      stopOrder?: number[]
      waypointPositions?: unknown[]
      distanceMetersApprox?: number
      warnings?: unknown[]
    }
    check(
      "MapsOptimizeStops: nearest stop comes first from fixed start",
      Array.isArray(data.stopOrder) && data.stopOrder[0] === 1,
      data.stopOrder
    )
    check(
      "MapsOptimizeStops: waypointPositions include start + stops",
      Array.isArray(data.waypointPositions) &&
        data.waypointPositions.length === 4,
      data.waypointPositions
    )
    check(
      "MapsOptimizeStops: returns approximate distance",
      typeof data.distanceMetersApprox === "number" &&
        data.distanceMetersApprox > 0,
      data.distanceMetersApprox
    )
    check(
      "MapsOptimizeStops: returns warning about approximate route",
      Array.isArray(data.warnings) &&
        /straight-line/.test(String(data.warnings[0] ?? "")),
      data.warnings
    )
  }

  const loop = await executeMapsOptimizeStops({
    stops: [
      { id: "a", position: [23.58, 46.77] },
      { id: "b", position: [23.59, 46.78] },
    ],
    returnToStart: true,
    preserveFirstStop: true,
  })
  check(
    "MapsOptimizeStops: supports returnToStart with preserved first stop",
    loop.success
  )
  if (loop.success && loop.data) {
    const data = loop.data as { waypointPositions?: unknown[] }
    check(
      "MapsOptimizeStops: loop appends final return waypoint",
      Array.isArray(data.waypointPositions) &&
        data.waypointPositions.length === 3,
      data.waypointPositions
    )
  }

  const empty = await executeMapsOptimizeStops({ stops: [] })
  check(
    "MapsOptimizeStops: rejects empty stops",
    !empty.success && /non-empty/.test(empty.error ?? "")
  )

  const badStop = await executeMapsOptimizeStops({
    stops: [{ position: [200, 0] }],
  })
  check(
    "MapsOptimizeStops: rejects out-of-range stop coordinate",
    !badStop.success && /stops\.0\.position/.test(badStop.error ?? "")
  )

  const conflict = await executeMapsOptimizeStops({
    stops: [{ position: [23.58, 46.77] }],
    end: [23.59, 46.78],
    returnToStart: true,
  })
  check(
    "MapsOptimizeStops: rejects end plus returnToStart",
    !conflict.success &&
      /either end or returnToStart/.test(conflict.error ?? "")
  )
}

// --- MapsDirections input validation --------------------------------------

{
  const normalizedPlaceWaypoints = normalizeRouteWaypoints([
    { position: [23.5894, 46.7712], placeId: "places/ChIJrouteSmokeOrigin" },
    { position: [23.62, 46.78], placeId: "ChIJrouteSmokeDestination" },
  ])
  check(
    "MapsDirections: normalizes Place ID waypoints",
    normalizedPlaceWaypoints[0]?.placeId === "ChIJrouteSmokeOrigin" &&
      normalizedPlaceWaypoints[0]?.position?.[0] === 23.5894 &&
      normalizedPlaceWaypoints[1]?.placeId === "ChIJrouteSmokeDestination",
    normalizedPlaceWaypoints
  )

  const tooFew = await executeMapsDirections({
    waypoints: [[23.5894, 46.7712]],
  })
  check(
    "MapsDirections: rejects fewer than 2 waypoints",
    !tooFew.success && /at least two/.test(tooFew.error ?? "")
  )

  const tooMany = await executeMapsDirections({
    waypoints: Array.from({ length: 26 }, () => [23.5894, 46.7712]),
  })
  check(
    "MapsDirections: rejects more than 25 waypoints",
    !tooMany.success && /at most/.test(tooMany.error ?? "")
  )

  const badCoord = await executeMapsDirections({
    waypoints: [
      [23.5894, 46.7712],
      [200, 46.77],
    ],
  })
  check(
    "MapsDirections: rejects out-of-range coordinate",
    !badCoord.success && /waypoints\.1/.test(badCoord.error ?? "")
  )

  const badWaypointObject = await executeMapsDirections({
    waypoints: [
      { position: [23.5894, 46.7712], placeId: "ChIJorigin" },
      { position: [200, 46.77], placeId: "ChIJdestination" },
    ],
  })
  check(
    "MapsDirections: rejects out-of-range object waypoint",
    !badWaypointObject.success &&
      /waypoints\.1\.position/.test(badWaypointObject.error ?? ""),
    badWaypointObject
  )

  const emptyWaypointObject = await executeMapsDirections({
    waypoints: [{ position: [23.5894, 46.7712] }, {}],
  })
  check(
    "MapsDirections: rejects waypoint object without position or placeId",
    !emptyWaypointObject.success &&
      /waypoints\.1/.test(emptyWaypointObject.error ?? ""),
    emptyWaypointObject
  )

  const badMode = await executeMapsDirections({
    waypoints: [
      [23.5894, 46.7712],
      [23.62, 46.78],
    ],
    travelMode: "hoverboard",
  })
  check(
    "MapsDirections: rejects invalid travelMode",
    !badMode.success && /travelMode/.test(badMode.error ?? "")
  )

  const conflictingTimes = await executeMapsDirections({
    waypoints: [
      [23.5894, 46.7712],
      [23.62, 46.78],
    ],
    departureTime: "2026-05-21T08:00:00+03:00",
    arrivalTime: "2026-05-21T09:00:00+03:00",
  })
  check(
    "MapsDirections: rejects departureTime plus arrivalTime",
    !conflictingTimes.success &&
      /either departureTime or arrivalTime/.test(conflictingTimes.error ?? "")
  )

  const badArrivalMode = await executeMapsDirections({
    waypoints: [
      [23.5894, 46.7712],
      [23.62, 46.78],
    ],
    travelMode: "driving",
    arrivalTime: "2026-05-21T09:00:00+03:00",
  })
  check(
    "MapsDirections: rejects arrivalTime outside transit",
    !badArrivalMode.success && /transit/.test(badArrivalMode.error ?? "")
  )
}

// --- /api/maps/directions request validation ------------------------------

{
  const postDirections = (body: unknown) =>
    directionsApiPost(
      new Request("http://127.0.0.1/api/maps/directions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        body: JSON.stringify(body),
      })
    )

  const tooFew = await postDirections({ waypoints: [[23.5894, 46.7712]] })
  check(
    "/api/maps/directions: rejects fewer than 2 waypoints",
    tooFew.status === 400,
    tooFew.status
  )
  check(
    "/api/maps/directions: validation errors are not cacheable",
    /no-store/i.test(tooFew.headers.get("cache-control") ?? ""),
    tooFew.headers.get("cache-control")
  )

  const badCoord = await postDirections({
    waypoints: [
      [23.5894, 46.7712],
      [200, 46.77],
    ],
  })
  const badCoordBody = (await badCoord.json()) as { error?: string }
  check(
    "/api/maps/directions: points to invalid waypoint index",
    badCoord.status === 400 && /waypoints\.1/.test(badCoordBody.error ?? ""),
    badCoordBody
  )

  const badObjectCoord = await postDirections({
    waypoints: [
      { position: [23.5894, 46.7712], placeId: "ChIJorigin" },
      { position: [200, 46.77], placeId: "ChIJdestination" },
    ],
  })
  const badObjectCoordBody = (await badObjectCoord.json()) as { error?: string }
  check(
    "/api/maps/directions: validates object waypoint position",
    badObjectCoord.status === 400 &&
      /waypoints\.1\.position/.test(badObjectCoordBody.error ?? ""),
    badObjectCoordBody
  )

  const emptyObjectWaypoint = await postDirections({
    waypoints: [{ position: [23.5894, 46.7712] }, {}],
  })
  const emptyObjectWaypointBody = (await emptyObjectWaypoint.json()) as {
    error?: string
  }
  check(
    "/api/maps/directions: rejects object waypoint without position or placeId",
    emptyObjectWaypoint.status === 400 &&
      /waypoints\.1/.test(emptyObjectWaypointBody.error ?? ""),
    emptyObjectWaypointBody
  )

  const tooMany = await postDirections({
    waypoints: Array.from({ length: 26 }, () => [23.5894, 46.7712]),
  })
  check(
    "/api/maps/directions: rejects more than 25 waypoints",
    tooMany.status === 400,
    tooMany.status
  )

  const legacyMissingDestination = await postDirections({
    origin: [23.5894, 46.7712],
  })
  const legacyBody = (await legacyMissingDestination.json()) as {
    error?: string
  }
  check(
    "/api/maps/directions: keeps origin/destination validation",
    legacyMissingDestination.status === 400 &&
      /destination/.test(legacyBody.error ?? ""),
    legacyBody
  )
}

// --- summary ---------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nAll map smoke checks passed.")
