"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { Cpu, Activity, BarChart3, AlertCircle, RefreshCcw, Loader2, CheckCircle2, FileText, Download, Search, Moon, Square, Sun, KeyRound, ArrowLeft } from "lucide-react"

import { cn } from "@/lib/utils"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AgentCard } from "@/components/settings/agent-card"
import { SettingsProvider, useSettings } from "@/components/settings/use-settings"
import { LogsTab } from "@/components/settings/logs-tab"
import { UsageTab } from "@/components/settings/usage-tab"
import { FilesTab } from "@/components/settings/files-tab"
import { UpdateTab } from "@/components/settings/update-tab"
import { AuthTab } from "@/components/settings/auth-tab"
import { ResearchProgressPanel, type CurrentModelResearchStatus } from "@/components/settings/research-progress-panel"
import type { ProviderDef } from "@/lib/config"

const TAB_IDS = ["models", "auth", "files", "logs", "usage", "updates"] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "models", label: "Models", icon: Cpu },
  { id: "auth", label: "Auth", icon: KeyRound },
  { id: "files", label: "Files", icon: FileText },
  { id: "logs", label: "Logs", icon: Activity },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "updates", label: "Updates", icon: Download },
]

const DEFAULT_TAB: TabId = "models"

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value)
}

export function SettingsView() {
  return (
    <SettingsProvider>
      <SettingsViewInner />
    </SettingsProvider>
  )
}

function SettingsViewInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const tabFromUrl = searchParams.get("tab")
  const [activeTab, setActiveTab] = React.useState<TabId>(
    isTabId(tabFromUrl) ? tabFromUrl : DEFAULT_TAB
  )

  React.useEffect(() => {
    const t = searchParams.get("tab")
    if (isTabId(t) && t !== activeTab) setActiveTab(t)
    else if (!t && activeTab !== DEFAULT_TAB) setActiveTab(DEFAULT_TAB)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const handleTabChange = React.useCallback(
    (next: string) => {
      if (!isTabId(next)) return
      setActiveTab(next)
      const params = new URLSearchParams(searchParams.toString())
      if (next === DEFAULT_TAB) params.delete("tab")
      else params.set("tab", next)
      const query = params.toString()
      router.replace(query ? `/settings?${query}` : "/settings", { scroll: false })
    },
    [router, searchParams]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 bg-background">
        <div className="mx-auto w-full max-w-6xl px-3 pt-3 pb-0 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                onClick={() => router.push("/")}
                aria-label="Back to chat"
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground md:hidden"
              >
                <ArrowLeft className="size-4" />
              </button>
              <div className="min-w-0">
                <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="mt-0 mb-2 text-[11.5px] text-foreground/55">
                  Configure models, authentication, workspace files, activity, and usage.
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
          <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-0">
            <div className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0 md:overflow-visible">
              <TabsList className="-mb-px h-auto w-max min-w-full gap-0 border-none md:w-auto md:min-w-0">
                {TABS.map(tab => (
                  <TabsTrigger key={tab.id} value={tab.id} className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]">
                    <tab.icon className="size-[13px] opacity-80" />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
        </div>
      </div>

      {activeTab === "files" ? (
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="min-h-0 w-full flex-1 gap-0">
            <TabsContent value="files" className="min-h-0 flex-1">
              <FilesTab />
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-3 pt-4 pb-10 sm:px-6 sm:pt-5 sm:pb-12">
            <Tabs value={activeTab} onValueChange={handleTabChange}>
              <TabsContent value="models">
                <ModelsTab />
              </TabsContent>
              <TabsContent value="auth">
                <AuthTab />
              </TabsContent>
              <TabsContent value="logs">
                <LogsTab />
              </TabsContent>
              <TabsContent value="usage">
                <UsageTab />
              </TabsContent>
              <TabsContent value="updates">
                <UpdateTab />
              </TabsContent>
            </Tabs>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function ModelsTab() {
  const { data, loading, error, refreshModels, refreshing, researchModels, stopResearchModels, researching, researchEvents, clearResearchEvents } = useSettings()
  const [lastRefresh, setLastRefresh] = React.useState<{ ok: boolean; summary: string } | null>(null)
  const [lastResearch, setLastResearch] = React.useState<{ ok: boolean; summary: string } | null>(null)
  const [researchPreviewOpen, setResearchPreviewOpen] = React.useState(true)
  const [researchStatusOpen, setResearchStatusOpen] = React.useState(false)
  const [researchStatusMode, setResearchStatusMode] = React.useState(false)
  const researchableModelCount = data ? countResearchableModels(data.providers) : 0
  const currentResearchStatuses = React.useMemo(
    () => data ? buildModelResearchStatuses(data.providers) : [],
    [data]
  )
  const liveResearchConcurrency = React.useMemo(() => {
    const ready = [...researchEvents].reverse().find(event => event.type === "ready")
    return ready?.type === "ready" ? ready.concurrency ?? 6 : 6
  }, [researchEvents])

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
      setLastRefresh({ ok: false, summary: err instanceof Error ? err.message : "Refresh failed" })
    }
  }

  const handleResearch = async () => {
    if (refreshing || researching) return
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
      const done = [...events].reverse().find(e => e.type === "done")
      const stopped = [...events].reverse().find(e => e.type === "stopped")
      setLastResearch({
        ok: true,
        summary: stopped?.type === "stopped"
          ? stopped.message
          : done?.type === "done"
          ? `${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
          : "Research finished",
      })
    } catch (err) {
      setLastResearch({ ok: false, summary: err instanceof Error ? err.message : "Research failed" })
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
        {[1, 2].map(i => (
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
        No agents registered yet. Agents are defined in <code className="rounded bg-muted px-1 py-0.5 text-[12px]">lib/ai/agents/</code>.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground/85">Agents</h2>
          <p className="mt-0.5 text-[12.5px] text-foreground/50">
            Each agent uses the global default unless an override is set below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {lastRefresh && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[11.5px] tabular-nums",
                lastRefresh.ok ? "text-emerald-700 dark:text-emerald-500" : "text-destructive"
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
                lastResearch.ok ? "text-emerald-700 dark:text-emerald-500" : "text-destructive"
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
              "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              researching && "opacity-60"
            )}
            title={researchableModelCount > 0
              ? researching
                ? `Running up to ${liveResearchConcurrency} model researchers at once`
                : `Ask the researcher to fill ${researchableModelCount} active incomplete model${researchableModelCount === 1 ? "" : "s"} from official docs`
              : "Open current model research status"
            }
          >
            {researching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            {researching ? `Researching · max ${liveResearchConcurrency}` : formatResearchButtonLabel(researchableModelCount)}
          </button>
          {researching && (
            <button
              onClick={stopResearchModels}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 text-[12.5px] font-medium text-destructive transition-colors",
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
              "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              refreshing && "opacity-60"
            )}
            title="Re-fetch model lists from provider APIs"
          >
            {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
            {refreshing ? "Refreshing…" : "Refresh models"}
          </button>
          <p className="text-[12.5px] tabular-nums text-foreground/50">
            {data.agents.length} {data.agents.length === 1 ? "agent" : "agents"}
          </p>
        </div>
      </div>
      {(researchStatusOpen || researching || researchEvents.length > 0) && (
        researchPreviewOpen ? (
          <ResearchProgressPanel
            events={researchEvents}
            researching={researching}
            statusOnly={researchStatusMode && !researching}
            modelStatuses={currentResearchStatuses}
            onCollapse={() => setResearchPreviewOpen(false)}
            onClear={clearResearchEvents}
          />
        ) : (
          <ResearchPreviewCollapsed
            eventCount={researchEvents.length}
            researching={researching}
            statusVisible={researchStatusOpen}
            onShow={() => setResearchPreviewOpen(true)}
            onClear={clearResearchEvents}
          />
        )
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.agents.map(agent => (
          <AgentCard key={agent.id} agentId={agent.id} />
        ))}
      </div>

      <ModelRegistrySummary providers={data.providers} />

    </div>
  )
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
        {researching ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5 text-emerald-600" />}
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

function countResearchableModels(providers: Record<string, ProviderDef>): number {
  let count = 0
  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId === "browser") continue
    for (const model of Object.values(provider.models)) {
      if (!model.archived && model.dataCompleteness === "incomplete") count += 1
    }
  }
  return count
}

function formatResearchButtonLabel(count: number): string {
  return `Research model details (${count})`
}

function buildModelResearchStatuses(providers: Record<string, ProviderDef>): CurrentModelResearchStatus[] {
  const rows: CurrentModelResearchStatus[] = []
  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId === "browser") continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.archived) continue
      const missing = model.missingFields ?? []
      // Mirror registry completeness: pure media models have no context window.
      const isPureMedia = model.kinds.length > 0 && model.kinds.every(k => k !== "text")
      const needsContext = !isPureMedia && (model.kinds.includes("text") || model.capabilities.includes("text"))
      const hasThinkingMetadata = model.thinkingLevels !== undefined
      const thinking = model.thinkingLevels?.length ? model.thinkingLevels.join(", ") : hasThinkingMetadata ? "Not adjustable" : "Missing"
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
            value: model.contextWindow > 0 ? formatTokenCount(model.contextWindow) : needsContext ? "Missing" : "Not tracked",
            tone: model.contextWindow > 0 ? "ok" : needsContext ? "missing" : "muted",
          },
          {
            label: "Max output",
            value: model.maxOutputTokens > 0 ? formatTokenCount(model.maxOutputTokens) : "Unknown",
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
            tone: hasThinkingMetadata ? (model.thinkingLevels?.length ? "ok" : "muted") : "missing",
          },
          {
            label: "Features",
            value: model.features.length > 0 ? model.features.map(feature => feature.label).join(", ") : "None",
            tone: model.features.length > 0 ? "ok" : "muted",
          },
          {
            label: "Custom",
            value: model.customMetadata.length > 0 ? model.customMetadata.map(formatCustomMetadata).join(", ") : "None",
            tone: model.customMetadata.length > 0 ? "ok" : "muted",
          },
          {
            label: "Kinds",
            value: model.kinds.length > 0 ? model.kinds.join(", ") : "Unknown",
            tone: model.kinds.length > 0 ? "ok" : "muted",
          },
          {
            label: "Capabilities",
            value: model.capabilities.length > 0 ? model.capabilities.join(", ") : "Unknown",
            tone: model.capabilities.length > 0 ? "ok" : "muted",
          },
          {
            label: "Sources",
            value: model.researchSources?.length ? `${model.researchSources.length} official source${model.researchSources.length === 1 ? "" : "s"}` : "No research sources",
            tone: model.researchSources?.length ? "ok" : "muted",
          },
          {
            label: "Last research",
            value: model.curatedResearchedAt ? formatDateTime(model.curatedResearchedAt) : "Never",
            tone: model.curatedResearchedAt ? "ok" : "muted",
          },
        ],
      })
    }
  }
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "incomplete" ? -1 : 1
    return a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name)
  })
}

function formatPricingStatus(pricing: ProviderDef["models"][string]["pricing"], notes?: string): string {
  if (pricing === null) return "Missing"
  if (pricing.kind === "subscription") return "Subscription"
  if (pricing.kind === "unit") {
    const currency = pricing.currency ?? "$"
    if (typeof pricing.pricePerUnit === "number") return `${currency}${formatPrice(pricing.pricePerUnit)}/${pricing.unit}`
    if (pricing.tiers?.length) return `${pricing.tiers.length} pricing tiers`
    return notes ?? pricing.notes ?? "Unit pricing"
  }
  const large = pricing.inputPerMillionLarge !== undefined || pricing.outputPerMillionLarge !== undefined || pricing.tiers?.length ? " · tiered" : ""
  return `$${formatPrice(pricing.inputPerMillion)}/$${formatPrice(pricing.outputPerMillion)} per M${large}`
}

function formatCustomMetadata(item: ProviderDef["models"][string]["customMetadata"][number]): string {
  const value = typeof item.value === "boolean" ? (item.value ? "yes" : "no") : String(item.value)
  return `${item.label}: ${value}${item.unit ? ` ${item.unit}` : ""}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M tokens`
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K tokens`
  return `${tokens} tokens`
}

function formatPrice(n: number): string {
  return n < 1 ? n.toFixed(2).replace(/\.?0+$/, "") || "0" : n.toFixed(2).replace(/\.?0+$/, "")
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      {dark ? "Light" : "Dark"}
    </button>
  )
}

function ModelRegistrySummary({ providers }: { providers: Record<string, ProviderDef> }) {
  const rows = Object.entries(providers)
    .filter(([providerId]) => providerId !== "browser")
    .map(([providerId, provider]) => {
      const models = Object.values(provider.models)
      const archived = models.filter(model => model.archived).length
      const incomplete = models.filter(model => !model.archived && model.dataCompleteness === "incomplete").length
      const active = models.length - archived
      return { providerId, providerName: provider.name, active, incomplete, archived, total: models.length }
    })

  const totals = rows.reduce(
    (acc, row) => ({
      active: acc.active + row.active,
      incomplete: acc.incomplete + row.incomplete,
      archived: acc.archived + row.archived,
      total: acc.total + row.total,
    }),
    { active: 0, incomplete: 0, archived: 0, total: 0 }
  )

  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-4 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground/85">Model registry</h2>
          <p className="mt-0.5 text-[12px] text-foreground/50">Active, incomplete, and archived models are tracked separately.</p>
        </div>
        <div className="flex gap-2 text-[11.5px] tabular-nums">
          <RegistryPill label="Active" value={totals.active} />
          <RegistryPill label="Incomplete" value={totals.incomplete} tone="amber" />
          <RegistryPill label="Archived" value={totals.archived} tone="muted" />
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map(row => (
          <div key={row.providerId} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-[13px]">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground/80">{row.providerName}</p>
              <p className="text-[11.5px] text-foreground/45">{row.providerId}</p>
            </div>
            <CountCell label="active" value={row.active} />
            <CountCell label="incomplete" value={row.incomplete} tone={row.incomplete > 0 ? "amber" : "muted"} />
            <CountCell label="archived" value={row.archived} tone="muted" />
          </div>
        ))}
      </div>
    </section>
  )
}

function RegistryPill({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "amber" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2",
        tone === "amber"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : tone === "muted"
            ? "border-border bg-muted/40 text-foreground/55"
            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
      )}
    >
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

function CountCell({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "amber" | "muted" }) {
  return (
    <div
      className={cn(
        "w-20 text-right tabular-nums",
        tone === "amber" ? "text-amber-700 dark:text-amber-400" : tone === "muted" ? "text-foreground/45" : "text-foreground/70"
      )}
      title={label}
    >
      <span className="font-medium">{value}</span>
      <span className="ml-1 hidden text-[11px] text-foreground/35 sm:inline">{label}</span>
    </div>
  )
}
