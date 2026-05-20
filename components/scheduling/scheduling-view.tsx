"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  ListFilter,
  Loader2,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react"
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
import { Switch } from "@/components/ui/switch"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { cn } from "@/lib/utils"
import type { ScheduledTask, ScheduleSpec } from "@/lib/scheduling/schema"
import { useAppEvent } from "@/hooks/use-app-events"
import {
  SchedulingProvider,
  useScheduling,
  type TaskRunFilters,
  type TaskRunRecord,
} from "./use-scheduling"
import { TaskForm } from "./task-form"

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
function pad(n: number) {
  return n.toString().padStart(2, "0")
}

function describe(s: ScheduleSpec): string {
  if (s.kind === "once") return `once · ${new Date(s.fireAt).toLocaleString()}`
  if (s.kind === "every") {
    const m = Math.round(s.everyMs / 60_000)
    if (m % 1440 === 0) return `every ${m / 1440}d`
    if (m % 60 === 0) return `every ${m / 60}h`
    return `every ${m}m`
  }
  if (s.kind === "dailyAt")
    return `daily ${pad(s.hour)}:${pad(s.minute)} (${s.timezone})`
  if (s.kind === "weeklyAt")
    return `${s.weekdays.map((d) => WD[d]).join(",")} ${pad(s.hour)}:${pad(s.minute)} (${s.timezone})`
  return `cron "${s.expression}" (${s.timezone})`
}

function formatRelative(target: number | null, now: number): string {
  if (target == null) return "—"
  let diff = Math.round((target - now) / 1000)
  if (diff <= 0) return "due now"
  const d = Math.floor(diff / 86400)
  diff -= d * 86400
  const h = Math.floor(diff / 3600)
  diff -= h * 3600
  const m = Math.floor(diff / 60)
  const s = diff - m * 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m && parts.length < 2) parts.push(`${m}m`)
  if (!d && !h && !m) parts.push(`${s}s`)
  return `in ${parts.slice(0, 2).join(" ")}`
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(i)
  }, [intervalMs])
  return now
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

const STATUS_STYLE: Record<string, string> = {
  scheduled:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  running: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  done: "bg-muted text-foreground/60",
  error: "bg-red-50 text-[#802020] dark:bg-red-950 dark:text-red-300",
  missed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  paused: "bg-muted text-foreground/55",
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        STATUS_STYLE[status] ?? "bg-muted"
      )}
    >
      {status}
    </span>
  )
}

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        <div
          className={cn(
            "rounded-md border p-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap",
            run.status === "error"
              ? "border-red-200 bg-red-50 text-[#802020] dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
              : "border-border/70 bg-background text-foreground/75"
          )}
        >
          {output}
        </div>
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

