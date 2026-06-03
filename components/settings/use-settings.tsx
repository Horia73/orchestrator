"use client"

import * as React from "react"
import type {
  BrowserAgentModelSettings,
  BrowserAgentModelSlot,
  BrowserAgentSettings,
  AgentFallback,
  ModelFeatureValue,
  ModelPricing,
  ProviderDef,
  RuntimeConfig,
  ThinkingLevel,
} from "@/lib/config"
import type { AgentKind, AgentStatus, AgentTier } from "@/lib/ai/agents/types"
import { useAppEvent } from "@/hooks/use-app-events"
import {
  RESEARCH_EVENTS_STORAGE_KEY,
  capResearchEvents,
  containsLegacyCodexMcpTransportError,
  isTerminalResearchEvent,
  readStoredResearchEvents,
  sealStaleResearchEvents,
  type ModelResearchClientEvent,
  type ModelResearchStatusSnapshot,
} from "@/components/settings/model-research-events"

export type { ModelResearchClientEvent } from "@/components/settings/model-research-events"

export interface AgentInfo {
  id: string
  name: string
  description: string
  kind: AgentKind
  status: AgentStatus
  tier: AgentTier
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
  fallbacks?: AgentFallback[]
}

interface SettingsContextValue {
  data: SettingsBootstrap | null
  loading: boolean
  error: string | null
  /** Set or replace the override for an agent. Optimistic with rollback. */
  setAgentOverride: (
    agentId: string,
    override: AgentOverrideInput
  ) => Promise<void>
  /** Set the light/pro model used internally by the browser agent. */
  setBrowserAgentModel: (
    slot: BrowserAgentModelSlot,
    override: BrowserAgentModelSettings
  ) => Promise<void>
  /** Set how browser_agent chooses its browser automation backend. */
  setBrowserAgentBackend: (
    backend: BrowserAgentSettings["backend"]
  ) => Promise<void>
  /** Toggle the browser agent's pro/escalation model (single vs multi mode). */
  setBrowserAgentProEnabled: (proEnabled: boolean) => Promise<void>
  /** Clear the override for an agent — falls back to global defaults. */
  clearAgentOverride: (agentId: string) => Promise<void>
  /** Replace the agent settings sidebar order. Optimistic with rollback. */
  setAgentOrder: (agentOrder: string[]) => Promise<void>
  /** Replace the favorites list (used after toggle/reorder). Optimistic with rollback. */
  setFavorites: (favorites: string[]) => Promise<void>
  /** Toggle archived state for a single model (curated layer). Optimistic. */
  setArchived: (
    providerId: string,
    modelId: string,
    archived: boolean
  ) => Promise<void>
  /**
   * Patch curated overrides for a model — pricing, thinking levels, context, etc.
   * Pass `null` for pricing to mark explicitly unknown; omit fields you don't want to touch.
   */
  curateModel: (
    providerId: string,
    modelId: string,
    patch: CurateModelPatch
  ) => Promise<void>
  /** Pull fresh model list from each provider's listModels endpoint. */
  refreshModels: () => Promise<RefreshResult>
  /** Run the researcher against every active model and stream progress events. */
  researchModels: () => Promise<ModelResearchClientEvent[]>
  /** Re-run the researcher against a single model (even if already complete). */
  researchModel: (
    providerId: string,
    modelId: string
  ) => Promise<ModelResearchClientEvent[]>
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

const SettingsContext = React.createContext<SettingsContextValue | null>(null)

function hasUsableModelProvider(data: SettingsBootstrap): boolean {
  return Object.entries(data.providerStatus).some(
    ([providerId, status]) => providerId !== "browser" && status.available
  )
}
/** Order-independent structural equality, used to keep `data` identity stable
 *  across background polls so consumers don't re-render when nothing changed. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false
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

async function fetchSettingsBootstrap(
  signal?: AbortSignal
): Promise<SettingsBootstrap> {
  const res = await fetch("/api/settings/bootstrap", {
    cache: "no-store",
    signal,
  })
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`)
  return (await res.json()) as SettingsBootstrap
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = React.useState<SettingsBootstrap | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [researching, setResearching] = React.useState(false)
  const [researchEvents, setResearchEvents] = React.useState<
    ModelResearchClientEvent[]
  >(readStoredResearchEvents)
  const researchStreamRef = React.useRef<AbortController | null>(null)
  const stopResearchRequestedRef = React.useRef(false)
  const currentRunIdRef = React.useRef<string | null>(null)
  const researchRestoredRef = React.useRef(false)

  const loadBootstrap = React.useCallback(async (signal?: AbortSignal) => {
    const json = await fetchSettingsBootstrap(signal)
    // Keep the same object reference when the payload is unchanged so the
    // context value (and every settings consumer) doesn't re-render on every
    // background refresh.
    setData((prev) => (prev && deepEqual(prev, json) ? prev : json))
    setError(null)
    return json
  }, [])

  const refreshBootstrap = React.useCallback(() => {
    if (typeof window === "undefined") return
    if (document.visibilityState !== "visible") return
    // Don't refresh while a research run is streaming: a bootstrap snapshot can
    // land before the server has persisted a just-researched model and would
    // revert the optimistic patch we applied from `model_result`.
    if (researchStreamRef.current) return
    void loadBootstrap().catch(() => {
      // Keep the last good settings snapshot; transient refresh failures
      // should not blank the Settings page.
    })
  }, [loadBootstrap])

  useAppEvent(["settings.changed", "config.updated"], refreshBootstrap)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      if (researchEvents.length === 0) {
        window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
      } else {
        window.localStorage.setItem(
          RESEARCH_EVENTS_STORAGE_KEY,
          JSON.stringify(capResearchEvents(researchEvents))
        )
      }
    } catch {
      // Local persistence is best-effort; the live stream remains the source of truth.
    }
  }, [researchEvents])

  React.useEffect(() => {
    if (!data) return
    if (hasUsableModelProvider(data)) return

    if (researchStreamRef.current) {
      stopResearchRequestedRef.current = true
      researchStreamRef.current.abort()
      researchStreamRef.current = null
      setResearching(false)
    }
    if (researchEvents.length === 0 && currentRunIdRef.current === null) return

    setResearchEvents([])
    currentRunIdRef.current = null
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
    }
    void fetch("/api/models/research", { method: "DELETE" }).catch(() => {})
  }, [data, researchEvents.length])

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
      if (!cancelled) refreshBootstrap()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh()
    }

    window.addEventListener("focus", refresh)
    window.addEventListener("orchestrator:config-updated", refresh)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      window.removeEventListener("focus", refresh)
      window.removeEventListener("orchestrator:config-updated", refresh)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [refreshBootstrap])

  const setAgentOverride = React.useCallback(
    async (agentId: string, override: AgentOverrideInput) => {
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          config: {
            ...prev.config,
            agentOverrides: {
              ...prev.config.agentOverrides,
              [agentId]: override,
            },
          },
        }
      })

      const res = await fetch(
        `/api/config/agent/${encodeURIComponent(agentId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(override),
        }
      )

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        // Rollback by re-fetching the canonical state.
        const refresh = await fetch("/api/settings/bootstrap")
        if (refresh.ok) setData(await refresh.json())
        throw new Error(json.error || `Save failed (${res.status})`)
      }

      // Server returned the canonical AppConfig; merge it in but keep RuntimeConfig fields fresh.
      const json = (await res.json()) as { config: RuntimeConfig }
      setData((prev) =>
        prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev
      )
    },
    []
  )

  const setBrowserAgentModel = React.useCallback(
    async (
      slot: BrowserAgentModelSlot,
      override: BrowserAgentModelSettings
    ) => {
      setData((prev) => {
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
      setData((prev) =>
        prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev
      )
    },
    []
  )

  const setBrowserAgentBackend = React.useCallback(
    async (backend: BrowserAgentSettings["backend"]) => {
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          config: {
            ...prev.config,
            browserAgent: {
              ...prev.config.browserAgent,
              backend,
            },
            browserAgentBackend: {
              ...prev.config.browserAgentBackend,
              configured: backend,
            },
          },
        }
      })

      const res = await fetch("/api/config/browser-agent/backend", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        const refresh = await fetch("/api/settings/bootstrap")
        if (refresh.ok) setData(await refresh.json())
        throw new Error(json.error || `Save failed (${res.status})`)
      }

      const json = (await res.json()) as { config: RuntimeConfig }
      setData((prev) =>
        prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev
      )
    },
    []
  )

  const setBrowserAgentProEnabled = React.useCallback(
    async (proEnabled: boolean) => {
      setData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          config: {
            ...prev.config,
            browserAgent: {
              ...prev.config.browserAgent,
              proEnabled,
            },
          },
        }
      })

      const res = await fetch("/api/config/browser-agent/pro-enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proEnabled }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        const refresh = await fetch("/api/settings/bootstrap")
        if (refresh.ok) setData(await refresh.json())
        throw new Error(json.error || `Save failed (${res.status})`)
      }

      const json = (await res.json()) as { config: RuntimeConfig }
      setData((prev) =>
        prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev
      )
    },
    []
  )

  const clearAgentOverride = React.useCallback(async (agentId: string) => {
    setData((prev) => {
      if (!prev) return prev
      const next = { ...prev.config.agentOverrides }
      delete next[agentId]
      return { ...prev, config: { ...prev.config, agentOverrides: next } }
    })

    const res = await fetch(
      `/api/config/agent/${encodeURIComponent(agentId)}`,
      {
        method: "DELETE",
      }
    )

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Reset failed (${res.status})`)
    }

    const json = (await res.json()) as { config: RuntimeConfig }
    setData((prev) =>
      prev ? { ...prev, config: { ...prev.config, ...json.config } } : prev
    )
  }, [])

  const setAgentOrder = React.useCallback(async (agentOrder: string[]) => {
    setData((prev) => {
      if (!prev) return prev
      return { ...prev, config: { ...prev.config, agentOrder } }
    })

    const res = await fetch("/api/config/agent-order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentOrder }),
    })

    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      throw new Error(json.error || `Save failed (${res.status})`)
    }

    const json = (await res.json()) as { agentOrder: string[] }
    setData((prev) =>
      prev
        ? { ...prev, config: { ...prev.config, agentOrder: json.agentOrder } }
        : prev
    )
  }, [])

  const setFavorites = React.useCallback(async (favorites: string[]) => {
    setData((prev) => {
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
    setData((prev) =>
      prev
        ? { ...prev, config: { ...prev.config, favorites: json.favorites } }
        : prev
    )
  }, [])

  const setArchived = React.useCallback(
    async (providerId: string, modelId: string, archived: boolean) => {
      // Optimistic: flip the flag on the local registry and (when archiving) drop
      // the model from favorites — matches what the server does.
      setData((prev) => {
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
          ? prev.config.favorites.filter((f) => f !== key)
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
    },
    []
  )

  const curateModel = React.useCallback(
    async (providerId: string, modelId: string, patch: CurateModelPatch) => {
      // Optimistic: apply locally before round-trip so the form snaps shut fast.
      setData((prev) => {
        if (!prev) return prev
        const provider = prev.providers[providerId]
        if (!provider) return prev
        const model = provider.models[modelId]
        if (!model) return prev
        const next = { ...model } as typeof model
        if (patch.pricing !== undefined) next.pricing = patch.pricing
        if (patch.thinkingLevels !== undefined)
          next.thinkingLevels = patch.thinkingLevels
        if (patch.defaultThinkingLevel !== undefined)
          next.defaultThinkingLevel = patch.defaultThinkingLevel
        if (patch.contextWindow !== undefined)
          next.contextWindow = patch.contextWindow
        if (patch.maxOutputTokens !== undefined)
          next.maxOutputTokens = patch.maxOutputTokens
        if (patch.knowledgeCutoff !== undefined)
          next.knowledgeCutoff = patch.knowledgeCutoff
        if (patch.notes !== undefined) next.notes = patch.notes
        if (patch.displayNameOverride !== undefined)
          next.name = patch.displayNameOverride
        if (patch.customMetadata !== undefined)
          next.customMetadata = patch.customMetadata
        // Re-derive completeness so the badge clears instantly when filled.
        const hasPricing = next.pricing !== null
        const hasThinking = next.thinkingLevels !== undefined
        next.dataCompleteness = next.archived
          ? "archived"
          : hasPricing && hasThinking
            ? "complete"
            : "incomplete"
        return {
          ...prev,
          providers: {
            ...prev.providers,
            [providerId]: {
              ...provider,
              models: { ...provider.models, [modelId]: next },
            },
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
    },
    []
  )

  const refreshModels = React.useCallback(async (): Promise<RefreshResult> => {
    setRefreshing(true)
    try {
      const res = await fetch("/api/models/refresh", { method: "POST" })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Refresh failed (${res.status})`)
      }
      const json = (await res.json()) as RefreshResult
      // Re-pull bootstrap so AgentInfo and providerStatus stay in sync with
      // the new registry shape (kinds/models may have changed).
      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      return json
    } finally {
      setRefreshing(false)
    }
  }, [])

  const applyResearchedModel = React.useCallback(
    (key: string, model: ProviderDef["models"][string]) => {
      const separator = key.indexOf(":")
      if (separator <= 0) return
      const providerId = key.slice(0, separator)
      const modelId = key.slice(separator + 1)
      setData((prev) => {
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
    },
    []
  )

  const storeResearchEvent = React.useCallback(
    (event: ModelResearchClientEvent) => {
      if (event.type === "ready") {
        const runId = event.runId
        const prevRunId = currentRunIdRef.current
        if (runId) currentRunIdRef.current = runId
        setResearchEvents((prev) => {
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
          return capResearchEvents([
            event,
            ...prev.filter((e) => e.type !== "ready"),
          ])
        })
        return
      }
      const runId = "runId" in event ? event.runId : undefined
      if (runId) currentRunIdRef.current = runId
      setResearchEvents((prev) => capResearchEvents([...prev, event]))
      if (event.type === "model_result" && event.model) {
        applyResearchedModel(event.key, event.model)
      }
    },
    [applyResearchedModel]
  )

  const attachResearchStream = React.useCallback(async (
    target?: { providerId: string; modelId: string }
  ): Promise<ModelResearchClientEvent[]> => {
    if (researchStreamRef.current) {
      throw new Error("Research already running")
    }
    const controller = new AbortController()
    researchStreamRef.current = controller
    stopResearchRequestedRef.current = false
    setResearching(true)
    const captured: ModelResearchClientEvent[] = []
    try {
      const res = await fetch("/api/models/research", {
        method: "POST",
        signal: controller.signal,
        ...(target
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(target),
            }
          : {}),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `Research failed (${res.status})`)
      }
      if (!res.body) throw new Error("Research stream did not open")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLines = frame
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
          if (dataLines.length === 0) continue
          try {
            const parsed = JSON.parse(
              dataLines.join("\n")
            ) as ModelResearchClientEvent
            const event = { ...parsed, at: parsed.at ?? Date.now() }
            captured.push(event)
            storeResearchEvent(event)
          } catch {
            // Ignore malformed progress frames; server-side errors arrive as explicit events.
          }
        }
      }

      const refresh = await fetch("/api/settings/bootstrap")
      if (refresh.ok) setData(await refresh.json())
      return captured
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        if (stopResearchRequestedRef.current) {
          const stopped: ModelResearchClientEvent = {
            type: "stopped",
            message: "Research stopped",
            at: Date.now(),
          }
          captured.push(stopped)
          storeResearchEvent(stopped)
        }
        const refresh = await fetch("/api/settings/bootstrap").catch(() => null)
        if (refresh?.ok) setData(await refresh.json())
        return captured
      }
      throw err
    } finally {
      if (researchStreamRef.current === controller)
        researchStreamRef.current = null
      stopResearchRequestedRef.current = false
      setResearching(false)
    }
  }, [storeResearchEvent])

  React.useEffect(() => {
    if (!data) return
    if (researchRestoredRef.current) return
    if (!hasUsableModelProvider(data)) return
    researchRestoredRef.current = true
    let cancelled = false

    async function restoreActiveResearchRun() {
      const res = await fetch("/api/models/research", { method: "GET" }).catch(
        () => null
      )
      if (!res?.ok || cancelled) return
      const snapshot = (await res
        .json()
        .catch(() => null)) as ModelResearchStatusSnapshot | null
      if (!snapshot || cancelled) return
      if (
        Array.isArray(snapshot.events) &&
        containsLegacyCodexMcpTransportError(snapshot.events)
      ) {
        setResearchEvents([])
        currentRunIdRef.current = null
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(RESEARCH_EVENTS_STORAGE_KEY)
        }
        void fetch("/api/models/research", { method: "DELETE" }).catch(() => {})
        return
      }
      if (snapshot.runId) currentRunIdRef.current = snapshot.runId
      if (Array.isArray(snapshot.events) && snapshot.events.length > 0) {
        const events = capResearchEvents(
          snapshot.events.map((event) => ({
            ...event,
            at: event.at ?? Date.now(),
          }))
        )
        setResearchEvents(events)
        for (const event of events) {
          if (event.type === "model_result" && event.model)
            applyResearchedModel(event.key, event.model)
        }
      } else if (snapshot.status === "idle") {
        // Server has no record of a run — close out any half-finished run we
        // restored from localStorage so the panel doesn't spin forever.
        setResearchEvents((prev) => sealStaleResearchEvents(prev))
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
  }, [data, applyResearchedModel, attachResearchStream])

  const researchModels = React.useCallback(async (): Promise<
    ModelResearchClientEvent[]
  > => {
    return attachResearchStream()
  }, [attachResearchStream])

  const researchModel = React.useCallback(
    async (
      providerId: string,
      modelId: string
    ): Promise<ModelResearchClientEvent[]> => {
      return attachResearchStream({ providerId, modelId })
    },
    [attachResearchStream]
  )

  const stopResearchModels = React.useCallback(() => {
    stopResearchRequestedRef.current = true
    void fetch("/api/models/research", { method: "DELETE" }).catch(() => {
      researchStreamRef.current?.abort()
    })
  }, [])

  const clearResearchEvents = React.useCallback(() => {
    setResearchEvents([])
    currentRunIdRef.current = null
    void fetch("/api/models/research", { method: "DELETE" }).catch(() => {})
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
      setBrowserAgentBackend,
      setBrowserAgentProEnabled,
      clearAgentOverride,
      setAgentOrder,
      setFavorites,
      setArchived,
      curateModel,
      refreshModels,
      researchModels,
      researchModel,
      stopResearchModels,
      refreshing,
      researching,
      researchEvents,
      clearResearchEvents,
    }),
    [
      data,
      loading,
      error,
      setAgentOverride,
      setBrowserAgentModel,
      setBrowserAgentBackend,
      setBrowserAgentProEnabled,
      clearAgentOverride,
      setAgentOrder,
      setFavorites,
      setArchived,
      curateModel,
      refreshModels,
      researchModels,
      researchModel,
      stopResearchModels,
      refreshing,
      researching,
      researchEvents,
      clearResearchEvents,
    ]
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

export function useSettings(): SettingsContextValue {
  const ctx = React.useContext(SettingsContext)
  if (!ctx)
    throw new Error("useSettings must be used within <SettingsProvider>")
  return ctx
}
