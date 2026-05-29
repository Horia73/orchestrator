import fs from "fs"
import path from "path"
import readline from "readline"

import { getConfig, WORKSPACE_DIR } from "@/lib/config"
import { getMicroscript } from "@/lib/microscripts/store"
import { getScheduledTask } from "@/lib/scheduling/store"
import type { LocationIntelligenceSettings } from "@/lib/config"
import type {
  LocationCoordinate,
  LocationDailyTaskStatus,
  LocationDayDetail,
  LocationDayStats,
  LocationDaySummary,
  LocationIntelligenceIntegrationStatus,
  LocationJournalFileStatus,
  LocationMicroscriptStatus,
  LocationPlacesDayResponse,
  LocationPlacesList,
  LocationRetentionStatus,
  LocationStop,
} from "@/lib/location-intelligence/schema"

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROUTE_POINTS = 700
const MAX_STOP_COUNT = 80
const MAX_NOTABLE_PLACES = 6
const LOCATION_CAPABILITIES = [
  "Home Assistant webhook ingestion through an opt-in microscript journal",
  "Daily scheduled agent intelligence over local location summaries",
  "Raw points preserved in points.jsonl, with stays inferred from webhook gaps",
  "Library Places map with Places and Raw observation layers",
  "Configurable finite retention or forever / keep everything retention",
  "Maps mode policy: strict, balanced, or relaxed",
]

interface JournalResolution {
  absolutePath: string | null
  relativePath: string | null
  files: LocationJournalFileStatus
}

interface PointSummary {
  sampleCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  route: LocationCoordinate[]
  observations: LocationStop[]
}

interface DayReadResult {
  raw: unknown
  updatedAt: number | null
}

export async function listLocationPlaceDays(
  limit: number
): Promise<LocationPlacesList> {
  const status = getLocationIntelligenceStatus()
  if (!status.configured || !status.enabled || !status.journal.exists) {
    return { status, days: [], total: 0 }
  }

  const journalPath = resolveJournalPath(getConfig().locationIntelligence)
  if (!journalPath.absolutePath) return { status, days: [], total: 0 }

  const dayFiles = listDayFiles(journalPath.absolutePath)
  const pointSummaries = await readPointSummaries(
    path.join(journalPath.absolutePath, "points.jsonl")
  )
  const dates = new Set<string>([
    ...dayFiles.map((file) => file.date),
    ...pointSummaries.keys(),
  ])
  const sortedDates = [...dates].sort().reverse()
  const limitedDates = sortedDates.slice(0, Math.max(1, Math.min(limit, 365)))
  const aliases = readPlaceAliases(journalPath.absolutePath)
  const days: LocationDaySummary[] = []

  for (const date of limitedDates) {
    const dayFile = dayFiles.find((file) => file.date === date)
    const day = dayFile ? readDayJson(dayFile.path) : null
    const summary = buildDayDetail({
      date,
      day,
      aliases,
      pointSummary: pointSummaries.get(date) ?? null,
      includeRouteFallback: false,
    })
    days.push(stripDayDetail(summary))
  }

  return { status, days, total: sortedDates.length }
}

export async function getLocationPlaceDay(
  date: string
): Promise<LocationPlacesDayResponse> {
  const status = getLocationIntelligenceStatus()
  if (!DATE_RE.test(date)) return { status, day: null }
  if (!status.configured || !status.enabled || !status.journal.exists) {
    return { status, day: null }
  }

  const journalPath = resolveJournalPath(getConfig().locationIntelligence)
  if (!journalPath.absolutePath) return { status, day: null }

  const aliases = readPlaceAliases(journalPath.absolutePath)
  const dayPath = path.join(journalPath.absolutePath, "days", `${date}.json`)
  const day = readDayJson(dayPath)
  const pointSummary = await readPointSummaryForDate(
    path.join(journalPath.absolutePath, "points.jsonl"),
    date
  )
  if (!day && !pointSummary) return { status, day: null }

  return {
    status,
    day: buildDayDetail({
      date,
      day,
      aliases,
      pointSummary,
      includeRouteFallback: true,
    }),
  }
}

