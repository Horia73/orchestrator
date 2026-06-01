/**
 * Smoke test for Location Intelligence day normalization.
 *
 * Run: npx tsx scripts/smoke-location-intelligence.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

let failures = 0

function check(label: string, condition: unknown, detail?: unknown) {
  const ok = Boolean(condition)
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : ` (${JSON.stringify(detail)})`}`
  )
  if (!ok) failures += 1
}

const stateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "location-intelligence-smoke-")
)
const workspaceDir = path.join(stateDir, "workspace")
const journalDir = path.join(
  workspaceDir,
  "microscripts",
  "ms_location_smoke",
  "files",
  "location"
)
fs.mkdirSync(path.join(journalDir, "days"), { recursive: true })

fs.writeFileSync(
  path.join(workspaceDir, "config.json"),
  JSON.stringify(
    {
      assistantName: "Smoke",
      userName: "User",
      activeProvider: "google",
      activeModel: "gemini-3-flash-preview",
      thinkingLevel: "high",
      agentOverrides: {},
      agentOrder: [],
      browserAgent: {
        backend: "patchright",
        light: {
          provider: "google",
          model: "gemini-3-flash-preview",
          thinkingLevel: "low",
        },
        pro: {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          thinkingLevel: "high",
        },
        proEnabled: true,
      },
      favorites: [],
      locationIntelligence: {
        enabled: true,
        source: {
          type: "home-assistant-webhook",
          entityId: "device_tracker.smoke",
          label: "Smoke tracker",
        },
        journalScriptId: "ms_location_smoke",
        retention: "forever",
        mapsMode: "relaxed",
      },
      updatedAt: Date.now(),
    },
    null,
    2
  ),
  "utf-8"
)

fs.writeFileSync(
  path.join(journalDir, "place_aliases.json"),
  JSON.stringify(
    {
      version: 1,
      aliases: {
        gym: {
          label: "Athletic Sport Center",
          center: { lat: 46.760408, lng: 23.613489 },
        },
        unknown_strada_dianei_area: {
          label: "teren",
          center: { lat: 46.728299, lng: 23.590288 },
          confidence: "user_confirmed",
        },
      },
    },
    null,
    2
  ),
  "utf-8"
)

const points = [
  {
    timestamp_ms: Date.parse("2026-05-30T18:26:27Z"),
    reported_at: "2026-05-30T18:26:27Z",
    state: "not_home",
    lat: 46.728703223963564,
    lng: 23.59353292719322,
    accuracy_m: 7,
    zone: "zone.cluj",
    activity: "Automotive",
    event: "sample",
  },
  {
    timestamp_ms: Date.parse("2026-05-30T19:14:09Z"),
    reported_at: "2026-05-30T19:14:09Z",
    state: "not_home",
    lat: 46.728703223963564,
    lng: 23.59353292719322,
    accuracy_m: 7,
    zone: "zone.cluj",
    activity: "Automotive",
    event: "sample",
  },
  {
    timestamp_ms: Date.parse("2026-05-30T19:20:00Z"),
    reported_at: "2026-05-30T19:20:00Z",
    state: "home",
    lat: 46.728299,
    lng: 23.590288,
    accuracy_m: 10,
    zone: "zone.home",
    activity: "Unknown",
    event: "sample",
  },
  {
    timestamp_ms: Date.parse("2026-05-30T19:30:00Z"),
    reported_at: "2026-05-30T19:30:00Z",
    state: "not_home",
    lat: 46.760561116666665,
    lng: 23.61331028333333,
    accuracy_m: 10,
    zone: "zone.cluj",
    activity: "Automotive",
    near_gym: true,
    event: "gym_candidate",
  },
  {
    timestamp_ms: Date.parse("2026-05-30T20:00:00Z"),
    reported_at: "2026-05-30T20:00:00Z",
    state: "not_home",
    lat: 46.123456,
    lng: 23.987654,
    accuracy_m: 10,
    activity: "Automotive",
    event: "sample",
  },
  {
    timestamp_ms: Date.parse("2026-05-30T20:10:00Z"),
    reported_at: "2026-05-30T20:10:00Z",
    state: "not_home",
    lat: 46.123456,
    lng: 23.987654,
    accuracy_m: 10,
    activity: "Automotive",
    event: "sample",
  },
]

fs.writeFileSync(
  path.join(journalDir, "points.jsonl"),
  `${points.map((point) => JSON.stringify(point)).join("\n")}\n`,
  "utf-8"
)

fs.writeFileSync(
  path.join(journalDir, "days", "2026-05-30.json"),
  JSON.stringify(
    {
      date: "2026-05-30",
      timezone: "Europe/Bucharest",
      sample_count: 4,
      stops: [
        {
          label: "unknown",
          start: "21:26",
          end: "21:26",
          duration_min: 0,
          center: { lat: 46.72870322, lng: 23.59353293 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
        {
          label: "unknown",
          start: "22:14",
          end: "22:14",
          duration_min: 0,
          center: { lat: 46.72870322, lng: 23.59353293 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
        {
          label: "home",
          start: "22:20",
          end: "22:20",
          duration_min: 0,
          center: { lat: 46.728299, lng: 23.590288 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
        {
          label: "gym",
          start: "22:30",
          end: "22:30",
          duration_min: 0,
          center: { lat: 46.76056112, lng: 23.61331028 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
        {
          label: "unknown",
          start: "23:00",
          end: "23:00",
          duration_min: 0,
          center: { lat: 46.123456, lng: 23.987654 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
        {
          label: "unknown",
          start: "23:10",
          end: "23:10",
          duration_min: 0,
          center: { lat: 46.123456, lng: 23.987654 },
          samples: 1,
          interpretation: "single_ha_sample_no_clustering",
        },
      ],
    },
    null,
    2
  ),
  "utf-8"
)

process.env.ORCHESTRATOR_STATE_DIR = stateDir

try {
  const { getLocationPlaceDay, listLocationPlaceDays } =
    await import("@/lib/location-intelligence/journal")

  const response = await getLocationPlaceDay("2026-05-30")
  const day = response.day
  check("day loads from temporary journal", day !== null)

  const terrainStop = day?.stops[0]
  check("coordinate alias labels day stop", terrainStop?.label === "teren", {
    label: terrainStop?.label,
  })
  check("day stop uses raw gap duration", terrainStop?.durationMinutes === 48, {
    durationMinutes: terrainStop?.durationMinutes,
  })
  check("day stop end clock is inferred", terrainStop?.endTime === "22:14", {
    endTime: terrainStop?.endTime,
  })
  check(
    "day stop marks inferred stay",
    terrainStop?.kind?.includes("inferred_stay"),
    {
      kind: terrainStop?.kind,
    }
  )

  const terrainObservation = day?.observations[0]
  check(
    "coordinate alias labels raw observation",
    terrainObservation?.label === "teren",
    { label: terrainObservation?.label }
  )
  check(
    "raw observation keeps matching gap duration",
    terrainObservation?.durationMinutes === 48,
    { durationMinutes: terrainObservation?.durationMinutes }
  )

  check("home label is preserved", day?.stops[2]?.label === "home", {
    label: day?.stops[2]?.label,
  })
  check(
    "exact gym alias still applies",
    day?.stops[3]?.label === "Athletic Sport Center",
    {
      label: day?.stops[3]?.label,
    }
  )
  check(
    "unresolved long automotive day gap becomes inferred stay",
    day?.stops[4]?.label === "Inferred stay",
    { label: day?.stops[4]?.label }
  )
  check(
    "unresolved long automotive raw gap becomes inferred stay",
    day?.observations[4]?.label === "Inferred stay",
    { label: day?.observations[4]?.label }
  )

  const list = await listLocationPlaceDays(10)
  check(
    "list summary includes coordinate alias",
    list.days[0]?.notablePlaces.includes("teren"),
    {
      notablePlaces: list.days[0]?.notablePlaces,
    }
  )
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true })
}

if (failures > 0) {
  process.exitCode = 1
}
