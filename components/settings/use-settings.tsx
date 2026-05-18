"use client"

import * as React from "react"
import type { BrowserAgentModelSettings, BrowserAgentModelSlot, ModelFeatureValue, ModelPricing, ProviderDef, RuntimeConfig, ThinkingLevel } from "@/lib/config"
import type { AgentKind, AgentStatus } from "@/lib/ai/agents/types"

export interface AgentInfo {
  id: string
  name: string
  description: string
  kind: AgentKind
  status: AgentStatus
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: ThinkingLevel
  canCallAgents: string[]
}

export interface ProviderStatus {
  available: boolean
  authKind: "api-key" | "cli" | "none"
  apiKeyConfigured: boolean
  apiKeyMasked: string | null
  cliInstalled?: boolean
  cliLoggedIn?: boolean
  cliName?: string
  unavailableReason: string | null
  chatMessage: string | null
}

export interface SettingsBootstrap {
  config: RuntimeConfig
  agents: AgentInfo[]
  providers: Record<string, ProviderDef>
  providerStatus: Record<string, ProviderStatus>
}

export interface AgentOverrideInput {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
  modelOptions?: Record<string, ModelFeatureValue>
}

interface SettingsContextValue {
  data: SettingsBootstrap | null
  loading: boolean
  error: string | null
  /** Set or replace the override for an agent. Optimistic with rollback. */
  setAgentOverride: (agentId: string, override: AgentOverrideInput) => Promise<void>
  /** Set the light/pro model used internally by the browser agent. */
  setBrowserAgentModel: (slot: BrowserAgentModelSlot, override: BrowserAgentModelSettings) => Promise<void>
  /** Clear the override for an agent — falls back to global defaults. */
  clearAgentOverride: (agentId: string) => Promise<void>
  /** Replace the favorites list (used after toggle/reorder). Optimistic with rollback. */
  setFavorites: (favorites: string[]) => Promise<void>
  /** Toggle archived state for a single model (curated layer). Optimistic. */
  setArchived: (providerId: string, modelId: string, archived: boolean) => Promise<void>
  /**
   * Patch curated overrides for a model — pricing, thinking levels, context, etc.
   * Pass `null` for pricing to mark explicitly unknown; omit fields you don't want to touch.
   */
  curateModel: (providerId: string, modelId: string, patch: CurateModelPatch) => Promise<void>
  /** Pull fresh model list from each provider's listModels endpoint. */
  refreshModels: () => Promise<RefreshResult>
  /** Run the researcher against every active model and stream progress events. */
  researchModels: () => Promise<ModelResearchClientEvent[]>
  stopResearchModels: () => void
  /** True while a refresh is in flight (drives spinner / disabled state). */
  refreshing: boolean
  researching: boolean
  researchEvents: ModelResearchClientEvent[]
  clearResearchEvents: () => void
}

export interface CurateModelPatch {
  pricing?: ModelPricing | null
  thinkingLevels?: ThinkingLevel[]
  defaultThinkingLevel?: ThinkingLevel
  contextWindow?: number
  maxOutputTokens?: number
  knowledgeCutoff?: string
  notes?: string
  displayNameOverride?: string
  customMetadata?: ProviderDef["models"][string]["customMetadata"]
}

export interface RefreshResult {
  results: Record<string, { fetched: number; error?: string; skipped?: string }>
}

type ModelResearchEventBase = { at?: number }

export type ModelResearchClientEvent = ModelResearchEventBase & (
  | { type: "ready"; runId?: string; total: number; concurrency?: number }
  | { type: "model_start"; key: string; providerId: string; modelId: string; name: string; index: number; total: number; missing: string[] }
  | { type: "agent_event"; key: string; event: Record<string, unknown> }
  | { type: "model_retry"; key: string; attempt: number; maxAttempts: number; reason: string }
  | { type: "model_result"; key: string; status: "updated" | "unchanged" | "incomplete" | "failed"; summary?: string; error?: string; remainingMissing?: string[]; unresolved?: Array<{ field: string; reason?: string }>; model?: ProviderDef["models"][string] }
  | { type: "done"; runId?: string; total: number; updated: number; incomplete: number; failed: number }
  | { type: "stopped"; runId?: string; message: string }
  | { type: "error"; runId?: string; message: string }
)