export function getLocationIntelligenceStatus(): LocationIntelligenceIntegrationStatus {
  const config = getConfig().locationIntelligence
  const configured = Boolean(config)
  const enabled = config?.enabled === true
  const journal = resolveJournalPath(config)
  const missingConfig: string[] = []
  if (configured && !config?.journalScriptId)
    missingConfig.push("journalScriptId")
  if (configured && !config?.source?.type) missingConfig.push("source.type")

  const microscript = config?.journalScriptId
    ? readMicroscriptStatus(config.journalScriptId)
    : null
  const dailyTask = config?.dailyTaskId
    ? readDailyTaskStatus(config.dailyTaskId)
    : null

  const connected = configured && enabled && journal.files.exists
  const needsReconnect =
    configured &&
    enabled &&
    (missingConfig.length > 0 ||
      (Boolean(config?.journalScriptId) && !journal.files.exists))

  return {
    id: "locationIntelligence",
    name: "Location Intelligence",
    description:
      "Optional local location journal, raw observations, daily agent summaries, and Library Places views.",
    configured,
    enabled,
    connected,
    needsReconnect,
    missingConfig,
    source: {
      type: config?.source.type ?? "unknown",
      label: cleanText(config?.source.label, 120) || null,
      entityId: cleanText(config?.source.entityId, 160) || null,
    },
    retention: retentionStatus(config),
    mapsMode: config?.mapsMode ?? "balanced",
    journalScriptId: config?.journalScriptId ?? null,
    dailyTaskId: config?.dailyTaskId ?? null,
    journal: journal.files,
    microscript,
    dailyTask,
    capabilities: [...LOCATION_CAPABILITIES],
    setupPrompt:
      "Help me set up optional Location Intelligence. I want Home Assistant location updates to flow into a local microscript journal, preserve raw points in points.jsonl, infer stays from gaps until the next webhook, run daily summaries, support retention including keep everything, and show Library Places with Places/Raw layers. Do not enable tracking until I explicitly opt in.",
    ...(configured &&
    enabled &&
    config?.journalScriptId &&
    !journal.files.exists
      ? {
          error:
            "Configured journal script exists, but its files/location directory was not found.",
        }
      : {}),
  }
}

function resolveJournalPath(
  config: LocationIntelligenceSettings | undefined
): JournalResolution {
  const base: LocationJournalFileStatus = {
    exists: false,
    relativePath: null,
    dayCount: 0,
    firstDate: null,
    lastDate: null,
    lastUpdatedAt: null,
    pointsLogExists: false,
    routineExists: false,
    aliasesExists: false,
  }

  if (!config?.journalScriptId) {
    return { absolutePath: null, relativePath: null, files: base }
  }

  const relativePath = path.join(
    "microscripts",
    config.journalScriptId,
    "files",
    "location"
  )
  const absolutePath = safeWorkspaceJoin(relativePath)
  if (!absolutePath) {
    return { absolutePath: null, relativePath, files: base }
  }

  const files = inspectJournalFiles(absolutePath, relativePath)
  return {
    absolutePath,
    relativePath,
    files,
  }
}

function inspectJournalFiles(
  absolutePath: string,
  relativePath: string
): LocationJournalFileStatus {
  const exists = isDirectory(absolutePath)
  const pointsPath = path.join(absolutePath, "points.jsonl")
  const routinePath = path.join(absolutePath, "routine.json")
  const aliasesPath = path.join(absolutePath, "place_aliases.json")
  const dayFiles = exists ? listDayFiles(absolutePath) : []
  const dates = dayFiles.map((file) => file.date).sort()
  const mtimes = [
    ...dayFiles.map((file) => file.updatedAt).filter(isFiniteNumber),
    fileMtime(pointsPath),
    fileMtime(routinePath),
    fileMtime(aliasesPath),
  ].filter(isFiniteNumber)

  return {
    exists,
    relativePath: exists ? relativePath : null,
    dayCount: dayFiles.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    lastUpdatedAt: mtimes.length ? Math.max(...mtimes) : null,
    pointsLogExists: isFile(pointsPath),
    routineExists: isFile(routinePath),
    aliasesExists: isFile(aliasesPath),
  }
}

