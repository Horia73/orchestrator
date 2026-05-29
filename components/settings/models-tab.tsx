"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle,
  CheckCircle2,
  GripVertical,
  Loader2,
  RefreshCcw,
  Search,
  Square,
} from "lucide-react"

import { cn } from "@/lib/utils"

import { AgentCard } from "@/components/settings/agent-card"
import { ModelRegistrySummary } from "@/components/settings/models-registry-summary"
import {
  ResearchProgressPanel,
  type CurrentModelResearchStatus,
} from "@/components/settings/research-progress-panel"
import {
  useSettings,
  type AgentInfo,
  type SettingsBootstrap,
} from "@/components/settings/use-settings"
import { useUsage } from "@/components/settings/use-usage"
import type { ProviderDef } from "@/lib/config"
import type { UsageReport } from "@/lib/observability/schema"

const CONTEXT_THINKING_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

export function ModelsTab() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    data,
    loading,
    error,
    refreshModels,
    refreshing,
    researchModels,
    researchModel,
    stopResearchModels,
    researching,
    researchEvents,
    clearResearchEvents,
    setAgentOrder,
  } = useSettings()
  const [lastRefresh, setLastRefresh] = React.useState<{
    ok: boolean
    summary: string
  } | null>(null)
  const [lastResearch, setLastResearch] = React.useState<{
    ok: boolean
    summary: string
  } | null>(null)
  const [researchPreviewOpen, setResearchPreviewOpen] = React.useState(true)
  const [researchStatusOpen, setResearchStatusOpen] = React.useState(false)
  const [researchStatusMode, setResearchStatusMode] = React.useState(false)
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
    null
  )
  const [draggingAgentId, setDraggingAgentId] = React.useState<string | null>(
    null
  )
  const [dragPreviewOrder, setDragPreviewOrder] = React.useState<
    string[] | null
  >(null)
  const { data: usageReport } = useUsage("30d")
  const draggingAgentIdRef = React.useRef<string | null>(null)
  const dragPreviewOrderRef = React.useRef<string[] | null>(null)
  const lastSelectedAgentParamRef = React.useRef<string | null>(null)
  const [agentOrderSaveState, setAgentOrderSaveState] =
    React.useState<AgentOrderSaveState>({ kind: "idle" })
  const hasUsableProviders = data ? hasUsableModelProvider(data) : false
  const researcherReady = data ? isResearcherProviderReady(data) : false
  const researchUnavailableReason = data
    ? getResearchUnavailableReason(data)
    : null
  const researchableModelCount = data
    ? countResearchableModels(data.providers, data.providerStatus)
    : 0
  const savedOrderedAgents = React.useMemo(
    () =>
      data ? orderAgentsByConfig(data.agents, data.config.agentOrder) : [],
    [data]
  )
  const savedAgentIds = React.useMemo(
    () => savedOrderedAgents.map((agent) => agent.id),
    [savedOrderedAgents]
  )
  const orderedAgents = React.useMemo(
    () =>
      data && dragPreviewOrder
        ? orderAgentsByConfig(data.agents, dragPreviewOrder)
        : savedOrderedAgents,
    [data, dragPreviewOrder, savedOrderedAgents]
  )
  const selectedAgentFromUrl = searchParams.get("agent")
  const selectedAgent =
    orderedAgents.find((agent) => agent.id === selectedAgentId) ??
    orderedAgents[0] ??
    null
  const currentResearchStatuses = React.useMemo(
    () =>
      data
        ? buildModelResearchStatuses(data.providers, data.providerStatus)
        : [],
    [data]
  )
  const liveResearchConcurrency = React.useMemo(() => {
    const ready = [...researchEvents]
      .reverse()
      .find((event) => event.type === "ready")
    return ready?.type === "ready" ? (ready.concurrency ?? 6) : 6
  }, [researchEvents])

  React.useEffect(() => {
    if (orderedAgents.length === 0) return
    const ids = new Set(orderedAgents.map((agent) => agent.id))
    const urlAgent =
      selectedAgentFromUrl && ids.has(selectedAgentFromUrl)
        ? selectedAgentFromUrl
        : null
    const urlChanged =
      selectedAgentFromUrl !== lastSelectedAgentParamRef.current
    lastSelectedAgentParamRef.current = selectedAgentFromUrl

    if (urlChanged && urlAgent) {
      if (urlAgent !== selectedAgentId) setSelectedAgentId(urlAgent)
      return
    }

    if (selectedAgentId && ids.has(selectedAgentId)) return
    setSelectedAgentId(urlAgent ?? orderedAgents[0].id)
  }, [orderedAgents, selectedAgentFromUrl, selectedAgentId])

  React.useEffect(() => {
    if (agentOrderSaveState.kind !== "saved") return
    const t = setTimeout(() => setAgentOrderSaveState({ kind: "idle" }), 1800)
    return () => clearTimeout(t)
  }, [agentOrderSaveState])

  const selectAgent = React.useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId)
      const params = new URLSearchParams(searchParams.toString())
      params.set("agent", agentId)
      const query = params.toString()
      router.replace(query ? `/settings?${query}` : "/settings", {
        scroll: false,
      })
    },
    [router, searchParams]
  )

  const persistAgentOrder = React.useCallback(
    async (nextOrder: string[]) => {
      setAgentOrderSaveState({ kind: "saving" })
      try {
        await setAgentOrder(nextOrder)
        setAgentOrderSaveState({ kind: "saved" })
      } catch (err) {
        setAgentOrderSaveState({
          kind: "error",
          message: err instanceof Error ? err.message : "Save failed",
        })
      }
    },
    [setAgentOrder]
  )

  const handleAgentDragStart = React.useCallback(
    (event: React.DragEvent, agentId: string) => {
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", agentId)
      draggingAgentIdRef.current = agentId
      dragPreviewOrderRef.current = savedAgentIds
      setDragPreviewOrder(savedAgentIds)
      setDraggingAgentId(agentId)
    },
    [savedAgentIds]
  )

  const handleAgentDragOver = React.useCallback(
    (event: React.DragEvent, targetAgentId: string) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      const draggedId =
        event.dataTransfer.getData("text/plain") ||
        draggingAgentIdRef.current ||
        draggingAgentId
      if (!draggedId || draggedId === targetAgentId) return

      const rect = event.currentTarget.getBoundingClientRect()
      const placeAfterTarget = event.clientY > rect.top + rect.height / 2
      const currentOrder = dragPreviewOrderRef.current ?? savedAgentIds
      const nextOrder = moveIdAround(
        currentOrder,
        draggedId,
        targetAgentId,
        placeAfterTarget
      )
      if (!sameStringArray(currentOrder, nextOrder)) {
        dragPreviewOrderRef.current = nextOrder
        setDragPreviewOrder(nextOrder)
      }
    },
    [draggingAgentId, savedAgentIds]
  )

  const handleAgentDrop = React.useCallback(
    (event: React.DragEvent, targetAgentId: string) => {
      event.preventDefault()
      const draggedId =
        event.dataTransfer.getData("text/plain") ||
        draggingAgentIdRef.current ||
        draggingAgentId
      if (!draggedId || draggedId === targetAgentId) {
        setDraggingAgentId(null)
        setDragPreviewOrder(null)
        draggingAgentIdRef.current = null
        dragPreviewOrderRef.current = null
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const placeAfterTarget = event.clientY > rect.top + rect.height / 2
      const previewOrder = dragPreviewOrderRef.current ?? savedAgentIds
      const nextOrder =
        dragPreviewOrderRef.current &&
        !sameStringArray(dragPreviewOrderRef.current, savedAgentIds)
          ? previewOrder
          : moveIdAround(
              previewOrder,
              draggedId,
              targetAgentId,
              placeAfterTarget
            )
      setDraggingAgentId(null)
      setDragPreviewOrder(null)
      draggingAgentIdRef.current = null
      dragPreviewOrderRef.current = null
      if (!sameStringArray(nextOrder, savedAgentIds)) {
        void persistAgentOrder(nextOrder)
      }
    },
    [draggingAgentId, persistAgentOrder, savedAgentIds]
  )

  const handleAgentDragOverEnd = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      const draggedId =
        event.dataTransfer.getData("text/plain") ||
        draggingAgentIdRef.current ||
        draggingAgentId
      if (!draggedId) return

      const currentOrder = dragPreviewOrderRef.current ?? savedAgentIds
      const nextOrder = moveIdToEnd(currentOrder, draggedId)
      if (!sameStringArray(currentOrder, nextOrder)) {
        dragPreviewOrderRef.current = nextOrder
        setDragPreviewOrder(nextOrder)
      }
    },
    [draggingAgentId, savedAgentIds]
  )

  const handleAgentDropEnd = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const draggedId =
        event.dataTransfer.getData("text/plain") ||
        draggingAgentIdRef.current ||
        draggingAgentId
      if (!draggedId) {
        setDraggingAgentId(null)
        setDragPreviewOrder(null)
        draggingAgentIdRef.current = null
        dragPreviewOrderRef.current = null
        return
      }

      const previewOrder = dragPreviewOrderRef.current ?? savedAgentIds
      const nextOrder =
        dragPreviewOrderRef.current &&
        !sameStringArray(dragPreviewOrderRef.current, savedAgentIds)
          ? previewOrder
          : moveIdToEnd(previewOrder, draggedId)
      setDraggingAgentId(null)
      setDragPreviewOrder(null)
      draggingAgentIdRef.current = null
      dragPreviewOrderRef.current = null
      if (!sameStringArray(nextOrder, savedAgentIds)) {
        void persistAgentOrder(nextOrder)
      }
    },
    [draggingAgentId, persistAgentOrder, savedAgentIds]
  )

  const handleRefresh = async () => {
    try {
      const result = await refreshModels()
      const summary = Object.entries(result.results)
        .map(([p, r]) => {
          if (r.skipped === "no_api_key") return `${p}: no key`
          if (r.skipped === "not_implemented") return `${p}: stub`
          if (r.error) return `${p}: error`
          return `${p}: +${r.fetched}`
        })
        .join(" · ")
      setLastRefresh({ ok: true, summary })
    } catch (err) {
      setLastRefresh({
        ok: false,
        summary: err instanceof Error ? err.message : "Refresh failed",
      })
    }
  }

  const handleResearch = async () => {
    if (refreshing || researching) return
    if (!hasUsableProviders || !researcherReady) {
      setResearchStatusOpen(false)
      setResearchStatusMode(false)
      setLastResearch({
        ok: false,
        summary:
          researchUnavailableReason ??
          "Connect a model provider before running research.",
      })
      return
    }
    setResearchPreviewOpen(true)
    setResearchStatusOpen(true)
    if (researchableModelCount === 0) {
      setResearchStatusMode(true)
      return
    }
    setResearchStatusMode(false)
    try {
      setLastResearch(null)
      const events = await researchModels()
      const done = [...events].reverse().find((e) => e.type === "done")
      const stopped = [...events].reverse().find((e) => e.type === "stopped")
      setLastResearch({
        ok: true,
        summary:
          stopped?.type === "stopped"
            ? stopped.message
            : done?.type === "done"
              ? `${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
              : "Research finished",
      })
    } catch (err) {
      setLastResearch({
        ok: false,
        summary: err instanceof Error ? err.message : "Research failed",
      })
    }
  }

  const handleResearchModel = async (providerId: string, modelId: string) => {
    if (refreshing || researching) return
    if (!hasUsableProviders || !researcherReady) {
      setLastResearch({
        ok: false,
        summary:
          researchUnavailableReason ??
          "Connect a model provider before running research.",
      })
      return
    }
    setResearchPreviewOpen(true)
    setResearchStatusOpen(true)
    setResearchStatusMode(false)
    try {
      setLastResearch(null)
      const events = await researchModel(providerId, modelId)
      const done = [...events].reverse().find((e) => e.type === "done")
      const stopped = [...events].reverse().find((e) => e.type === "stopped")
      setLastResearch({
        ok: true,
        summary:
          stopped?.type === "stopped"
            ? stopped.message
            : done?.type === "done"
              ? `${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
              : "Research finished",
      })
    } catch (err) {
      setLastResearch({
        ok: false,
        summary: err instanceof Error ? err.message : "Research failed",
      })
    }
  }

  // Auto-clear refresh feedback after a few seconds.
  React.useEffect(() => {
    if (!lastRefresh) return
    const t = setTimeout(() => setLastRefresh(null), 5000)
    return () => clearTimeout(t)
  }, [lastRefresh])

  React.useEffect(() => {
    if (!lastResearch || !lastResearch.ok) return
    const t = setTimeout(() => setLastResearch(null), 7000)
    return () => clearTimeout(t)
  }, [lastResearch])

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-[180px] animate-pulse rounded-2xl border border-border/60 bg-muted/40"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-[14px] text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">Couldn&apos;t load settings</p>
          <p className="mt-0.5 text-[13px] opacity-80">{error}</p>
        </div>
      </div>
    )
  }

  if (!data || data.agents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-5 py-12 text-center text-[14px] text-foreground/55">
        No agents registered yet. Agents are defined in{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
          lib/ai/agents/
        </code>
        .
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground/85">
            Agents
          </h2>
          <p className="mt-0.5 text-[12.5px] text-foreground/50">
            Each agent uses the global default unless an override is set below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {lastRefresh && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[11.5px] tabular-nums",
                lastRefresh.ok
                  ? "text-emerald-700 dark:text-emerald-500"
                  : "text-destructive"
              )}
              title={lastRefresh.summary}
            >
              {lastRefresh.ok && <CheckCircle2 className="size-3" />}
              {lastRefresh.summary}
            </span>
          )}
          {lastResearch && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[11.5px] tabular-nums",
                lastResearch.ok
                  ? "text-emerald-700 dark:text-emerald-500"
                  : "text-destructive"
              )}
              title={lastResearch.summary}
            >
              {lastResearch.ok && <CheckCircle2 className="size-3" />}
              {lastResearch.summary}
            </span>
          )}
          <button
            onClick={handleResearch}
            disabled={refreshing || researching}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium whitespace-nowrap text-foreground/70 transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              (researching || !hasUsableProviders || !researcherReady) &&
                "opacity-60"
            )}
            title={
              !hasUsableProviders || !researcherReady
                ? (researchUnavailableReason ??
                  "Connect a model provider before running research")
                : researchableModelCount > 0
                  ? researching
                    ? `Running up to ${liveResearchConcurrency} model researchers at once`
                    : `Ask the researcher to fill ${researchableModelCount} active incomplete model${researchableModelCount === 1 ? "" : "s"} from official docs`
                  : "Open current model research status"
            }
          >
            {researching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            {researching
              ? `Researching · max ${liveResearchConcurrency}`
              : formatResearchButtonLabel(
                  researchableModelCount,
                  hasUsableProviders && researcherReady
                )}
          </button>
          {researching && (
            <button
              onClick={stopResearchModels}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 text-[12.5px] font-medium whitespace-nowrap text-destructive transition-colors",
                "hover:bg-destructive/10"
              )}
              title="Stop the current research run"
            >
              <Square className="size-3.5 fill-current" />
              Stop research
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing || researching}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium whitespace-nowrap text-foreground/70 transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              refreshing && "opacity-60"
            )}
            title="Re-fetch model lists from provider APIs"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="size-3.5" />
            )}
            {refreshing ? "Refreshing…" : "Refresh models"}
          </button>
          <p className="text-[12.5px] text-foreground/50 tabular-nums">
            {data.agents.length} {data.agents.length === 1 ? "agent" : "agents"}
          </p>
        </div>
      </div>
      {(researchStatusOpen || researching || researchEvents.length > 0) &&
        (researchPreviewOpen ? (
          <ResearchProgressPanel
            events={researchEvents}
            researching={researching}
            statusOnly={researchStatusMode && !researching}
            modelStatuses={currentResearchStatuses}
            onCollapse={() => setResearchPreviewOpen(false)}
            onClear={clearResearchEvents}
            onResearchModel={handleResearchModel}
          />
        ) : (
          <ResearchPreviewCollapsed
            eventCount={researchEvents.length}
            researching={researching}
            statusVisible={researchStatusOpen}
            onShow={() => setResearchPreviewOpen(true)}
            onClear={clearResearchEvents}
          />
        ))}
      <AgentSettingsLayout
        data={data}
        orderedAgents={orderedAgents}
        selectedAgent={selectedAgent}
        usageReport={usageReport}
        draggingAgentId={draggingAgentId}
        orderSaveState={agentOrderSaveState}
        onSelectAgent={selectAgent}
        onDragStart={handleAgentDragStart}
        onDragOver={handleAgentDragOver}
        onDragEnd={() => {
          setDraggingAgentId(null)
          setDragPreviewOrder(null)
          draggingAgentIdRef.current = null
          dragPreviewOrderRef.current = null
        }}
        onDrop={handleAgentDrop}
        onDragOverEnd={handleAgentDragOverEnd}
        onDropEnd={handleAgentDropEnd}
      />

      <ModelRegistrySummary
        providers={data.providers}
        providerStatus={data.providerStatus}
      />
    </div>
  )
}

type AgentOrderSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }

function AgentSettingsLayout({
  data,
  orderedAgents,
  selectedAgent,
  usageReport,
  draggingAgentId,
  orderSaveState,
  onSelectAgent,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  onDragOverEnd,
  onDropEnd,
}: {
  data: SettingsBootstrap
  orderedAgents: AgentInfo[]
  selectedAgent: AgentInfo | null
  usageReport: UsageReport | null
  draggingAgentId: string | null
  orderSaveState: AgentOrderSaveState
  onSelectAgent: (agentId: string) => void
  onDragStart: (event: React.DragEvent, agentId: string) => void
  onDragOver: (event: React.DragEvent, targetAgentId: string) => void
  onDragEnd: () => void
  onDrop: (event: React.DragEvent, targetAgentId: string) => void
  onDragOverEnd: (event: React.DragEvent) => void
  onDropEnd: (event: React.DragEvent) => void
}) {
  return (
    <>
      <div data-agent-mobile-list className="flex flex-col gap-3 lg:hidden">
        {orderedAgents.map((agent) => (
          <AgentCard key={agent.id} agentId={agent.id} />
        ))}
      </div>

      <div className="hidden lg:grid lg:grid-cols-[280px_minmax(0,460px)_minmax(220px,1fr)] lg:items-start lg:gap-4">
        <aside
          data-agent-settings-sidebar
          className="relative flex h-[640px] min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card"
        >
          <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <h3 className="text-[13.5px] font-semibold text-foreground/85">
                Agents
              </h3>
              <p className="mt-0.5 text-[11.5px] text-foreground/45">
                {orderedAgents.length}{" "}
                {orderedAgents.length === 1 ? "agent" : "agents"} · Settings
                order
              </p>
            </div>
          </div>
          <AgentOrderStatus state={orderSaveState} />
          <div
            data-agent-sidebar-list
            className="min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-gutter:stable]"
            onDragOver={(event) => {
              if (!draggingAgentId) return
              const rect = event.currentTarget.getBoundingClientRect()
              const edge = 44
              if (event.clientY > rect.bottom - edge) {
                event.currentTarget.scrollBy({ top: 18 })
              } else if (event.clientY < rect.top + edge) {
                event.currentTarget.scrollBy({ top: -18 })
              }
            }}
          >
            <div className="flex flex-col gap-1">
              {orderedAgents.map((agent) => (
                <AgentSidebarRow
                  key={agent.id}
                  agent={agent}
                  data={data}
                  active={agent.id === selectedAgent?.id}
                  dragging={draggingAgentId === agent.id}
                  onSelect={() => onSelectAgent(agent.id)}
                  onDragStart={(event) => onDragStart(event, agent.id)}
                  onDragOver={(event) => onDragOver(event, agent.id)}
                  onDragEnd={onDragEnd}
                  onDrop={(event) => onDrop(event, agent.id)}
                />
              ))}
            </div>
          </div>
          <div
            data-agent-drop-end
            onDragEnter={onDragOverEnd}
            onDragOver={onDragOverEnd}
            onDrop={onDropEnd}
            className={cn(
              "pointer-events-none absolute inset-x-2 bottom-2 z-10 h-7 rounded-md border border-dashed border-transparent bg-card/85 opacity-0 shadow-sm backdrop-blur-sm transition-[background-color,border-color,opacity] duration-150",
              draggingAgentId &&
                "pointer-events-auto border-border/80 bg-muted/75 opacity-100"
            )}
          >
            <div className="flex h-full items-center justify-center text-[11px] font-medium text-foreground/40">
              Last
            </div>
          </div>
        </aside>

        <section className="flex h-full min-h-0 min-w-0 flex-col">
          {selectedAgent ? (
            <div
              data-agent-detail
              className="w-full min-w-0 rounded-2xl lg:max-w-[460px]"
            >
              <AgentCard agentId={selectedAgent.id} className="min-h-[640px]" />
            </div>
          ) : (
            <div className="flex min-h-[640px] items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/30 px-5 py-12 text-center text-[13px] text-foreground/45">
              No agent selected.
            </div>
          )}
        </section>

        <AgentContextPanel
          data={data}
          agent={selectedAgent}
          usageReport={usageReport}
          className="h-[640px] overflow-y-auto [scrollbar-gutter:stable]"
        />
      </div>
    </>
  )
}