const SettingsContext = React.createContext<SettingsContextValue | null>(null)
const RESEARCH_EVENTS_STORAGE_KEY = "orchestrator:model-research-events:v1"
const MAX_RESEARCH_EVENTS = 400

function isTerminalResearchEvent(event: ModelResearchClientEvent): boolean {
  return event.type === "done" || event.type === "stopped" || event.type === "error"
}

/**
 * Cap the event buffer WITHOUT ever dropping structural events. The previous
 * implementation kept only the last N events, which evicted the `ready` event
 * (it is always first) on any real run — and once `ready` is gone the progress
 * counter loses its denominator and renders "3/0". We keep every structural
 * event (bounded ~ models×3) and only ring-buffer the high-volume agent
 * transcript.
 */
function capResearchEvents(events: ModelResearchClientEvent[]): ModelResearchClientEvent[] {
  if (events.length <= MAX_RESEARCH_EVENTS) return events
  const structural = events.filter(e => e.type !== "agent_event")
  const transcriptBudget = Math.max(0, MAX_RESEARCH_EVENTS - structural.length)
  const keptTranscript = events.filter(e => e.type === "agent_event").slice(-transcriptBudget)
  const keep = new Set<ModelResearchClientEvent>([...structural, ...keptTranscript])
  return events.filter(e => keep.has(e))
}

/**
 * If a half-finished run was restored from localStorage but the server has no
 * record of it (process restarted), close it out so the panel doesn't show a
 * perpetual "running" spinner.
 */
function sealStaleResearchEvents(events: ModelResearchClientEvent[]): ModelResearchClientEvent[] {
  if (events.length === 0 || events.some(isTerminalResearchEvent)) return events
  return [...events, { type: "stopped", message: "Previous research run is no longer active", at: Date.now() }]
}
// Live reconciliation cadence. The research panel itself is already real-time
// over the SSE stream (transcript + per-model results patch the registry
// optimistically the instant they arrive); this poll keeps the rest of the
// registry fresh. It can run tight because `deepEqual` below makes an
// unchanged payload a no-op — identical data keeps the same object reference,
// so a poll that finds nothing new triggers zero re-renders (no dropdown
// close, no flicker). Changed data still lands within one tick.
const SETTINGS_SYNC_INTERVAL_MS = 1000