function listDayFiles(absolutePath: string): Array<{
  date: string
  path: string
  updatedAt: number | null
}> {
  const daysDir = path.join(absolutePath, "days")
  if (!isDirectory(daysDir)) return []
  try {
    return fs
      .readdirSync(daysDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && DAY_FILE_RE.test(entry.name))
      .map((entry) => {
        const filePath = path.join(daysDir, entry.name)
        return {
          date: entry.name.slice(0, -".json".length),
          path: filePath,
          updatedAt: fileMtime(filePath),
        }
      })
  } catch {
    return []
  }
}

function readDayJson(filePath: string): DayReadResult | null {
  try {
    if (!isFile(filePath)) return null
    return {
      raw: JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown,
      updatedAt: fileMtime(filePath),
    }
  } catch {
    return null
  }
}

function buildDayDetail({
  date,
  day,
  aliases,
  pointSummary,
  includeRouteFallback,
}: {
  date: string
  day: DayReadResult | null
  aliases: Map<string, string>
  pointSummary: PointSummary | null
  includeRouteFallback: boolean
}): LocationDayDetail {
  const raw = day?.raw
  const stops = extractStops(raw, aliases)
  const observations = pointSummary?.observations ?? []
  const route = thinCoordinates(
    extractRoute(raw) ??
      (includeRouteFallback ? (pointSummary?.route ?? []) : []),
    MAX_ROUTE_POINTS
  )
  const stats = extractStats(raw, stops, pointSummary)
  const notablePlaces = stops
    .map((stop) => stop.label)
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, MAX_NOTABLE_PLACES)

  return {
    date,
    label: dayLabel(date),
    summary:
      cleanText(stringFromKeys(raw, ["summary", "headline", "title"]), 280) ||
      null,
    timezone:
      cleanText(stringFromKeys(raw, ["timezone", "timeZone", "tz"]), 80) ||
      null,
    startTime:
      normalizeTimeString(
        stringFromKeys(raw, ["startTime", "start", "firstSeenAt"])
      ) ??
      pointSummary?.firstSeenAt ??
      stops.find((stop) => stop.startTime)?.startTime ??
      null,
    endTime:
      normalizeTimeString(
        stringFromKeys(raw, ["endTime", "end", "lastSeenAt"])
      ) ??
      pointSummary?.lastSeenAt ??
      [...stops].reverse().find((stop) => stop.endTime)?.endTime ??
      null,
    firstSeenAt:
      normalizeTimeString(
        stringFromKeys(raw, ["firstSeenAt", "first_seen_at"])
      ) ??
      pointSummary?.firstSeenAt ??
      null,
    lastSeenAt:
      normalizeTimeString(
        stringFromKeys(raw, ["lastSeenAt", "last_seen_at"])
      ) ??
      pointSummary?.lastSeenAt ??
      null,
    updatedAt: day?.updatedAt ?? null,
    stats,
    notablePlaces,
    hasRoute: route.length >= 2 || Boolean(routeFromRawExists(raw)),
    stops,
    observations,
    route,
  }
}

function stripDayDetail(day: LocationDayDetail): LocationDaySummary {
  return {
    date: day.date,
    label: day.label,
    summary: day.summary,
    timezone: day.timezone,
    startTime: day.startTime,
    endTime: day.endTime,
    firstSeenAt: day.firstSeenAt,
    lastSeenAt: day.lastSeenAt,
    updatedAt: day.updatedAt,
    stats: day.stats,
    notablePlaces: day.notablePlaces,
    hasRoute: day.hasRoute,
  }
}

function extractStops(
  raw: unknown,
  aliases: Map<string, string>
): LocationStop[] {
  const candidates = firstArrayFromKeys(raw, [
    "stops",
    "visits",
    "places",
    "timeline",
    "stopTimeline",
  ])
  if (!candidates) return []

  return candidates
    .slice(0, MAX_STOP_COUNT)
    .map((entry, index) => normalizeStop(entry, index, aliases))
    .filter((stop): stop is LocationStop => Boolean(stop))
}