function AgentContextPanel({
  data,
  agent,
  usageReport,
  className,
}: {
  data: SettingsBootstrap
  agent: AgentInfo | null
  usageReport: UsageReport | null
  className?: string
}) {
  if (!agent) return null

  const details = buildAgentContextDetails(agent, data)
  const activity = buildAgentActivity(agent, usageReport)
  const delegates = agent.canCallAgents
    .map(
      (id) => data.agents.find((candidate) => candidate.id === id)?.name ?? id
    )
    .slice(0, 6)

  return (
    <aside
      data-agent-context-panel
      className={cn(
        "rounded-xl border border-border/70 bg-card px-3 py-3",
        className
      )}
    >
      <div className="border-b border-border/60 pb-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              agent.status === "planned" ? "bg-foreground/25" : "bg-emerald-500"
            )}
          />
          <h3 className="min-w-0 truncate text-[13.5px] font-semibold text-foreground/85">
            {agent.name}
          </h3>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-foreground/50">
          {agent.description}
        </p>
      </div>

      <div className="mt-3">
        <PanelSectionTitle>Quick facts</PanelSectionTitle>
        <div className="mt-1 divide-y divide-border/50">
          {details.map((detail) => (
            <InfoRow
              key={detail.label}
              label={detail.label}
              value={detail.value}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 border-t border-border/60 pt-3">
        <PanelSectionTitle>Recent activity</PanelSectionTitle>
        {activity ? (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {activity.map((item) => (
              <ActivityTile
                key={item.label}
                label={item.label}
                value={item.value}
                tone={item.tone}
              />
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-lg border border-dashed border-border/70 bg-background/50 px-2.5 py-2 text-[12px] text-foreground/45">
            No runs in the last 30 days.
          </p>
        )}
      </div>

      {delegates.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <p className="text-[11px] font-medium tracking-wider text-foreground/45 uppercase">
            Delegates
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {delegates.map((name) => (
              <InfoPill key={name}>{name}</InfoPill>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}

function PanelSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-wider text-foreground/45 uppercase">
      {children}
    </p>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 py-2 text-[12px]">
      <span className="text-foreground/40">{label}</span>
      <span
        className="min-w-0 truncate font-medium text-foreground/70"
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function ActivityTile({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "danger"
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-2.5 py-2">
      <p className="text-[10.5px] font-medium tracking-wider text-foreground/35 uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-[13px] font-semibold text-foreground/75 tabular-nums",
          tone === "danger" && "text-destructive"
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function InfoPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center rounded-md border border-border bg-background px-2 text-[11.5px] font-medium text-foreground/55">
      <span className="truncate">{children}</span>
    </span>
  )
}

function AgentSidebarRow({
  agent,
  data,
  active,
  dragging,
  onSelect,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  agent: AgentInfo
  data: SettingsBootstrap
  active: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  onDragEnd: () => void
  onDrop: (event: React.DragEvent) => void
}) {
  const warning = agentHasProviderWarning(agent, data)
  const summary = formatAgentSidebarSummary(agent, data)

  return (
    <div
      data-agent-row
      data-agent-id={agent.id}
      draggable
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      aria-label={`Select ${agent.name}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onSelect()
      }}
      onDragStart={onDragStart}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={cn(
        "group relative flex min-w-0 cursor-pointer items-center rounded-lg border px-2 py-1.5 transition-[background-color,border-color,opacity,transform] duration-150 outline-none hover:cursor-grab focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing",
        active
          ? "border-foreground/12 bg-foreground/[0.04]"
          : "border-transparent hover:border-border/70 hover:bg-muted/45",
        dragging && "opacity-45"
      )}
    >
      <span
        data-agent-drag-handle
        aria-hidden="true"
        title="Drag to reorder"
        className={cn(
          "pointer-events-none absolute top-1/2 left-1 grid size-4 -translate-y-1/2 place-items-center text-foreground/35 opacity-0 transition-opacity duration-150",
          "group-hover:opacity-70 group-focus-visible:opacity-70",
          dragging && "opacity-70"
        )}
      >
        <GripVertical className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 rounded-md py-0.5 pr-1 pl-4 text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              warning
                ? "bg-amber-500"
                : agent.status === "planned"
                  ? "bg-foreground/25"
                  : "bg-emerald-500"
            )}
          />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground/85">
            {agent.name}
          </span>
          {agent.kind !== "text" && (
            <AgentMiniBadge>{agent.kind}</AgentMiniBadge>
          )}
          {agent.status === "planned" && (
            <AgentMiniBadge tone="amber">planned</AgentMiniBadge>
          )}
        </div>
        <p
          className="mt-0.5 truncate text-[11.5px] text-foreground/45"
          title={summary}
        >
          {summary}
        </p>
      </div>
    </div>
  )
}

function AgentOrderStatus({ state }: { state: AgentOrderSaveState }) {
  if (state.kind === "idle") return null

  return (
    <div
      className={cn(
        "border-b border-border/50 px-3 py-2 text-[11.5px]",
        state.kind === "error"
          ? "bg-destructive/5 text-destructive"
          : "bg-muted/25 text-foreground/45"
      )}
    >
      {state.kind === "saving" && "Saving order..."}
      {state.kind === "saved" && "Order saved"}
      {state.kind === "error" && state.message}
    </div>
  )
}

function AgentMiniBadge({
  children,
  tone = "default",
}: {
  children: React.ReactNode
  tone?: "default" | "amber"
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[10.5px] font-medium",
        tone === "amber"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-border bg-background text-foreground/45"
      )}
    >
      {children}
    </span>
  )
}

function orderAgentsByConfig(
  agents: AgentInfo[],
  agentOrder: string[]
): AgentInfo[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const seen = new Set<string>()
  const ordered: AgentInfo[] = []

  for (const id of agentOrder) {
    const agent = byId.get(id)
    if (!agent || seen.has(id)) continue
    seen.add(id)
    ordered.push(agent)
  }

  for (const agent of agents) {
    if (seen.has(agent.id)) continue
    ordered.push(agent)
  }

  return ordered
}

function moveIdAround(
  ids: string[],
  draggedId: string,
  targetId: string,
  afterTarget: boolean
): string[] {
  if (draggedId === targetId) return ids
  const draggedIndex = ids.indexOf(draggedId)
  const targetIndex = ids.indexOf(targetId)
  if (draggedIndex < 0 || targetIndex < 0) return ids

  const next = ids.filter((id) => id !== draggedId)
  const targetAfterRemoval = next.indexOf(targetId)
  if (targetAfterRemoval < 0) return ids
  const insertIndex = afterTarget ? targetAfterRemoval + 1 : targetAfterRemoval
  next.splice(insertIndex, 0, draggedId)

  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== next[i]) return next
  }
  return ids
}

function moveIdToEnd(ids: string[], draggedId: string): string[] {
  const draggedIndex = ids.indexOf(draggedId)
  if (draggedIndex < 0 || draggedIndex === ids.length - 1) return ids

  const next = ids.filter((id) => id !== draggedId)
  next.push(draggedId)
  return next
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function formatAgentSidebarSummary(
  agent: AgentInfo,
  data: SettingsBootstrap
): string {
  if (agent.id === "browser_agent") {
    const backend =
      data.config.browserAgentBackend.effective === "official-display"
        ? "Chromium"
        : "Patchright"
    const light = formatProviderModel(
      data,
      data.config.browserAgent.light.provider,
      data.config.browserAgent.light.model
    ).model
    if (!data.config.browserAgent.proEnabled) {
      return `${backend} · ${light}`
    }
    const pro = formatProviderModel(
      data,
      data.config.browserAgent.pro.provider,
      data.config.browserAgent.pro.model
    ).model
    return light === pro
      ? `${backend} · ${light}`
      : `${backend} · ${light} / ${pro}`
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  const modelId =
    override?.model ?? agent.defaultModel ?? data.config.activeModel
  const { provider, model } = formatProviderModel(data, providerId, modelId)
  return `${provider} · ${model}`
}

function formatProviderModel(
  data: SettingsBootstrap,
  providerId: string,
  modelId: string
): { provider: string; model: string } {
  const providerDef = data.providers[providerId]
  return {
    provider: providerDef?.name ?? providerId,
    model: providerDef?.models[modelId]?.name ?? modelId,
  }
}

function buildAgentActivity(
  agent: AgentInfo,
  usageReport: UsageReport | null
): Array<{ label: string; value: string; tone?: "default" | "danger" }> | null {
  const usage = usageReport?.byAgent.find((item) => item.agentId === agent.id)
  if (!usage || usage.requests === 0) return null

  return [
    { label: "Runs", value: formatCompactNumber(usage.requests) },
    {
      label: "Errors",
      value: formatCompactNumber(usage.errors),
      tone: usage.errors > 0 ? "danger" : "default",
    },
    {
      label: "Tokens",
      value: formatCompactNumber(
        usage.inputTokens + usage.outputTokens + usage.thinkingTokens
      ),
    },
    { label: "Cost", value: formatUsd(usage.estimatedCostUsd) },
  ]
}

function buildAgentContextDetails(
  agent: AgentInfo,
  data: SettingsBootstrap
): Array<{ label: string; value: string }> {
  const status = agent.status === "planned" ? "Planned" : "Active"

  if (agent.id === "browser_agent") {
    const backend =
      data.config.browserAgentBackend.effective === "official-display"
        ? "Chromium display"
        : "Patchright"
    const light = formatProviderModel(
      data,
      data.config.browserAgent.light.provider,
      data.config.browserAgent.light.model
    )
    const pro = formatProviderModel(
      data,
      data.config.browserAgent.pro.provider,
      data.config.browserAgent.pro.model
    )
    const proEnabled = data.config.browserAgent.proEnabled
    return [
      { label: "Status", value: status },
      { label: "Kind", value: agent.kind },
      { label: "Backend", value: backend },
      { label: "Mode", value: proEnabled ? "Multi (light + pro)" : "Single (light only)" },
      { label: "Light", value: `${light.provider} · ${light.model}` },
      ...(proEnabled
        ? [{ label: "Pro", value: `${pro.provider} · ${pro.model}` }]
        : []),
    ]
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  const modelId =
    override?.model ?? agent.defaultModel ?? data.config.activeModel
  const thinking =
    override?.thinkingLevel ??
    agent.defaultThinkingLevel ??
    data.config.thinkingLevel
  const source = override
    ? "Override"
    : agent.defaultProvider || agent.defaultModel
      ? "Agent default"
      : "Global default"
  const model = formatProviderModel(data, providerId, modelId)

  return [
    { label: "Status", value: status },
    { label: "Kind", value: agent.kind },
    { label: "Provider", value: model.provider },
    { label: "Model", value: model.model },
    { label: "Thinking", value: formatContextThinking(thinking) },
    { label: "Source", value: source },
  ]
}

function formatContextThinking(value: string): string {
  return CONTEXT_THINKING_LABELS[value] ?? value
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(Math.round(value))
}

function formatUsd(value: number): string {
  if (value <= 0) return "$0"
  if (value < 0.01) return "<$0.01"
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 2 : 0,
  }).format(value)
}

function agentHasProviderWarning(
  agent: AgentInfo,
  data: SettingsBootstrap
): boolean {
  if (agent.id === "browser_agent") {
    return [
      data.config.browserAgent.light.provider,
      ...(data.config.browserAgent.proEnabled
        ? [data.config.browserAgent.pro.provider]
        : []),
    ].some(
      (providerId) => !(data.providerStatus[providerId]?.available ?? false)
    )
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  return !(data.providerStatus[providerId]?.available ?? false)
}

function ResearchPreviewCollapsed({
  eventCount,
  researching,
  statusVisible,
  onShow,
  onClear,
}: {
  eventCount: number
  researching: boolean
  statusVisible: boolean
  onShow: () => void
  onClear: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-foreground/55">
        {researching ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <CheckCircle2 className="size-3.5 text-emerald-600" />
        )}
        <span className="truncate">
          {eventCount > 0
            ? `Research preview hidden · ${eventCount} event${eventCount === 1 ? "" : "s"} saved`
            : statusVisible
              ? "Model research status hidden"
              : "Research preview hidden"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onShow}
          className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-[12px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          Show preview
        </button>
        {!researching && eventCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

function hasUsableModelProvider(
  data: NonNullable<ReturnType<typeof useSettings>["data"]>
): boolean {
  return Object.entries(data.providerStatus).some(
    ([providerId, status]) => providerId !== "browser" && status.available
  )
}

function getResearcherProviderId(
  data: NonNullable<ReturnType<typeof useSettings>["data"]>
): string {
  return (
    data.config.agentOverrides?.researcher?.provider ??
    data.agents.find((agent) => agent.id === "researcher")?.defaultProvider ??
    data.config.activeProvider
  )
}

function isResearcherProviderReady(
  data: NonNullable<ReturnType<typeof useSettings>["data"]>
): boolean {
  return data.providerStatus[getResearcherProviderId(data)]?.available ?? false
}

function getResearchUnavailableReason(
  data: NonNullable<ReturnType<typeof useSettings>["data"]>
): string | null {
  if (!hasUsableModelProvider(data)) {
    return "No usable model provider is connected. Add an API key or log in to a CLI provider first."
  }
  const providerId = getResearcherProviderId(data)
  const status = data.providerStatus[providerId]
  if (!status?.available) {
    return (
      status?.chatMessage ??
      status?.unavailableReason ??
      `Researcher provider ${providerId} is not ready.`
    )
  }
  return null
}

function isProviderUsable(
  providerId: string,
  providerStatus: NonNullable<
    ReturnType<typeof useSettings>["data"]
  >["providerStatus"]
): boolean {
  return (
    providerId !== "browser" && (providerStatus[providerId]?.available ?? false)
  )
}

function countResearchableModels(
  providers: Record<string, ProviderDef>,
  providerStatus: NonNullable<
    ReturnType<typeof useSettings>["data"]
  >["providerStatus"]
): number {
  let count = 0
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderUsable(providerId, providerStatus)) continue
    for (const model of Object.values(provider.models)) {
      if (!model.archived && model.dataCompleteness === "incomplete") count += 1
    }
  }
  return count
}

function formatResearchButtonLabel(count: number, available: boolean): string {
  if (!available) return "Research unavailable"
  return `Research model details (${count})`
}

function buildModelResearchStatuses(
  providers: Record<string, ProviderDef>,
  providerStatus: NonNullable<
    ReturnType<typeof useSettings>["data"]
  >["providerStatus"]
): CurrentModelResearchStatus[] {
  const rows: CurrentModelResearchStatus[] = []
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderUsable(providerId, providerStatus)) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.archived) continue
      const missing = model.missingFields ?? []
      // Mirror registry completeness: pure media models have no context window.
      const isPureMedia =
        model.kinds.length > 0 && model.kinds.every((k) => k !== "text")
      const needsContext =
        !isPureMedia &&
        (model.kinds.includes("text") || model.capabilities.includes("text"))
      const hasThinkingMetadata = model.thinkingLevels !== undefined
      const thinking = model.thinkingLevels?.length
        ? model.thinkingLevels.join(", ")
        : hasThinkingMetadata
          ? "Not adjustable"
          : "Missing"
      rows.push({
        key: `${providerId}:${modelId}`,
        providerId,
        modelId,
        name: model.name,
        status: missing.length > 0 ? "incomplete" : "complete",
        missing,
        lastResearchedAt: model.curatedResearchedAt,
        fields: [
          {
            label: "Pricing",
            value: formatPricingStatus(model.pricing, model.pricingNotes),
            tone: model.pricing === null ? "missing" : "ok",
          },
          {
            label: "Max input",
            value:
              model.contextWindow > 0
                ? formatTokenCount(model.contextWindow)
                : needsContext
                  ? "Missing"
                  : "Not tracked",
            tone:
              model.contextWindow > 0
                ? "ok"
                : needsContext
                  ? "missing"
                  : "muted",
          },
          {
            label: "Max output",
            value:
              model.maxOutputTokens > 0
                ? formatTokenCount(model.maxOutputTokens)
                : "Unknown",
            tone: model.maxOutputTokens > 0 ? "ok" : "muted",
          },
          {
            label: "Knowledge",
            value: model.knowledgeCutoff ?? "Unknown",
            tone: model.knowledgeCutoff ? "ok" : "muted",
          },
          {
            label: "Thinking",
            value: thinking,
            tone: hasThinkingMetadata
              ? model.thinkingLevels?.length
                ? "ok"
                : "muted"
              : "missing",
          },
          {
            label: "Features",
            value:
              model.features.length > 0
                ? model.features.map((feature) => feature.label).join(", ")
                : "None",
            tone: model.features.length > 0 ? "ok" : "muted",
          },
          {
            label: "Custom",
            value:
              model.customMetadata.length > 0
                ? model.customMetadata.map(formatCustomMetadata).join(", ")
                : "None",
            tone: model.customMetadata.length > 0 ? "ok" : "muted",
          },
          {
            label: "Kinds",
            value: model.kinds.length > 0 ? model.kinds.join(", ") : "Unknown",
            tone: model.kinds.length > 0 ? "ok" : "muted",
          },
          {
            label: "Capabilities",
            value:
              model.capabilities.length > 0
                ? model.capabilities.join(", ")
                : "Unknown",
            tone: model.capabilities.length > 0 ? "ok" : "muted",
          },
          {
            label: "Sources",
            value: model.researchSources?.length
              ? `${model.researchSources.length} official source${model.researchSources.length === 1 ? "" : "s"}`
              : "No research sources",
            tone: model.researchSources?.length ? "ok" : "muted",
          },
          {
            label: "Last research",
            value: model.curatedResearchedAt
              ? formatDateTime(model.curatedResearchedAt)
              : "Never",
            tone: model.curatedResearchedAt ? "ok" : "muted",
          },
        ],
      })
    }
  }
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "incomplete" ? -1 : 1
    return (
      a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name)
    )
  })
}

function formatPricingStatus(
  pricing: ProviderDef["models"][string]["pricing"],
  notes?: string
): string {
  if (pricing === null) return "Missing"
  if (pricing.kind === "subscription") return "Subscription"
  if (pricing.kind === "unit") {
    const currency = pricing.currency ?? "$"
    if (typeof pricing.pricePerUnit === "number")
      return `${currency}${formatPrice(pricing.pricePerUnit)}/${pricing.unit}`
    if (pricing.tiers?.length) return `${pricing.tiers.length} pricing tiers`
    return notes ?? pricing.notes ?? "Unit pricing"
  }
  const large =
    pricing.inputPerMillionLarge !== undefined ||
    pricing.outputPerMillionLarge !== undefined ||
    pricing.tiers?.length
      ? " · tiered"
      : ""
  return `$${formatPrice(pricing.inputPerMillion)}/$${formatPrice(pricing.outputPerMillion)} per M${large}`
}

function formatCustomMetadata(
  item: ProviderDef["models"][string]["customMetadata"][number]
): string {
  const value =
    typeof item.value === "boolean"
      ? item.value
        ? "yes"
        : "no"
      : String(item.value)
  return `${item.label}: ${value}${item.unit ? ` ${item.unit}` : ""}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M tokens`
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K tokens`
  return `${tokens} tokens`
}

function formatPrice(n: number): string {
  return n < 1
    ? n.toFixed(2).replace(/\.?0+$/, "") || "0"
    : n.toFixed(2).replace(/\.?0+$/, "")
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}
