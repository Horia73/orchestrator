"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowLeft,
  CalendarClock,
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
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { cn } from "@/lib/utils"
import type { ScheduledTask, ScheduleSpec } from "@/lib/scheduling/schema"
import { SchedulingProvider, useScheduling } from "./use-scheduling"
import { TaskForm } from "./task-form"
import { PastRuns } from "./run-history"
import { StatusPill } from "./status-pill"

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
  const { isMobile } = useSidebar()
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
                <Link
                  href="/inbox"
                  replace={isMobile}
                  className="underline underline-offset-2"
                >
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
