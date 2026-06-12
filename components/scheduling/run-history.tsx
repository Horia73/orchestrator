"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft, ExternalLink, ListFilter, Loader2, X } from "lucide-react"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { MessageBubble } from "@/components/message-bubble"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAppEvent } from "@/hooks/use-app-events"
import type { Message } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  useScheduling,
  type TaskRunFilters,
  type TaskRunRecord,
} from "./use-scheduling"
import { StatusPill } from "./status-pill"

const RUN_PAGE_SIZE = 50

type RunStatusFilter = "all" | "ok" | "error"
type RunTriggerFilter = "all" | "schedule" | "manual"
type RunSurfaceFilter = "all" | "inbox" | "silent"

type RunFilterState = {
  status: RunStatusFilter
  trigger: RunTriggerFilter
  surface: RunSurfaceFilter
}

const DEFAULT_RUN_FILTERS: RunFilterState = {
  status: "all",
  trigger: "all",
  surface: "all",
}

function runFiltersToApi(filters: RunFilterState): TaskRunFilters {
  return {
    ...(filters.status !== "all" ? { status: filters.status } : {}),
    ...(filters.trigger !== "all" ? { trigger: filters.trigger } : {}),
    ...(filters.surface !== "all"
      ? { surfaced: filters.surface === "inbox" }
      : {}),
  }
}

function countActiveRunFilters(filters: RunFilterState): number {
  return (
    (filters.status === "all" ? 0 : 1) +
    (filters.trigger === "all" ? 0 : 1) +
    (filters.surface === "all" ? 0 : 1)
  )
}

function RunFilterMenu({
  filters,
  onChange,
}: {
  filters: RunFilterState
  onChange: (filters: RunFilterState) => void
}) {
  const active = countActiveRunFilters(filters)
  const set = <K extends keyof RunFilterState>(
    key: K,
    value: RunFilterState[K]
  ) => onChange({ ...filters, [key]: value })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[12px] text-foreground/60 hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-muted",
            active > 0 && "border-foreground/25 text-foreground"
          )}
          aria-label="Filter runs"
        >
          <ListFilter className="size-3.5" />
          Filter
          {active > 0 && (
            <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
              {active}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.status}
          onValueChange={(value) => set("status", value as RunStatusFilter)}
        >
          <DropdownMenuRadioItem value="all">
            All statuses
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ok">OK only</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="error">
            Errors only
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Trigger</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.trigger}
          onValueChange={(value) => set("trigger", value as RunTriggerFilter)}
        >
          <DropdownMenuRadioItem value="all">
            All triggers
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="schedule">
            Scheduled
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Output</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.surface}
          onValueChange={(value) => set("surface", value as RunSurfaceFilter)}
        >
          <DropdownMenuRadioItem value="all">All outputs</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="inbox">
            Inbox only
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="silent">
            Silent only
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {active > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onChange(DEFAULT_RUN_FILTERS)
              }}
              className="text-foreground/65"
            >
              <X className="size-3.5" />
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type RunHistoryState = {
  runs: TaskRunRecord[]
  total: number | null
  nextCursor: string | null
  hasMore: boolean
  loadingInitial: boolean
  refreshing: boolean
  loadingMore: boolean
  error: string | null
}

function emptyRunHistory(): RunHistoryState {
  return {
    runs: [],
    total: null,
    nextCursor: null,
    hasMore: false,
    loadingInitial: true,
    refreshing: false,
    loadingMore: false,
    error: null,
  }
}

function cursorForRun(run: TaskRunRecord): string {
  return `${run.startedAt}:${encodeURIComponent(run.id)}`
}

function mergeRuns(...groups: TaskRunRecord[][]): TaskRunRecord[] {
  const byId = new Map<string, TaskRunRecord>()
  for (const group of groups) {
    for (const run of group) byId.set(run.id, run)
  }
  return [...byId.values()].sort((a, b) => {
    const byTime = b.startedAt - a.startedAt
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
  })
}

function formatRunDuration(run: TaskRunRecord): string {
  const ms = Math.max(0, run.endedAt - run.startedAt)
  if (ms < 1000) return "<1s"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const minuteRest = minutes - hours * 60
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])

  return matches
}