function normalizeStop(
  value: unknown,
  index: number,
  aliases: Map<string, string>
): LocationStop | null {
  if (!isRecord(value)) return null
  const alias = aliasForRecord(value, aliases)
  const rawLabel =
    alias ||
    stringFromKeys(value, [
      "label",
      "name",
      "place",
      "placeName",
      "zone",
      "semanticLabel",
      "category",
      "type",
    ])
  const label = sanitizePlaceLabel(rawLabel, index)
  const id =
    cleanText(stringFromKeys(value, ["id", "placeId", "place_id"]), 80) ||
    `${index + 1}`
  const durationMinutes = durationMinutesFromRecord(value)

  return {
    id,
    label,
    startTime: normalizeTimeString(
      stringFromKeys(value, ["startTime", "start", "arrivedAt", "firstSeenAt"])
    ),
    endTime: normalizeTimeString(
      stringFromKeys(value, ["endTime", "end", "leftAt", "lastSeenAt"])
    ),
    durationMinutes,
    position: coordinateFromUnknown(value),
    kind:
      cleanText(stringFromKeys(value, ["kind", "type", "category"]), 80) ||
      null,
  }
}

function observationFromPoint(
  point: unknown,
  index: number
): LocationStop | null {
  if (!isRecord(point)) return null
  const position = coordinateFromUnknown(point)
  if (!position) return null
  const timestamp = timestampForPoint(point)
  const label = labelForPoint(point, index)
  const rawKind =
    cleanText(stringFromKeys(point, ["event", "activity", "state"]), 80) ||
    "raw"

  return {
    id:
      cleanText(stringFromKeys(point, ["id", "sample_id", "event_id"]), 80) ||
      `raw-${index + 1}`,
    label,
    startTime: timestamp,
    endTime: timestamp,
    durationMinutes: null,
    position,
    kind: rawKind,
  }
}

function withObservationDurations(
  observations: LocationStop[]
): LocationStop[] {
  const sorted = [...observations].sort((a, b) =>
    (a.startTime ?? "").localeCompare(b.startTime ?? "")
  )

  return sorted.map((observation, index) => {
    const next = sorted[index + 1]
    const startMs = observation.startTime
      ? Date.parse(observation.startTime)
      : NaN
    const nextMs = next?.startTime ? Date.parse(next.startTime) : NaN
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(nextMs) ||
      nextMs <= startMs
    ) {
      return observation
    }
    const durationMinutes = Math.max(0, Math.round((nextMs - startMs) / 60000))
    return {
      ...observation,
      endTime: next?.startTime ?? observation.endTime,
      durationMinutes,
      kind:
        durationMinutes >= 7
          ? `${observation.kind ?? "raw"} · inferred_stay`
          : observation.kind,
    }
  })
}

function labelForPoint(point: Record<string, unknown>, index: number): string {
  const state = cleanText(stringFromKeys(point, ["state"]), 80).toLowerCase()
  if (state === "home") return "home"
  if (booleanFromKeys(point, ["near_gym", "nearGym"])) return "gym area"
  const zone = cleanText(stringFromKeys(point, ["zone"]), 120)
  if (zone) {
    const firstZone = zone.split(",")[0]?.trim()
    if (firstZone) return firstZone.replace(/^zone\./, "")
  }
  const activity = cleanText(stringFromKeys(point, ["activity"]), 80)
  if (activity && activity.toLowerCase() !== "unknown") return activity
  return `Observation ${index + 1}`
}

function extractStats(
  raw: unknown,
  stops: LocationStop[],
  pointSummary: PointSummary | null
): LocationDayStats {
  const explicitSampleCount =
    numberFromKeys(raw, [
      "sampleCount",
      "sample_count",
      "samplesCount",
      "pointCount",
      "pointsCount",
      "good_sample_count",
    ]) ??
    firstArrayFromKeys(raw, ["samples", "points"])?.length ??
    null
  const distanceMeters =
    numberFromKeys(raw, ["distanceMeters", "distance_meters", "distance_m"]) ??
    convertKmToMeters(
      numberFromKeys(raw, [
        "distanceKm",
        "distance_km",
        "approx_distance_km",
        "distance",
      ])
    )

  return {
    distanceMeters,
    sampleCount: explicitSampleCount ?? pointSummary?.sampleCount ?? null,
    stopCount: stops.length,
    gymDetected: booleanFromKeys(raw, [
      "gymDetected",
      "gym_detected",
      "visitedGym",
      "visited_gym",
      "gym",
    ]),
  }
}