function PastRuns({ taskId }: { taskId: string }) {
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
          "overflow-hidden rounded-lg border border-border/60 bg-background md:grid md:h-[calc(100dvh-260px)] md:max-h-[680px] md:min-h-[440px] md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]",
          selectedRunId ? "min-h-0" : "h-[calc(100dvh-260px)] min-h-[360px]"
        )}
      >
        <div
          className={cn(
            "min-h-0 flex-col border-border/60 md:flex md:border-r",
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
            "min-h-0",
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
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3 px-1 text-[12px] text-foreground/45">
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

function TaskDetail({
  task,
  onClose,
  onBack,
}: {
  task: ScheduledTask
  onClose: () => void
  onBack: () => void
}) {
  const { updateTask, deleteTask, runTask } = useScheduling()
  const { confirm, dialog } = useConfirm()
  const [tab, setTab] = React.useState<"edit" | "runs">("edit")
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const now = useNow(1000)

  return (
    <>
      {dialog}
      <header className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
        <button
          onClick={onBack}
          className="rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[16px] font-semibold">
              {task.title}
            </span>
            <StatusPill status={task.status} />
          </div>
          <div
            className="mt-0.5 text-[12px] text-foreground/45"
            title={
              task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : ""
            }
          >
            {describe(task.schedule)} · next{" "}
            {formatRelative(task.nextRunAt, now)}
          </div>
        </div>
        <button
          title="Run now"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setNote("Running…")
            const r = await runTask(task.id)
            setBusy(false)
            setNote(
              r.ok
                ? "Ran — see Inbox / Past runs."
                : `Failed: ${r.error ?? "error"}`
            )
            setTab("runs")
          }}
          className="rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] hover:text-foreground disabled:opacity-50 dark:hover:bg-muted"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
        </button>
        <button
          title="Delete"
          onClick={async () => {
            if (
              await confirm({
                title: `Delete "${task.title}"?`,
                message: "This removes the task and its run history.",
                destructive: true,
                confirmLabel: "Delete",
              })
            ) {
              await deleteTask(task.id)
              onClose()
            }
          }}
          className="rounded-md p-2 text-[#802020] hover:bg-red-50"
        >
          <Trash2 className="size-4" />
        </button>
      </header>

      {task.status === "running" && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-blue-50/60 px-5 py-2 text-[13px] text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
          <Loader2 className="size-3.5 animate-spin" /> Running… live progress
          appears in Past runs / Inbox when it finishes.
        </div>
      )}
      {note && (
        <div className="border-b border-border/60 px-5 py-2 text-[12px] text-foreground/55">
          {note}
        </div>
      )}

      <div className="flex gap-1 border-b border-border/60 px-5">
        {(["edit", "runs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 px-3 py-2 text-[13px]",
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-foreground/50 hover:text-foreground"
            )}
          >
            {t === "edit" ? "Edit" : "Past runs"}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {tab === "edit" ? (
          <TaskForm
            task={task}
            onSubmit={async (payload) => {
              await updateTask(task.id, payload)
            }}
            onCancel={onClose}
          />
        ) : (
          <PastRuns taskId={task.id} />
        )}
      </div>
    </>
  )
}

type TaskStatusFilter = "all" | ScheduledTask["status"]
type TaskCategoryFilter =
  | "all"
  | "agent"
  | "tool"
  | "monitor"
  | "once"
  | "recurring"
type TaskCreatedFilter = "all" | ScheduledTask["createdBy"]

type TaskFilterState = {
  status: TaskStatusFilter
  category: TaskCategoryFilter
  createdBy: TaskCreatedFilter
}

const DEFAULT_TASK_FILTERS: TaskFilterState = {
  status: "all",
  category: "all",
  createdBy: "all",
}

const TASK_STATUS_FILTERS: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "running", label: "Running" },
  { value: "error", label: "Errors" },
  { value: "missed", label: "Missed" },
  { value: "done", label: "Done" },
  { value: "paused", label: "Paused" },
]

const TASK_CATEGORY_FILTERS: Array<{
  value: TaskCategoryFilter
  label: string
}> = [
  { value: "all", label: "All categories" },
  { value: "agent", label: "Agent tasks" },
  { value: "tool", label: "Tool actions" },
  { value: "monitor", label: "Monitors" },
  { value: "once", label: "One-shot" },
  { value: "recurring", label: "Recurring" },
]

const TASK_CREATED_FILTERS: Array<{
  value: TaskCreatedFilter
  label: string
}> = [
  { value: "all", label: "All creators" },
  { value: "user", label: "User-created" },
  { value: "orchestrator", label: "Assistant-created" },
  { value: "system", label: "System-created" },
]

function countActiveTaskFilters(filters: TaskFilterState): number {
  return (
    (filters.status === "all" ? 0 : 1) +
    (filters.category === "all" ? 0 : 1) +
    (filters.createdBy === "all" ? 0 : 1)
  )
}

function taskMatchesCategory(
  task: ScheduledTask,
  category: TaskCategoryFilter
): boolean {
  if (category === "all") return true
  if (category === "recurring") return task.schedule.kind !== "once"
  if (category === "once") return task.schedule.kind === "once"
  return task.action.kind === category
}

