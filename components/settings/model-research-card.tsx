"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, FileSearch, Loader2, Search, Square } from "lucide-react"

import { cn } from "@/lib/utils"
import { ResearchProgressPanel } from "@/components/settings/research-progress-panel"
import { useSettings } from "@/components/settings/use-settings"
import {
  buildModelResearchStatuses,
  countResearchableModels,
  getResearchUnavailableReason,
  hasUsableModelProvider,
  isResearcherProviderReady,
} from "@/components/settings/models-tab-helpers"

type Feedback = { ok: boolean; summary: string }

/**
 * Self-contained "Model metadata" section for the Models tab.
 *
 * One piece of UI state (`open`) drives the whole thing: collapsed shows a clean
 * summary row, expanded shows the review/live panel. Clicking the entry button
 * opens a REVIEW of incomplete models — research only starts when the user hits
 * the explicit "Start research" button inside the panel. Closing (X) collapses
 * straight back to the summary row, with no residual bar to clear on refresh.
 */
export function ModelResearchCard() {
  const {
    data,
    researchModels,
    researchModel,
    stopResearchModels,
    researching,
    researchEvents,
    clearResearchEvents,
  } = useSettings()

  const [open, setOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState<Feedback | null>(null)

  const hasUsableProviders = data ? hasUsableModelProvider(data) : false
  const researcherReady = data ? isResearcherProviderReady(data) : false
  const canResearch = hasUsableProviders && researcherReady
  const unavailableReason = data ? getResearchUnavailableReason(data) : null
  const researchableCount = data
    ? countResearchableModels(data.providers, data.providerStatus)
    : 0
  const statuses = React.useMemo(
    () =>
      data
        ? buildModelResearchStatuses(data.providers, data.providerStatus)
        : [],
    [data]
  )
  const completeCount = statuses.filter((s) => s.status === "complete").length
  const incompleteCount = statuses.length - completeCount

  const concurrency = React.useMemo(() => {
    const ready = [...researchEvents].reverse().find((e) => e.type === "ready")
    return ready?.type === "ready" ? (ready.concurrency ?? 6) : 6
  }, [researchEvents])

  // A live run always pulls the panel open (covers both "Start research" and a
  // run restored from a previous session). Because the deps are [researching],
  // closing the panel mid-run keeps it closed — the effect won't re-fire.
  React.useEffect(() => {
    if (researching) setOpen(true)
  }, [researching])

  // Drop a transient success line after a few seconds; errors linger.
  React.useEffect(() => {
    if (!feedback || !feedback.ok) return
    const t = setTimeout(() => setFeedback(null), 7000)
    return () => clearTimeout(t)
  }, [feedback])

  const startAll = React.useCallback(async () => {
    if (researching) return
    if (!canResearch) {
      setFeedback({
        ok: false,
        summary:
          unavailableReason ??
          "Connect a model provider before running research.",
      })
      return
    }
    setFeedback(null)
    setOpen(true)
    try {
      const events = await researchModels()
      const done = [...events].reverse().find((e) => e.type === "done")
      const stopped = [...events].reverse().find((e) => e.type === "stopped")
      setFeedback({
        ok: true,
        summary:
          stopped?.type === "stopped"
            ? stopped.message
            : done?.type === "done"
              ? `${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
              : "Research finished",
      })
    } catch (err) {
      setFeedback({
        ok: false,
        summary: err instanceof Error ? err.message : "Research failed",
      })
    }
  }, [canResearch, researchModels, researching, unavailableReason])

  const researchOne = React.useCallback(
    async (providerId: string, modelId: string) => {
      if (researching) return
      if (!canResearch) {
        setFeedback({
          ok: false,
          summary:
            unavailableReason ??
            "Connect a model provider before running research.",
        })
        return
      }
      setFeedback(null)
      setOpen(true)
      try {
        const events = await researchModel(providerId, modelId)
        const done = [...events].reverse().find((e) => e.type === "done")
        const stopped = [...events].reverse().find((e) => e.type === "stopped")
        setFeedback({
          ok: true,
          summary:
            stopped?.type === "stopped"
              ? stopped.message
              : done?.type === "done"
                ? `${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
                : "Research finished",
        })
      } catch (err) {
        setFeedback({
          ok: false,
          summary: err instanceof Error ? err.message : "Research failed",
        })
      }
    },
    [canResearch, researchModel, researching, unavailableReason]
  )

  const summary = buildSummaryLine({
    researching,
    canResearch,
    unavailableReason,
    events: researchEvents,
    completeCount,
    incompleteCount,
    activeCount: statuses.length,
  })

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <ResearchProgressPanel
          events={researchEvents}
          researching={researching}
          modelStatuses={statuses}
          researchableCount={researchableCount}
          canResearch={canResearch}
          concurrency={concurrency}
          onStartAll={startAll}
          onStop={stopResearchModels}
          onClear={clearResearchEvents}
          onClose={() => setOpen(false)}
          onResearchModel={researchOne}
        />
      ) : (
        <ResearchSummaryRow
          summary={summary}
          researching={researching}
          canResearch={canResearch}
          researchableCount={researchableCount}
          hasEvents={researchEvents.length > 0}
          onOpen={() => setOpen(true)}
          onStop={stopResearchModels}
          onClear={clearResearchEvents}
        />
      )}
      {feedback && (
        <p
          className={cn(
            "flex items-center gap-1.5 px-1 text-[11.5px]",
            feedback.ok
              ? "text-emerald-700 dark:text-emerald-500"
              : "text-destructive"
          )}
          title={feedback.summary}
        >
          {feedback.ok ? (
            <CheckCircle2 className="size-3 shrink-0" />
          ) : (
            <AlertCircle className="size-3 shrink-0" />
          )}
          <span className="min-w-0 truncate">{feedback.summary}</span>
        </p>
      )}
    </div>
  )
}