function extractRoute(raw: unknown): LocationCoordinate[] | null {
  const routeValue = firstValueFromKeys(raw, [
    "route",
    "routeCoordinates",
    "route_coordinates",
    "polyline",
    "path",
    "track",
    "coordinates",
  ])
  const direct = coordinatesFromUnknown(routeValue)
  if (direct.length >= 2) return direct

  const samples = firstArrayFromKeys(raw, ["samples", "points"])
  if (!samples) return null
  const fromSamples = samples
    .map((point) => coordinateFromUnknown(point))
    .filter((coord): coord is LocationCoordinate => Boolean(coord))
  return fromSamples.length >= 2 ? fromSamples : null
}

function routeFromRawExists(raw: unknown): boolean {
  return Boolean(
    firstValueFromKeys(raw, [
      "route",
      "routeCoordinates",
      "route_coordinates",
      "polyline",
      "path",
      "track",
      "coordinates",
    ])
  )
}

async function readPointSummaries(
  filePath: string
): Promise<Map<string, PointSummary>> {
  const summaries = new Map<string, PointSummary>()
  if (!isFile(filePath)) return summaries

  await readPoints(filePath, (point) => {
    const date = dateForPoint(point)
    if (!date) return
    const coord = coordinateFromUnknown(point)
    const timestamp = timestampForPoint(point)
    const summary = summaries.get(date) ?? {
      sampleCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      route: [],
      observations: [],
    }
    summary.sampleCount += 1
    if (timestamp) {
      if (!summary.firstSeenAt || timestamp < summary.firstSeenAt) {
        summary.firstSeenAt = timestamp
      }
      if (!summary.lastSeenAt || timestamp > summary.lastSeenAt) {
        summary.lastSeenAt = timestamp
      }
    }
    if (coord && summary.route.length < MAX_ROUTE_POINTS * 4) {
      summary.route.push(coord)
    }
    const observation = observationFromPoint(point, summary.sampleCount - 1)
    if (observation && summary.observations.length < MAX_STOP_COUNT) {
      summary.observations.push(observation)
    }
    summaries.set(date, summary)
  })

  for (const [date, summary] of summaries) {
    const observations = withObservationDurations(summary.observations)
    summaries.set(date, {
      ...summary,
      route: thinCoordinates(summary.route, MAX_ROUTE_POINTS),
      observations,
    })
  }
  return summaries
}

async function readPointSummaryForDate(
  filePath: string,
  targetDate: string
): Promise<PointSummary | null> {
  if (!isFile(filePath)) return null
  const summary: PointSummary = {
    sampleCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    route: [],
    observations: [],
  }

  await readPoints(filePath, (point) => {
    const date = dateForPoint(point)
    if (date !== targetDate) return
    const coord = coordinateFromUnknown(point)
    const timestamp = timestampForPoint(point)
    summary.sampleCount += 1
    if (timestamp) {
      if (!summary.firstSeenAt || timestamp < summary.firstSeenAt) {
        summary.firstSeenAt = timestamp
      }
      if (!summary.lastSeenAt || timestamp > summary.lastSeenAt) {
        summary.lastSeenAt = timestamp
      }
    }
    if (coord) summary.route.push(coord)
    const observation = observationFromPoint(point, summary.sampleCount - 1)
    if (observation && summary.observations.length < MAX_STOP_COUNT) {
      summary.observations.push(observation)
    }
  })

  if (summary.sampleCount === 0 && summary.route.length === 0) return null
  return {
    ...summary,
    route: thinCoordinates(summary.route, MAX_ROUTE_POINTS),
    observations: withObservationDurations(summary.observations),
  }
}

async function readPoints(
  filePath: string,
  onPoint: (point: unknown) => void
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" })
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onPoint(JSON.parse(trimmed) as unknown)
      } catch {
        continue
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

function readPlaceAliases(absolutePath: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const parsed = safeReadJson(path.join(absolutePath, "place_aliases.json"))
  collectAliases(parsed, aliases)
  return aliases
}

function collectAliases(value: unknown, aliases: Map<string, string>): void {
  if (!isRecord(value)) return
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      const alias = cleanText(raw, 120)
      if (alias) aliases.set(key, alias)
    } else if (isRecord(raw)) {
      const alias = stringFromKeys(raw, ["alias", "label", "name"])
      if (alias) aliases.set(key, cleanText(alias, 120))
      collectAliases(raw, aliases)
    }
  }
}