function taskMatchesFilters(
  task: ScheduledTask,
  filters: TaskFilterState
): boolean {
  return (
    (filters.status === "all" || task.status === filters.status) &&
    taskMatchesCategory(task, filters.category) &&
    (filters.createdBy === "all" || task.createdBy === filters.createdBy)
  )
}

function countTasksBy<T extends string>(
  tasks: ScheduledTask[],
  values: readonly T[],
  matches: (task: ScheduledTask, value: T) => boolean
): Record<T, number> {
  const counts = Object.fromEntries(
    values.map((value) => [value, 0])
  ) as Record<T, number>
  for (const task of tasks) {
    for (const value of values) {
      if (matches(task, value)) counts[value] += 1
    }
  }
  return counts
}

function TaskFilterMenu({
  tasks,
  filters,
  onChange,
}: {
  tasks: ScheduledTask[]
  filters: TaskFilterState
  onChange: (filters: TaskFilterState) => void
}) {
  const active = countActiveTaskFilters(filters)
  const set = <K extends keyof TaskFilterState>(
    key: K,
    value: TaskFilterState[K]
  ) => onChange({ ...filters, [key]: value })
  const statusCounts = countTasksBy(
    tasks,
    TASK_STATUS_FILTERS.map((item) => item.value),
    (task, status) => status === "all" || task.status === status
  )
  const categoryCounts = countTasksBy(
    tasks,
    TASK_CATEGORY_FILTERS.map((item) => item.value),
    taskMatchesCategory
  )
  const createdCounts = countTasksBy(
    tasks,
    TASK_CREATED_FILTERS.map((item) => item.value),
    (task, createdBy) => createdBy === "all" || task.createdBy === createdBy
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 text-foreground/55 hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-muted",
            active > 0 && "border-foreground/25 text-foreground"
          )}
          aria-label="Filter tasks"
        >
          <ListFilter className="size-4" />
          {active > 0 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
              {active}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.status}
          onValueChange={(value) => set("status", value as TaskStatusFilter)}
        >
          {TASK_STATUS_FILTERS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="ml-auto text-[11px] text-foreground/40">
                {statusCounts[item.value]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Categories</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.category}
          onValueChange={(value) =>
            set("category", value as TaskCategoryFilter)
          }
        >
          {TASK_CATEGORY_FILTERS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="ml-auto text-[11px] text-foreground/40">
                {categoryCounts[item.value]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Created</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.createdBy}
          onValueChange={(value) =>
            set("createdBy", value as TaskCreatedFilter)
          }
        >
          {TASK_CREATED_FILTERS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="ml-auto text-[11px] text-foreground/40">
                {createdCounts[item.value]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {active > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onChange(DEFAULT_TASK_FILTERS)
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

function SchedulingViewInner() {
  const { tasks, loading, error, createTask, setEnabled } = useScheduling()
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [taskFilters, setTaskFilters] =
    React.useState<TaskFilterState>(DEFAULT_TASK_FILTERS)
  const now = useNow(1000)

  const filteredTasks = React.useMemo(
    () => tasks.filter((task) => taskMatchesFilters(task, taskFilters)),
    [tasks, taskFilters]
  )
  const activeTaskFilters = countActiveTaskFilters(taskFilters)
  const selected = tasks.find((t) => t.id === selectedId) ?? null
  const showDetail = creating || !!selected

  const openNew = () => {
    setCreating(true)
    setSelectedId(null)
  }
  const openTask = (id: string) => {
    setCreating(false)
    setSelectedId(id)
  }
  const closeDetail = () => {
    setCreating(false)
    setSelectedId(null)
  }

  return (
    <div className="flex h-full min-h-0">
      {/* List */}
      <div
        className={cn(
          "min-h-0 w-full flex-col border-r border-border/60 md:flex md:w-[340px]",
          showDetail ? "hidden md:flex" : "flex"
        )}
      >
        <header className="flex items-start justify-between gap-2 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-4 md:px-5 md:pt-4">
          <div className="flex min-w-0 items-start gap-2">
            <SidebarTrigger className="-ml-1 size-10 shrink-0 text-foreground/55 hover:text-foreground md:hidden" />
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-[18px] font-semibold">
                <CalendarClock className="size-5 text-foreground/60" />{" "}
                Scheduling
              </h1>
              <p className="mt-0.5 text-[12px] text-foreground/50">
                Results land in your{" "}
                <Link href="/inbox" className="underline underline-offset-2">
                  Inbox
                </Link>{" "}
                when noteworthy.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <TaskFilterMenu
              tasks={tasks}
              filters={taskFilters}
              onChange={setTaskFilters}
            />
            <button
              onClick={openNew}
              className="flex h-8 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[13px] text-background hover:opacity-90"
            >
              <Plus className="size-3.5" /> New
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {error && (
            <div className="mx-2 rounded-md bg-red-50 px-3 py-2 text-[12px] text-[#802020]">
              {error}
            </div>
          )}
          {loading && tasks.length === 0 ? (
            <div className="space-y-2 px-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-lg bg-muted/50"
                />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <p className="px-3 py-10 text-center text-[13px] text-foreground/45">
              No tasks yet. Create one, or ask in chat — e.g. “turn the light
              off in 7h”.
            </p>
          ) : filteredTasks.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] text-foreground/45">
                No tasks match these filters.
              </p>
              {activeTaskFilters > 0 && (
                <button
                  type="button"
                  onClick={() => setTaskFilters(DEFAULT_TASK_FILTERS)}
                  className="mt-3 rounded-md border border-border/70 px-2.5 py-1.5 text-[12px] text-foreground/60 hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-muted"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="mb-2 px-3 text-[11px] text-foreground/40">
                {activeTaskFilters > 0
                  ? `${filteredTasks.length} of ${tasks.length} tasks`
                  : `${tasks.length} tasks`}
              </div>
              <ul className="space-y-0.5">
                {filteredTasks.map((t) => (
                  <li key={t.id}>
                    <div
                      onClick={() => openTask(t.id)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5",
                        selectedId === t.id
                          ? "bg-[#f0ede6] dark:bg-muted"
                          : "hover:bg-[#f0ede6]/60 dark:hover:bg-muted/60"
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          t.status === "error" || t.status === "missed"
                            ? "bg-[#802020]"
                            : t.status === "running"
                              ? "bg-blue-500"
                              : t.enabled
                                ? "bg-emerald-500"
                                : "bg-foreground/25"
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] text-foreground/85">
                          {t.title}
                        </div>
                        <div
                          className="truncate text-[12px] text-foreground/45"
                          title={
                            t.nextRunAt
                              ? new Date(t.nextRunAt).toLocaleString()
                              : ""
                          }
                        >
                          {t.enabled
                            ? `next ${formatRelative(t.nextRunAt, now)}`
                            : "paused"}
                        </div>
                      </div>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={t.enabled}
                          onCheckedChange={(v) => {
                            void setEnabled(t.id, v)
                          }}
                          aria-label="Enabled"
                        />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* Detail */}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:flex",
          showDetail ? "flex" : "hidden md:flex"
        )}
      >
        {creating ? (
          <>
            <header className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
              <button
                onClick={closeDetail}
                className="rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
              >
                <ArrowLeft className="size-4" />
              </button>
              <span className="text-[16px] font-semibold">
                New scheduled task
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <TaskForm
                onSubmit={async (payload) => {
                  await createTask(payload)
                  closeDetail()
                }}
                onCancel={closeDetail}
              />
            </div>
          </>
        ) : selected ? (
          <TaskDetail
            key={selected.id}
            task={selected}
            onClose={closeDetail}
            onBack={closeDetail}
          />
        ) : (
          <div className="hidden h-full items-center justify-center text-[14px] text-foreground/40 md:flex">
            Select a task, or create one.
          </div>
        )}
      </div>
    </div>
  )
}

export function SchedulingView() {
  return (
    <SchedulingProvider>
      <SchedulingViewInner />
    </SchedulingProvider>
  )
}