function PastRunsLoading() {
  return (
    <div className="space-y-4 px-1 py-1">
      <div className="relative overflow-hidden rounded-lg border border-border/60 bg-background px-4 py-3 shadow-sm">
        <div className="absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-emerald-400/80 to-transparent" />
        <div className="flex items-center gap-2 text-[12px] font-medium text-foreground/55">
          <Loader2 className="size-3.5 animate-spin text-emerald-600" />
          Loading run history
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="mt-1.5 size-2 rounded-full bg-emerald-500/70 shadow-[0_0_14px_rgba(16,185,129,0.45)]" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-14 animate-pulse rounded bg-muted/70" />
                </div>
                <div
                  className={cn(
                    "h-3 animate-pulse rounded bg-muted/80",
                    i % 2 === 0 ? "w-5/6" : "w-2/3"
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RunListButton({
  run,
  selected,
  onSelect,
}: {
  run: TaskRunRecord
  selected: boolean
  onSelect: () => void
}) {
  const primary = run.error || run.summary || "(no output)"

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-[#f0ede6] text-foreground dark:bg-muted"
          : "hover:bg-[#f0ede6]/65 dark:hover:bg-muted/65"
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          run.status === "error" ? "bg-[#802020]" : "bg-emerald-500"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[12px] text-foreground/55">
          <span className="truncate">
            {new Date(run.startedAt).toLocaleString()}
          </span>
          <span className="shrink-0 text-foreground/35">
            {formatRunDuration(run)}
          </span>
        </span>
        <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug break-words text-foreground/75 md:line-clamp-1 md:leading-normal">
          {primary}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-foreground/40">
          <span>{run.trigger}</span>
          <span>·</span>
          <span>{run.surfaced ? "Inbox" : "silent"}</span>
        </span>
      </span>
    </button>
  )
}

function RunDetailPane({
  run,
  onBack,
}: {
  run: TaskRunRecord | null
  onBack: () => void
}) {
  if (!run) {
    return (
      <div className="hidden min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px] text-foreground/45 md:flex">
        Select a run to inspect its output.
      </div>
    )
  }

  const output = run.error || run.summary || "(no output)"
  const runMessage: Message = {
    id: `scheduled-run-${run.id}`,
    role: "assistant",
    content: output,
    status: run.status,
    contentSegments: run.contentSegments?.length
      ? run.contentSegments
      : undefined,
    reasoning: run.reasoning?.length ? run.reasoning : undefined,
    attachments: run.attachments?.length ? run.attachments : undefined,
    timestamp: run.endedAt,
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
          aria-label="Back to run list"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-medium">
              {new Date(run.startedAt).toLocaleString()}
            </span>
            <StatusPill status={run.status} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-foreground/45">
            {run.trigger} · {formatRunDuration(run)} ·{" "}
            {run.surfaced ? "sent to Inbox" : "silent run"}
          </div>
        </div>
        {run.conversationId && (
          <Link
            href={`/inbox?item=${encodeURIComponent(run.conversationId)}`}
            className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground/60 hover:bg-[#f0ede6] hover:text-foreground sm:inline-flex dark:hover:bg-muted"
          >
            <ExternalLink className="size-3" />
            Inbox
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="mb-4 grid grid-cols-2 gap-3 text-[12px] 2xl:grid-cols-4">
          <div>
            <dt className="text-foreground/40">Started</dt>
            <dd className="mt-0.5 text-foreground/70">
              {new Date(run.startedAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-foreground/40">Ended</dt>
            <dd className="mt-0.5 text-foreground/70">
              {new Date(run.endedAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-foreground/40">Trigger</dt>
            <dd className="mt-0.5 text-foreground/70">{run.trigger}</dd>
          </div>
          <div>
            <dt className="text-foreground/40">Output</dt>
            <dd className="mt-0.5 text-foreground/70">
              {run.surfaced ? "Inbox" : "silent"}
            </dd>
          </div>
        </dl>
        <ConversationArtifactsProvider
          conversationId={run.conversationId ?? ""}
        >
          <div
            className={cn(
              "rounded-md border p-3",
              run.status === "error"
                ? "border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30"
                : "border-border/70 bg-background"
            )}
          >
            <MessageBubble message={runMessage} compact />
          </div>
        </ConversationArtifactsProvider>
        {run.conversationId && (
          <Link
            href={`/inbox?item=${encodeURIComponent(run.conversationId)}`}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-[12px] text-foreground/60 hover:bg-[#f0ede6] hover:text-foreground sm:hidden dark:hover:bg-muted"
          >
            <ExternalLink className="size-3" />
            Open Inbox item
          </Link>
        )}
      </div>
    </div>
  )
}

export function PastRuns({ taskId }: { taskId: string }) {
  const { fetchRuns } = useScheduling()
  const [history, setHistory] = React.useState<RunHistoryState>(() =>
    emptyRunHistory()
  )
  const [filters, setFilters] =
    React.useState<RunFilterState>(DEFAULT_RUN_FILTERS)
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)
  const isWideRunsViewport = useMediaQuery("(min-width: 768px)")
  const apiFilters = React.useMemo(() => runFiltersToApi(filters), [filters])
  const activeFilters = countActiveRunFilters(filters)
  const loadLatestRef = React.useRef<
    ((mode: "initial" | "poll") => void) | null
  >(null)

  useAppEvent(["task_runs.changed", "scheduled_tasks.changed"], (event) => {
    if ("taskId" in event && event.taskId && event.taskId !== taskId) return
    if (document.visibilityState === "visible") loadLatestRef.current?.("poll")
  })

  React.useEffect(() => {
    let cancelled = false
    const loadLatest = async (mode: "initial" | "poll") => {
      setHistory((prev) => ({
        ...prev,
        loadingInitial: mode === "initial",
        refreshing: mode === "poll" && prev.runs.length > 0,
        error: mode === "initial" ? null : prev.error,
      }))
      try {
        const page = await fetchRuns(taskId, {
          filters: apiFilters,
          limit: RUN_PAGE_SIZE,
        })
        if (cancelled) return
        setHistory((prev) => {
          const runs =
            mode === "initial" ? page.runs : mergeRuns(page.runs, prev.runs)
          const hasMore = page.total > runs.length
          return {
            ...prev,
            runs,
            total: page.total,
            nextCursor:
              hasMore && runs.length > 0
                ? cursorForRun(runs[runs.length - 1])
                : null,
            hasMore,
            loadingInitial: false,
            refreshing: false,
            error: null,
          }
        })
      } catch (err) {
        if (cancelled) return
        setHistory((prev) => ({
          ...prev,
          loadingInitial: false,
          refreshing: false,
          error: err instanceof Error ? err.message : "Failed to load runs",
        }))
      }
    }
    loadLatestRef.current = (mode) => {
      void loadLatest(mode)
    }

    setSelectedRunId(null)
    setHistory(emptyRunHistory())
    void loadLatest("initial")
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadLatest("poll")
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      cancelled = true
      if (loadLatestRef.current) loadLatestRef.current = null
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [taskId, fetchRuns, apiFilters, reloadKey])

  React.useEffect(() => {
    setSelectedRunId((current) => {
      if (current && history.runs.some((run) => run.id === current)) {
        return current
      }
      return isWideRunsViewport ? (history.runs[0]?.id ?? null) : null
    })
  }, [history.runs, isWideRunsViewport])

  const loadMore = async () => {
    if (!history.nextCursor || history.loadingMore) return
    setHistory((prev) => ({ ...prev, loadingMore: true, error: null }))
    try {
      const page = await fetchRuns(taskId, {
        before: history.nextCursor,
        filters: apiFilters,
        limit: RUN_PAGE_SIZE,
      })
      setHistory((prev) => {
        const runs = mergeRuns(prev.runs, page.runs)
        const hasMore = page.total > runs.length
        return {
          ...prev,
          runs,
          total: page.total,
          nextCursor:
            hasMore && runs.length > 0
              ? cursorForRun(runs[runs.length - 1])
              : null,
          hasMore,
          loadingMore: false,
          error: null,
        }
      })
    } catch (err) {
      setHistory((prev) => ({
        ...prev,
        loadingMore: false,
        error: err instanceof Error ? err.message : "Failed to load runs",
      }))
    }
  }

  const { runs } = history
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ??
    (isWideRunsViewport ? (runs[0] ?? null) : null)

  let content: React.ReactNode
  if (history.loadingInitial && runs.length === 0) {
    content = <PastRunsLoading />
  } else if (history.error && runs.length === 0) {
    content = (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-[#802020] dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
        <div>{history.error}</div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="mt-3 rounded-md bg-background px-2.5 py-1.5 text-[12px] text-foreground shadow-sm hover:bg-muted"
        >
          Retry
        </button>
      </div>
    )
  } else if (runs.length === 0) {
    content = (
      <div className="p-6 text-center text-[13px] text-foreground/45">
        {activeFilters > 0 ? "No runs match these filters." : "No runs yet."}
      </div>
    )
  } else {
    content = (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background md:grid md:h-[calc(100dvh-260px)] md:max-h-[680px] md:min-h-[440px] md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]",
          selectedRunId ? "h-full" : "h-[calc(100dvh-260px)] min-h-[360px]"
        )}
      >
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col border-border/60 md:flex md:border-r",
            selectedRunId ? "hidden md:flex" : "flex"
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-2 text-[12px] text-foreground/45">
            <span>Run list</span>
            <span>{runs.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <ul className="space-y-1">
              {runs.map((run) => (
                <li key={run.id}>
                  <RunListButton
                    run={run}
                    selected={selectedRun?.id === run.id}
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                </li>
              ))}
            </ul>
            {history.hasMore && (
              <div className="p-2">
                <button
                  type="button"
                  disabled={history.loadingMore}
                  onClick={() => void loadMore()}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-border/70 px-3 py-2 text-[13px] text-foreground/60 hover:bg-[#f0ede6] hover:text-foreground disabled:opacity-50 dark:hover:bg-muted"
                >
                  {history.loadingMore && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  Load older runs
                </button>
              </div>
            )}
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            selectedRunId || isWideRunsViewport ? "flex" : "hidden md:flex"
          )}
        >
          <RunDetailPane
            run={selectedRun}
            onBack={() => setSelectedRunId(null)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3 px-1 text-[12px] text-foreground/45">
        <span>
          {history.loadingInitial && history.total == null
            ? "Loading runs"
            : history.total == null
              ? `${runs.length} runs`
              : runs.length === history.total
                ? `${history.total} runs`
                : `${runs.length} of ${history.total} runs`}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {history.refreshing && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Syncing
            </span>
          )}
          <RunFilterMenu filters={filters} onChange={setFilters} />
        </div>
      </div>
      {history.error && (
        <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {history.error}
        </div>
      )}
      {content}
    </div>
  )
}