function aliasForRecord(
  value: Record<string, unknown>,
  aliases: Map<string, string>
): string {
  for (const key of [
    "placeId",
    "place_id",
    "aliasId",
    "alias_id",
    "id",
    "key",
    "label",
    "name",
  ]) {
    const raw = value[key]
    if (typeof raw !== "string") continue
    const direct = aliases.get(raw)
    if (direct) return direct
  }
  return ""
}

function retentionStatus(
  config: LocationIntelligenceSettings | undefined
): LocationRetentionStatus {
  if (config?.retention === "forever") {
    return { mode: "forever", days: null, label: "Keep everything" }
  }
  if (typeof config?.retentionDays === "number" && config.retentionDays > 0) {
    return {
      mode: "days",
      days: config.retentionDays,
      label: `${config.retentionDays} days`,
    }
  }
  return { mode: "unset", days: null, label: "Not set" }
}

function readMicroscriptStatus(id: string): LocationMicroscriptStatus {
  const script = getMicroscript(id)
  return {
    id,
    exists: Boolean(script),
    status: script?.status ?? null,
    enabled: script?.enabled ?? null,
    lastRunAt: script?.lastRunAt ?? null,
    nextRunAt: script?.nextRunAt ?? null,
    lastRunStatus: script?.lastRunStatus ?? null,
  }
}

function readDailyTaskStatus(id: string): LocationDailyTaskStatus {
  const task = getScheduledTask(id)
  return {
    id,
    exists: Boolean(task),
    status: task?.status ?? null,
    enabled: task?.enabled ?? null,
    lastRunAt: task?.lastRunAt ?? null,
    nextRunAt: task?.nextRunAt ?? null,
    lastRunStatus: task?.lastRunStatus ?? null,
  }
}

function safeWorkspaceJoin(relativePath: string): string | null {
  const resolved = path.resolve(WORKSPACE_DIR, relativePath)
  const workspace = path.resolve(WORKSPACE_DIR)
  if (
    resolved !== workspace &&
    !resolved.startsWith(`${workspace}${path.sep}`)
  ) {
    return null
  }
  return resolved
}

