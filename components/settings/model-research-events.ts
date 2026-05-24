import type { ProviderDef } from "@/lib/config"

type ModelResearchEventBase = { at?: number }

export type ModelResearchClientEvent = ModelResearchEventBase &
  (
    | { type: "ready"; runId?: string; total: number; concurrency?: number }
    | {
        type: "model_start"
        key: string
        providerId: string
        modelId: string
        name: string
        index: number
        total: number
        missing: string[]
      }
    | { type: "agent_event"; key: string; event: Record<string, unknown> }
    | {
        type: "model_retry"
        key: string
        attempt: number
        maxAttempts: number
        reason: string
      }
    | {
        type: "model_result"
        key: string
        status: "updated" | "unchanged" | "incomplete" | "failed"
        summary?: string
        error?: string
        remainingMissing?: string[]
        unresolved?: Array<{ field: string; reason?: string }>
        model?: ProviderDef["models"][string]
      }
    | {
        type: "done"
        runId?: string
        total: number
        updated: number
        incomplete: number
        failed: number
      }
    | { type: "stopped"; runId?: string; message: string }
    | { type: "error"; runId?: string; message: string }
  )

export interface ModelResearchStatusSnapshot {
  running: boolean
  runId: string | null
  status: "idle" | "running" | "done" | "stopped" | "error"
  startedAt: number | null
  endedAt: number | null
  concurrency: number
  events: ModelResearchClientEvent[]
}

export const RESEARCH_EVENTS_STORAGE_KEY =
  "orchestrator:model-research-events:v1"

const MAX_RESEARCH_EVENTS = 400

export function isTerminalResearchEvent(
  event: ModelResearchClientEvent
): boolean {
  return (
    event.type === "done" || event.type === "stopped" || event.type === "error"
  )
}

/**
 * Cap the event buffer WITHOUT ever dropping structural events. The previous
 * implementation kept only the last N events, which evicted the `ready` event
 * (it is always first) on any real run — and once `ready` is gone the progress
 * counter loses its denominator and renders "3/0". We keep every structural
 * event (bounded ~ models×3) and only ring-buffer the high-volume agent
 * transcript.
 */
export function capResearchEvents(
  events: ModelResearchClientEvent[]
): ModelResearchClientEvent[] {
  if (events.length <= MAX_RESEARCH_EVENTS) return events
  const structural = events.filter((e) => e.type !== "agent_event")
  const transcriptBudget = Math.max(0, MAX_RESEARCH_EVENTS - structural.length)
  const keptTranscript = events
    .filter((e) => e.type === "agent_event")
    .slice(-transcriptBudget)
  const keep = new Set<ModelResearchClientEvent>([
    ...structural,
    ...keptTranscript,
  ])
  return events.filter((e) => keep.has(e))
}

/**
 * If a half-finished run was restored from localStorage but the server has no
 * record of it (process restarted), close it out so the panel doesn't show a
 * perpetual "running" spinner.
 */
export function sealStaleResearchEvents(
  events: ModelResearchClientEvent[]
): ModelResearchClientEvent[] {
  if (events.length === 0 || events.some(isTerminalResearchEvent)) return events
  return [
    ...events,
    {
      type: "stopped",
      message: "Previous research run is no longer active",
      at: Date.now(),
    },
  ]
}

export function readStoredResearchEvents(): ModelResearchClientEvent[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(RESEARCH_EVENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const events = parsed as ModelResearchClientEvent[]
    if (containsLegacyCodexMcpTransportError(events)) {
      window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
      return []
    }
    return capResearchEvents(events)
  } catch {
    return []
  }
}

export function containsLegacyCodexMcpTransportError(
  events: ModelResearchClientEvent[]
): boolean {
  return events.some((event) => {
    if (event.type !== "error" && event.type !== "model_result") return false
    const message = event.type === "error" ? event.message : event.error
    return (
      typeof message === "string" &&
      message.includes("invalid transport") &&
      message.includes("mcp_servers.playwright")
    )
  })
}
