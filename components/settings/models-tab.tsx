"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  GripVertical,
  Loader2,
  RefreshCcw,
} from "lucide-react"

import { cn } from "@/lib/utils"

import { AgentCard } from "@/components/settings/agent-card"
import { ModelRegistrySummary } from "@/components/settings/models-registry-summary"
import { MemoryCard } from "@/components/settings/memory-card"
import { ModelResearchCard } from "@/components/settings/model-research-card"
import { CliAccountsSection } from "@/components/settings/cli-accounts"
import {
  useSettings,
  type AgentInfo,
  type SettingsBootstrap,
} from "@/components/settings/use-settings"
import { useUsage } from "@/components/settings/use-usage"
import type { UsageReport } from "@/lib/observability/schema"
import {
  agentHasProviderWarning,
  buildAgentActivity,
  buildAgentContextDetails,
  formatAgentSidebarSummary,
  moveIdAround,
  moveIdToEnd,
  orderAgentsByConfig,
  sameStringArray,
} from "@/components/settings/models-tab-helpers"

export function ModelsTab() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    data,
    loading,
    error,
    refreshModels,
    refreshing,
    researching,
    setAgentOrder,
  } = useSettings()
  const [lastRefresh, setLastRefresh] = React.useState<{
    ok: boolean
    summary: string
  } | null>(null)
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
  const savedOrderedAgents = React.useMemo(
    () =>
      data ? orderAgentsByConfig(data.agents, data.config.agentOrder) : [],
    [data]
  )
  const savedAgentIds = React.useMemo(
    () => savedOrderedAgents.map((agent) => agent.id),
    [savedOrderedAgents]
  )
  // Drag-reorder is allowed within a tier but not across tiers — a primary
  // agent can't be dropped into the System group, and vice versa.
  const agentTierById = React.useMemo(() => {
    const map = new Map<string, AgentInfo["tier"]>()
    for (const agent of data?.agents ?? []) map.set(agent.id, agent.tier)
    return map
  }, [data])
  const isSameTier = React.useCallback(
    (a: string, b: string) =>
      (agentTierById.get(a) ?? "primary") ===
      (agentTierById.get(b) ?? "primary"),
    [agentTierById]
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

  // Single commit point for a finished drag. The live preview (built up during
  // dragover) is the source of truth — it's exactly what the user sees — so on
  // drop we persist that order rather than recomputing from the drop target.
  // The drop event frequently lands on the dragged row itself (the preview
  // slides it under the cursor); recomputing against that target used to bail
  // out as a no-op and snap the list back, so the reorder never saved.
  const commitDragPreview = React.useCallback(() => {
    const previewOrder = dragPreviewOrderRef.current
    setDraggingAgentId(null)
    setDragPreviewOrder(null)
    draggingAgentIdRef.current = null
    dragPreviewOrderRef.current = null
    if (previewOrder && !sameStringArray(previewOrder, savedAgentIds)) {
      void persistAgentOrder(previewOrder)
    }
  }, [persistAgentOrder, savedAgentIds])

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
      if (!isSameTier(draggedId, targetAgentId)) return

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
    [draggingAgentId, isSameTier, savedAgentIds]
  )

  const handleAgentDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      commitDragPreview()
    },
    [commitDragPreview]
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
      commitDragPreview()
    },
    [commitDragPreview]
  )

  const handleRefresh = async () => {
    try {
      const result = await refreshModels()
      const summary = Object.entries(result.results)
        .map(([p, r]) => {
          if (r.skipped === "no_api_key") return `${p}: no key`
          if (r.skipped === "no_base_url") return `${p}: no URL`
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

  // Auto-clear refresh feedback after a few seconds.
  React.useEffect(() => {
    if (!lastRefresh) return
    const t = setTimeout(() => setLastRefresh(null), 5000)
    return () => clearTimeout(t)
  }, [lastRefresh])

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
        {data.canManageModelRegistry && <div className="flex flex-col gap-1.5 sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end">
            <button
              onClick={handleRefresh}
              disabled={refreshing || researching}
              className={cn(
                // Fixed min-width + centered content so the label swap
                // (Refresh models ↔ Refreshing…) can't resize the button and
                // shove its neighbours around.
                "inline-flex h-8 min-w-[140px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium whitespace-nowrap text-foreground/70 transition-colors",
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
              {data.agents.length}{" "}
              {data.agents.length === 1 ? "agent" : "agents"}
            </p>
          </div>

          {/* Refresh feedback gets its own reserved line so showing or clearing
              it never reflows — or wraps — the action buttons above. Single line
              + truncate keeps a long provider summary from growing the header. */}
          <div className="flex min-h-[16px] max-w-full items-center justify-end gap-x-3 overflow-hidden">
            {lastRefresh && (
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 text-[11.5px] tabular-nums",
                  lastRefresh.ok
                    ? "text-emerald-700 dark:text-emerald-500"
                    : "text-destructive"
                )}
                title={lastRefresh.summary}
              >
                {lastRefresh.ok && <CheckCircle2 className="size-3 shrink-0" />}
                <span className="truncate">{lastRefresh.summary}</span>
              </span>
            )}
          </div>
        </div>}
      </div>

      {data.canManageModelRegistry && <ModelResearchCard />}

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

      {data.canManageModelRegistry && <MemoryCard />}

      {data.canManageModelRegistry && <ModelRegistrySummary
        providers={data.providers}
        providerStatus={data.providerStatus}
      />}

      {data.canManageModelRegistry && <CliAccountsSection />}
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
  // The roster splits into the user-facing primary agents (reorderable) and the
  // internal/background "system" agents the runtime drives on its own (pinned,
  // collapsed by default). Both groups preserve their order from orderedAgents.
  const primaryAgents = orderedAgents.filter((agent) => agent.tier !== "system")
  const systemAgents = orderedAgents.filter((agent) => agent.tier === "system")
  const selectedIsSystem = selectedAgent?.tier === "system"
  const [systemOpen, setSystemOpen] = React.useState(false)

  // Deep-linking to (or otherwise selecting) a system agent expands the group so
  // the active row is visible; the user can still collapse it again afterward.
  React.useEffect(() => {
    if (selectedIsSystem) setSystemOpen(true)
  }, [selectedIsSystem, selectedAgent?.id])

  return (
    <>
      <div data-agent-mobile-list className="flex flex-col gap-3 lg:hidden">
        {primaryAgents.map((agent) => (
          <AgentCard key={agent.id} agentId={agent.id} />
        ))}
        {systemAgents.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-1 pt-1 text-[11.5px] font-medium tracking-wide text-foreground/45 uppercase">
              System
              <span className="h-px flex-1 bg-border/60" />
            </div>
            {systemAgents.map((agent) => (
              <AgentCard key={agent.id} agentId={agent.id} />
            ))}
          </>
        )}
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
                {primaryAgents.length}{" "}
                {primaryAgents.length === 1 ? "agent" : "agents"} · drag to
                reorder
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
              {primaryAgents.map((agent) => (
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
            {systemAgents.length > 0 && (
              <div className="mt-2 border-t border-border/50 pt-2">
                <button
                  type="button"
                  aria-expanded={systemOpen}
                  onClick={() => setSystemOpen((open) => !open)}
                  className="group flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-foreground/40 transition-transform duration-150",
                      systemOpen && "rotate-90"
                    )}
                  />
                  <span className="text-[12px] font-medium tracking-wide text-foreground/55 uppercase">
                    System
                  </span>
                  <span className="ml-0.5 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-foreground/45 tabular-nums">
                    {systemAgents.length}
                  </span>
                  <span className="ml-auto truncate text-[11px] text-foreground/35">
                    Run automatically
                  </span>
                </button>
                {systemOpen && (
                  <div className="mt-1 flex flex-col gap-1">
                    {systemAgents.map((agent) => (
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
                )}
              </div>
            )}
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
  draggable = true,
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
  /** System rows are pinned (registry order), so dragging is disabled for them. */
  draggable?: boolean
  onSelect: () => void
  onDragStart?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDragEnd?: () => void
  onDrop?: (event: React.DragEvent) => void
}) {
  const warning = agentHasProviderWarning(agent, data)
  const summary = formatAgentSidebarSummary(agent, data)

  return (
    <div
      data-agent-row
      data-agent-id={agent.id}
      draggable={draggable}
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
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnter={draggable ? onDragOver : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onDrop={draggable ? onDrop : undefined}
      className={cn(
        "group relative flex min-w-0 cursor-pointer items-center rounded-lg border px-2 py-1.5 transition-[background-color,border-color,opacity,transform] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        draggable && "hover:cursor-grab active:cursor-grabbing",
        active
          ? "border-foreground/12 bg-foreground/[0.04]"
          : "border-transparent hover:border-border/70 hover:bg-muted/45",
        dragging && "opacity-45"
      )}
    >
      {draggable && (
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
      )}
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