/** Order-independent structural equality, used to keep `data` identity stable
 *  across background polls so consumers don't re-render when nothing changed. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr && bArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

interface ModelResearchStatusSnapshot {
  running: boolean
  runId: string | null
  status: "idle" | "running" | "done" | "stopped" | "error"
  startedAt: number | null
  endedAt: number | null
  concurrency: number
  events: ModelResearchClientEvent[]
}

function readStoredResearchEvents(): ModelResearchClientEvent[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(RESEARCH_EVENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? capResearchEvents(parsed as ModelResearchClientEvent[]) : []
  } catch {
    return []
  }
}

async function fetchSettingsBootstrap(signal?: AbortSignal): Promise<SettingsBootstrap> {
  const res = await fetch("/api/settings/bootstrap", { cache: "no-store", signal })
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`)
  return (await res.json()) as SettingsBootstrap
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = React.useState<SettingsBootstrap | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [researching, setResearching] = React.useState(false)
  const [researchEvents, setResearchEvents] = React.useState<ModelResearchClientEvent[]>(readStoredResearchEvents)
  const researchStreamRef = React.useRef<AbortController | null>(null)
  const stopResearchRequestedRef = React.useRef(false)
  const currentRunIdRef = React.useRef<string | null>(null)
  const researchRestoredRef = React.useRef(false)

  const loadBootstrap = React.useCallback(async (signal?: AbortSignal) => {
    const json = await fetchSettingsBootstrap(signal)
    // Keep the same object reference when the payload is unchanged so the
    // context value (and every settings consumer) doesn't re-render on every
    // background poll.
    setData(prev => (prev && deepEqual(prev, json) ? prev : json))
    setError(null)
    return json
  }, [])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      if (researchEvents.length === 0) {
        window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
      } else {
        window.localStorage.setItem(RESEARCH_EVENTS_STORAGE_KEY, JSON.stringify(capResearchEvents(researchEvents)))
      }
    } catch {
      // Local persistence is best-effort; the live stream remains the source of truth.
    }
  }, [researchEvents])

  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)

    loadBootstrap(controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return
        setError(err instanceof Error ? err.message : "Unknown error")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => {
      controller.abort()
    }
  }, [loadBootstrap])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    let cancelled = false

    const refresh = () => {
      if (cancelled || document.visibilityState !== "visible") return
      // Don't poll while a research run is streaming: a bootstrap snapshot can
      // land before the server has persisted a just-researched model and would
      // revert the optimistic patch we applied from `model_result`.
      if (researchStreamRef.current) return
      void loadBootstrap().catch(() => {
        // Keep the last good settings snapshot; transient polling failures
        // should not blank the Settings page.
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh()
    }

    const interval = window.setInterval(refresh, SETTINGS_SYNC_INTERVAL_MS)
    window.addEventListener("focus", refresh)
    window.addEventListener("orchestrator:config-updated", refresh)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("orchestrator:config-updated", refresh)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [loadBootstrap])

  const setAgentOverride = React.useCallback(
    async (agentId: string, override: AgentOverrideInput) => {
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          config: {
            ...prev.config,
            agentOverrides: { ...prev.config.agentOverrides, [agentId]: override },
          },
        }
      })

      const res = await fetch(`/api/config/agent/${encodeURIComponent(agentId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(override),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        // Rollback by re-fetching the canonical state.
        const refresh = await fetch("/api/settings/bootstrap")
        if (refresh.ok) setData(await refresh.json())
        throw new Error(json.error || `Save failed (${res.status})`)
      }

      // Server returned the canonical AppConfig; merge it in but keep RuntimeConfig fields fresh.
      const json = (await res.json()) as { config: RuntimeConfig }
      setData(prev => (prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev))
    },
    []
  )

  const setBrowserAgentModel = React.useCallback(
    async (slot: BrowserAgentModelSlot, override: BrowserAgentModelSettings) => {
      setData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          config: {
            ...prev.config,
            browserAgent: {
              ...prev.config.browserAgent,
              [slot]: override,
            },
          },
        }
      })

      const res = await fetch("/api/config/browser-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, ...override }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        const refresh = await fetch("/api/settings/bootstrap")
        if (refresh.ok) setData(await refresh.json())
        throw new Error(json.error || `Save failed (${res.status})`)
      }

      const json = (await res.json()) as { config: RuntimeConfig }
      setData(prev => (prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev))
    },
    []
  )

  const clearAgentOverride = React.useCallback(async (agentId: string) => {
    setData(prev => {
      if (!prev) return prev
      const next = { ...prev.config.agentOverrides }
      delete next[agentId]
      return { ...prev, config: { ...prev.config, agentOverrides: next } }
    })

    const res = await fetch(`/api/config/agent/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    })

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Reset failed (${res.status})`)
    }

    const json = (await res.json()) as { config: RuntimeConfig }
    setData(prev => (prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev))
  }, [])

  const setFavorites = React.useCallback(async (favorites: string[]) => {
    setData(prev => {
      if (!prev) return prev
      return { ...prev, config: { ...prev.config, favorites } }
    })

    const res = await fetch("/api/config/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorites }),
    })

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Save failed (${res.status})`)
    }

    const json = (await res.json()) as { favorites: string[] }
    setData(prev => (prev ? { ...prev, config: { ...prev.config, favorites: json.favorites } } : prev))
  }, [])

  const setArchived = React.useCallback(async (providerId: string, modelId: string, archived: boolean) => {
    // Optimistic: flip the flag on the local registry and (when archiving) drop
    // the model from favorites — matches what the server does.
    setData(prev => {
      if (!prev) return prev
      const provider = prev.providers[providerId]
      if (!provider) return prev
      const model = provider.models[modelId]
      if (!model) return prev
      const nextProviders = {
        ...prev.providers,
        [providerId]: {
          ...provider,
          models: {
            ...provider.models,
            [modelId]: { ...model, archived },
          },
        },
      }
      const key = `${providerId}:${modelId}`
      const nextFavorites = archived
        ? prev.config.favorites.filter(f => f !== key)
        : prev.config.favorites
      return {
        ...prev,
        providers: nextProviders,
        config: { ...prev.config, favorites: nextFavorites },
      }
    })

    const url = `/api/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}/archive`
    const res = archived
      ? await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        })
      : await fetch(url, { method: "DELETE" })

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      // Re-fetch canonical state on failure so we don't drift.
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Archive change failed (${res.status})`)
    }
  }, [])

  const curateModel = React.useCallback(async (providerId: string, modelId: string, patch: CurateModelPatch) => {
    // Optimistic: apply locally before round-trip so the form snaps shut fast.
    setData(prev => {
      if (!prev) return prev
      const provider = prev.providers[providerId]
      if (!provider) return prev
      const model = provider.models[modelId]
      if (!model) return prev
      const next = { ...model } as typeof model
      if (patch.pricing !== undefined) next.pricing = patch.pricing
      if (patch.thinkingLevels !== undefined) next.thinkingLevels = patch.thinkingLevels
      if (patch.defaultThinkingLevel !== undefined) next.defaultThinkingLevel = patch.defaultThinkingLevel
      if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow
      if (patch.maxOutputTokens !== undefined) next.maxOutputTokens = patch.maxOutputTokens
      if (patch.knowledgeCutoff !== undefined) next.knowledgeCutoff = patch.knowledgeCutoff
      if (patch.notes !== undefined) next.notes = patch.notes
      if (patch.displayNameOverride !== undefined) next.name = patch.displayNameOverride
      if (patch.customMetadata !== undefined) next.customMetadata = patch.customMetadata
      // Re-derive completeness so the badge clears instantly when filled.
      const hasPricing = next.pricing !== null
      const hasThinking = next.thinkingLevels !== undefined
      next.dataCompleteness = next.archived ? "archived" : hasPricing && hasThinking ? "complete" : "incomplete"
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [providerId]: { ...provider, models: { ...provider.models, [modelId]: next } },
        },
      }
    })

    const res = await fetch(
      `/api/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}/curate`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }
    )
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Curate failed (${res.status})`)
    }
  }, [])

  const refreshModels = React.useCallback(async (): Promise<RefreshResult> => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/models/refresh', { method: 'POST' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Refresh failed (${res.status})`)
      }
      const json = (await res.json()) as RefreshResult
      // Re-pull bootstrap so AgentInfo and providerStatus stay in sync with
      // the new registry shape (kinds/models may have changed).
      const refresh = await fetch('/api/settings/bootstrap')
      if (refresh.ok) setData(await refresh.json())
      return json
    } finally {
      setRefreshing(false)
    }
  }, [])

  const applyResearchedModel = React.useCallback((key: string, model: ProviderDef["models"][string]) => {
    const separator = key.indexOf(":")
    if (separator <= 0) return
    const providerId = key.slice(0, separator)
    const modelId = key.slice(separator + 1)
    setData(prev => {
      if (!prev) return prev
      const provider = prev.providers[providerId]
      if (!provider) return prev
      if (!provider.models[modelId]) return prev
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [providerId]: {
            ...provider,
            models: {
              ...provider.models,
              [modelId]: model,
            },
          },
        },
      }
    })
  }, [])

  const storeResearchEvent = React.useCallback((event: ModelResearchClientEvent) => {
    if (event.type === "ready") {
      const runId = event.runId
      const prevRunId = currentRunIdRef.current
      if (runId) currentRunIdRef.current = runId
      setResearchEvents(prev => {
        // Reset only for a genuinely NEW run — not for the `ready` the server
        // replays every time the SSE reconnects (e.g. after a refresh). Without
        // this, a reconnect wiped the whole accumulated timeline.
        const isNewRun =
          !runId ||
          prevRunId === null ||
          runId !== prevRunId ||
          prev.some(isTerminalResearchEvent)
        if (isNewRun) return [event]
        // Same run replayed: dedupe `ready`, keep the accumulated timeline.
        return capResearchEvents([event, ...prev.filter(e => e.type !== "ready")])
      })
      return
    }
    const runId = "runId" in event ? event.runId : undefined
    if (runId) currentRunIdRef.current = runId
    setResearchEvents(prev => capResearchEvents([...prev, event]))
    if (event.type === "model_result" && event.model) {
      applyResearchedModel(event.key, event.model)
    }
  }, [applyResearchedModel])

  const attachResearchStream = React.useCallback(async (): Promise<ModelResearchClientEvent[]> => {
    if (researchStreamRef.current) {
      throw new Error("Research already running")
    }
    const controller = new AbortController()
    researchStreamRef.current = controller
    stopResearchRequestedRef.current = false
    setResearching(true)
    const captured: ModelResearchClientEvent[] = []
    try {
      const res = await fetch('/api/models/research', { method: 'POST', signal: controller.signal })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Research failed (${res.status})`)
      }
      if (!res.body) throw new Error('Research stream did not open')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLines = frame
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
          if (dataLines.length === 0) continue
          try {
            const parsed = JSON.parse(dataLines.join('\n')) as ModelResearchClientEvent
            const event = { ...parsed, at: parsed.at ?? Date.now() }
            captured.push(event)
            storeResearchEvent(event)
          } catch {
            // Ignore malformed progress frames; server-side errors arrive as explicit events.
          }
        }
      }

      const refresh = await fetch('/api/settings/bootstrap')
      if (refresh.ok) setData(await refresh.json())
      return captured
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        if (stopResearchRequestedRef.current) {
          const stopped: ModelResearchClientEvent = { type: "stopped", message: "Research stopped", at: Date.now() }
          captured.push(stopped)
          storeResearchEvent(stopped)
        }
        const refresh = await fetch('/api/settings/bootstrap').catch(() => null)
        if (refresh?.ok) setData(await refresh.json())
        return captured
      }
      throw err
    } finally {
      if (researchStreamRef.current === controller) researchStreamRef.current = null
      stopResearchRequestedRef.current = false
      setResearching(false)
    }
  }, [storeResearchEvent])

  React.useEffect(() => {
    if (researchRestoredRef.current) return
    researchRestoredRef.current = true
    let cancelled = false

    async function restoreActiveResearchRun() {
      const res = await fetch('/api/models/research', { method: 'GET' }).catch(() => null)
      if (!res?.ok || cancelled) return
      const snapshot = (await res.json().catch(() => null)) as ModelResearchStatusSnapshot | null
      if (!snapshot || cancelled) return
      if (snapshot.runId) currentRunIdRef.current = snapshot.runId
      if (Array.isArray(snapshot.events) && snapshot.events.length > 0) {
        const events = capResearchEvents(snapshot.events.map(event => ({ ...event, at: event.at ?? Date.now() })))
        setResearchEvents(events)
        for (const event of events) {
          if (event.type === "model_result" && event.model) applyResearchedModel(event.key, event.model)
        }
      } else if (snapshot.status === "idle") {
        // Server has no record of a run — close out any half-finished run we
        // restored from localStorage so the panel doesn't spin forever.
        setResearchEvents(prev => sealStaleResearchEvents(prev))
      }
      if (snapshot.running && !researchStreamRef.current) {
        void attachResearchStream().catch(() => {
          if (!cancelled) setResearching(false)
        })
      }
    }

    void restoreActiveResearchRun()
    return () => {
      cancelled = true
      researchStreamRef.current?.abort()
      // Re-enable restore so it runs again on remount (StrictMode double-mount
      // in dev, and navigating back into Settings).
      researchRestoredRef.current = false
    }
  }, [applyResearchedModel, attachResearchStream])

  const researchModels = React.useCallback(async (): Promise<ModelResearchClientEvent[]> => {
    return attachResearchStream()
  }, [attachResearchStream])

  const stopResearchModels = React.useCallback(() => {
    stopResearchRequestedRef.current = true
    void fetch('/api/models/research', { method: 'DELETE' }).catch(() => {
      researchStreamRef.current?.abort()
    })
  }, [])

  const clearResearchEvents = React.useCallback(() => {
    setResearchEvents([])
    currentRunIdRef.current = null
    void fetch('/api/models/research', { method: 'DELETE' }).catch(() => {})
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
    }
  }, [])

  const value = React.useMemo<SettingsContextValue>(
    () => ({
      data,
      loading,
      error,
      setAgentOverride,
      setBrowserAgentModel,
      clearAgentOverride,
      setFavorites,
      setArchived,
      curateModel,
      refreshModels,
      researchModels,
      stopResearchModels,
      refreshing,
      researching,
      researchEvents,
      clearResearchEvents,
    }),
    [data, loading, error, setAgentOverride, setBrowserAgentModel, clearAgentOverride, setFavorites, setArchived, curateModel, refreshModels, researchModels, stopResearchModels, refreshing, researching, researchEvents, clearResearchEvents]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

export function useSettings(): SettingsContextValue {
  const ctx = React.useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>")
  return ctx
}