function ResearchSummaryRow({
  summary,
  researching,
  canResearch,
  researchableCount,
  hasEvents,
  onOpen,
  onStop,
  onClear,
}: {
  summary: string
  researching: boolean
  canResearch: boolean
  researchableCount: number
  hasEvents: boolean
  onOpen: () => void
  onStop: () => void
  onClear: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg border border-border/70 bg-background text-foreground/55",
            researching && "text-foreground/70"
          )}
        >
          {researching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileSearch className="size-3.5" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-foreground/85">
            Model metadata
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-foreground/50">
            {summary}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {researching && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 px-2.5 text-[12.5px] font-medium whitespace-nowrap text-destructive transition-colors hover:bg-destructive/10"
            title="Stop the current research run"
          >
            <Square className="size-3.5 fill-current" />
            Stop
          </button>
        )}
        {!researching && hasEvents && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium whitespace-nowrap text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {researching ? (
            "Show progress"
          ) : (
            <>
              <Search className="size-3.5" />
              {canResearch && researchableCount > 0
                ? `Review & research (${researchableCount})`
                : "Review metadata"}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function buildSummaryLine({
  researching,
  canResearch,
  unavailableReason,
  events,
  completeCount,
  incompleteCount,
  activeCount,
}: {
  researching: boolean
  canResearch: boolean
  unavailableReason: string | null
  events: ReturnType<typeof useSettings>["researchEvents"]
  completeCount: number
  incompleteCount: number
  activeCount: number
}): string {
  if (researching) {
    const ready = [...events].reverse().find((e) => e.type === "ready")
    const total = ready?.type === "ready" ? ready.total : activeCount
    return `Researching ${total} model${total === 1 ? "" : "s"}…`
  }
  if (events.length > 0) {
    const done = [...events].reverse().find((e) => e.type === "done")
    if (done?.type === "done") {
      return `Last run · ${done.updated} patched · ${done.incomplete ?? 0} incomplete · ${done.failed} failed`
    }
    const stopped = [...events].reverse().find((e) => e.type === "stopped")
    if (stopped?.type === "stopped") return stopped.message
  }
  if (!canResearch) {
    return unavailableReason ?? "Connect a model provider to research details"
  }
  if (activeCount === 0) {
    return "No active models yet — refresh to discover models"
  }
  return `${completeCount} complete · ${incompleteCount} incomplete · ${activeCount} active model${activeCount === 1 ? "" : "s"}`
}
