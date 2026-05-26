import type {
  LocationIntelligenceMapsMode,
  LocationIntelligenceSourceType,
} from "@/lib/config"

export type LocationCoordinate = [number, number]

export interface LocationRetentionStatus {
  mode: "days" | "forever" | "unset"
  days: number | null
  label: string
}

export interface LocationIntelligenceSourceStatus {
  type: LocationIntelligenceSourceType
  label: string | null
  entityId: string | null
}

export interface LocationJournalFileStatus {
  exists: boolean
  relativePath: string | null
  dayCount: number
  firstDate: string | null
  lastDate: string | null
  lastUpdatedAt: number | null
  pointsLogExists: boolean
  routineExists: boolean
  aliasesExists: boolean
}

export interface LocationMicroscriptStatus {
  id: string
  exists: boolean
  status: string | null
  enabled: boolean | null
  lastRunAt: number | null
  nextRunAt: number | null
  lastRunStatus: string | null
}

export interface LocationDailyTaskStatus {
  id: string
  exists: boolean
  status: string | null
  enabled: boolean | null
  lastRunAt: number | null
  nextRunAt: number | null
  lastRunStatus: string | null
}

export interface LocationIntelligenceIntegrationStatus {
  id: "locationIntelligence"
  name: string
  description: string
  configured: boolean
  enabled: boolean
  connected: boolean
  needsReconnect: boolean
  missingConfig: string[]
  source: LocationIntelligenceSourceStatus
  retention: LocationRetentionStatus
  mapsMode: LocationIntelligenceMapsMode
  journalScriptId: string | null
  dailyTaskId: string | null
  journal: LocationJournalFileStatus
  microscript: LocationMicroscriptStatus | null
  dailyTask: LocationDailyTaskStatus | null
  capabilities: string[]
  setupPrompt: string
  error?: string
}

export interface LocationDayStats {
  distanceMeters: number | null
  sampleCount: number | null
  stopCount: number
  gymDetected: boolean
}

export interface LocationDaySummary {
  date: string
  label: string
  summary: string | null
  timezone: string | null
  startTime: string | null
  endTime: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  updatedAt: number | null
  stats: LocationDayStats
  notablePlaces: string[]
  hasRoute: boolean
}

export interface LocationStop {
  id: string
  label: string
  startTime: string | null
  endTime: string | null
  durationMinutes: number | null
  position: LocationCoordinate | null
  kind: string | null
}

export interface LocationDayDetail extends LocationDaySummary {
  stops: LocationStop[]
  route: LocationCoordinate[]
}

export interface LocationPlacesList {
  status: LocationIntelligenceIntegrationStatus
  days: LocationDaySummary[]
  total: number
}

export interface LocationPlacesDayResponse {
  status: LocationIntelligenceIntegrationStatus
  day: LocationDayDetail | null
}