function safeReadJson(filePath: string): unknown {
  try {
    if (!isFile(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
  } catch {
    return null
  }
}

function coordinateFromUnknown(value: unknown): LocationCoordinate | null {
  if (Array.isArray(value)) return coordinateFromArray(value, "lngLat")
  if (!isRecord(value)) return null

  const lat =
    numberFromKeys(value, ["lat", "latitude"]) ??
    (isRecord(value.attributes)
      ? numberFromKeys(value.attributes, ["lat", "latitude"])
      : null)
  const lng =
    numberFromKeys(value, ["lng", "lon", "longitude"]) ??
    (isRecord(value.attributes)
      ? numberFromKeys(value.attributes, ["lng", "lon", "longitude"])
      : null)
  if (lat !== null && lng !== null && isValidLatLng(lat, lng)) return [lng, lat]

  for (const key of [
    "position",
    "center",
    "centroid",
    "coordinate",
    "location",
  ]) {
    const nested = value[key]
    const coord = Array.isArray(nested)
      ? coordinateFromArray(nested, "lngLat")
      : coordinateFromUnknown(nested)
    if (coord) return coord
  }
  for (const key of ["latLng", "latlng"]) {
    const coord = coordinateFromArray(value[key], "latLng")
    if (coord) return coord
  }

  return null
}

function coordinatesFromUnknown(value: unknown): LocationCoordinate[] {
  if (!Array.isArray(value)) return []
  const out: LocationCoordinate[] = []

  for (const item of value) {
    const coord = coordinateFromUnknown(item)
    if (coord) out.push(coord)
  }

  return out
}

function coordinateFromArray(
  value: unknown,
  preference: "lngLat" | "latLng"
): LocationCoordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const first = asNumber(value[0])
  const second = asNumber(value[1])
  if (!isFiniteNumber(first) || !isFiniteNumber(second)) return null

  if (Math.abs(first) > 90 && isValidLatLng(second, first))
    return [first, second]
  if (Math.abs(second) > 90 && isValidLatLng(first, second))
    return [second, first]

  if (preference === "latLng" && isValidLatLng(first, second)) {
    return [second, first]
  }
  if (isValidLatLng(second, first)) return [first, second]
  if (isValidLatLng(first, second)) return [second, first]
  return null
}

function isValidLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean {
  return (
    isFiniteNumber(lat) &&
    isFiniteNumber(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}

function thinCoordinates(
  coordinates: LocationCoordinate[],
  maxPoints: number
): LocationCoordinate[] {
  const deduped: LocationCoordinate[] = []
  for (const coord of coordinates) {
    const last = deduped[deduped.length - 1]
    if (
      last &&
      Math.abs(last[0] - coord[0]) < 0.00002 &&
      Math.abs(last[1] - coord[1]) < 0.00002
    ) {
      continue
    }
    deduped.push([roundCoord(coord[0]), roundCoord(coord[1])])
  }
  if (deduped.length <= maxPoints) return deduped
  const out: LocationCoordinate[] = []
  const step = (deduped.length - 1) / (maxPoints - 1)
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(deduped[Math.round(i * step)])
  }
  return out
}

function firstArrayFromKeys(value: unknown, keys: string[]): unknown[] | null {
  const found = firstValueFromKeys(value, keys)
  return Array.isArray(found) ? found : null
}

function firstValueFromKeys(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    if (value[key] !== undefined) return value[key]
  }
  const stats = value.stats
  if (isRecord(stats)) {
    for (const key of keys) {
      if (stats[key] !== undefined) return stats[key]
    }
  }
  return undefined
}

function stringFromKeys(value: unknown, keys: string[]): string {
  const found = firstValueFromKeys(value, keys)
  if (typeof found === "string") return found
  if (typeof found === "number" && Number.isFinite(found)) return String(found)
  return ""
}

function numberFromKeys(value: unknown, keys: string[]): number | null {
  const found = firstValueFromKeys(value, keys)
  return asNumber(found)
}

function booleanFromKeys(value: unknown, keys: string[]): boolean {
  const found = firstValueFromKeys(value, keys)
  if (typeof found === "boolean") return found
  if (typeof found === "number") return found > 0
  if (typeof found === "string") {
    const normalized = found.trim().toLowerCase()
    return normalized === "true" || normalized === "yes" || normalized === "1"
  }
  if (isRecord(found)) {
    return booleanFromKeys(found, ["detected", "visited", "present", "value"])
  }
  return false
}

function durationMinutesFromRecord(
  value: Record<string, unknown>
): number | null {
  const minutes = numberFromKeys(value, [
    "durationMinutes",
    "duration_minutes",
    "duration_min",
    "minutes",
  ])
  if (minutes !== null) return Math.max(0, Math.round(minutes))
  const seconds = numberFromKeys(value, ["durationSeconds", "duration_seconds"])
  if (seconds !== null) return Math.max(0, Math.round(seconds / 60))
  const millis = numberFromKeys(value, ["durationMs", "duration_ms"])
  if (millis !== null) return Math.max(0, Math.round(millis / 60000))
  return null
}

function dateForPoint(point: unknown): string | null {
  const explicit = cleanText(stringFromKeys(point, ["date", "day"]), 20)
  if (DATE_RE.test(explicit)) return explicit
  const timestamp = timestampForPoint(point)
  return timestamp ? timestamp.slice(0, 10) : null
}

function timestampForPoint(point: unknown): string | null {
  const raw =
    stringFromKeys(point, [
      "timestamp",
      "timestamp_ms",
      "time",
      "ts",
      "createdAt",
      "created_at",
      "reported_at",
    ]) ||
    String(
      numberFromKeys(point, [
        "timestamp",
        "timestamp_ms",
        "time",
        "ts",
        "createdAt",
        "created_at",
      ]) ?? ""
    )
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    const ms = n < 10_000_000_000 ? n * 1000 : n
    return new Date(ms).toISOString()
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeTimeString(value: string): string | null {
  const clean = cleanText(value, 80)
  if (!clean) return null
  if (/^\d{1,2}:\d{2}/.test(clean)) return clean
  const parsed = Date.parse(clean)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : clean
}

function sanitizePlaceLabel(value: string, index: number): string {
  const clean = cleanText(value, 120)
  if (!clean) return `Stop ${index + 1}`
  if (/\bhome\b/i.test(clean)) return "home"
  return clean
}

function dayLabel(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return date
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed)
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : ""
}

function convertKmToMeters(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000)
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function fileMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return null
  }
}
