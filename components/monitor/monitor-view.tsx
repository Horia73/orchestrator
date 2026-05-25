"use client"

import * as React from "react"
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock3,
  Code2,
  FileCode2,
  Infinity as InfinityIcon,
  Loader2,
  Radar,
  Trash2,
  X,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useAppEvent } from "@/hooks/use-app-events"

import { EmptyState } from "./empty-state"
import {
  asError,
  eventKindBadgeClass,
  formatPast,
  formatRelative,
  sourceIcon,
  sourceLabel,
  useNow,
} from "./helpers"
import { StatusHeader } from "./status-header"
import type {
  HeartbeatStatus,
  MicroscriptDetail,
  MicroscriptEvent,
  MicroscriptRow,
  MicroscriptRun,
  WatchDetail,
  WatchEvent,
  WatchRow,
} from "./types"
import { WatchRowCard } from "./watch-row-card"

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function WatchDetailPanel({
  watchId,
  onClose,
  onBack,
  onDeleted,
  registerRefresh,
}: {
  watchId: string
  onClose: () => void
  onBack: () => void
  onDeleted: () => void
  registerRefresh: (fn: () => void) => void
}) {
  const [watch, setWatch] = React.useState<WatchDetail | null>(null)
  const [events, setEvents] = React.useState<WatchEvent[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadingEvents, setLoadingEvents] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const { confirm, dialog } = useConfirm()
  const now = useNow(1000)

  const fetchDetail = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/monitor/watches/${watchId}`, {
        cache: "no-store",
      })
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as {
        watch: WatchDetail & {
          allowed_actions: Array<{ raw: unknown; description: string }>
        }
      }
      // Server uses `allowed_actions` for the rich form here; map into the
      // shape our component expects without losing the compact label list.
      const detailedActions = data.watch.allowed_actions as unknown as Array<{
        raw: unknown
        description: string
      }>
      const mapped: WatchDetail = {
        ...(data.watch as unknown as WatchDetail),
        allowed_actions: detailedActions.map((a) => a.description),
        allowed_actions_detailed: detailedActions,
      }
      setWatch(mapped)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load watch")
    }
  }, [watchId])

  const fetchEvents = React.useCallback(async () => {
    setLoadingEvents(true)
    try {
      const res = await fetch(
        `/api/monitor/watches/${watchId}/events?limit=60`,
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as { events: WatchEvent[] }
      setEvents(data.events)
    } catch (err) {
      // Events are auxiliary; surface errors inline but don't block.
      console.warn("Failed to load watch events", err)
    } finally {
      setLoadingEvents(false)
    }
  }, [watchId])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setWatch(null)
    setEvents([])
    Promise.all([fetchDetail(), fetchEvents()]).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [watchId, fetchDetail, fetchEvents])

  // Live updates: this watch changed (state checkpoint, enable toggle, …),
  // or its event log got a new entry.
  useAppEvent(
    ["monitor_watches.changed", "monitor_watch_events.changed"],
    (event) => {
      const targetId =
        (event as { watchId?: string }).watchId === undefined
          ? null
          : (event as { watchId?: string }).watchId
      if (targetId !== null && targetId !== watchId) return
      if (event.type === "monitor_watches.changed") void fetchDetail()
      if (event.type === "monitor_watch_events.changed") void fetchEvents()
    }
  )

  // Let the parent trigger a refresh after it mutates.
  React.useEffect(() => {
    registerRefresh(() => {
      void fetchDetail()
      void fetchEvents()
    })
  }, [registerRefresh, fetchDetail, fetchEvents])

  const setEnabled = React.useCallback(
    async (enabled: boolean) => {
      setBusy(true)
      try {
        const res = await fetch(`/api/monitor/watches/${watchId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) throw new Error(await asError(res))
        await fetchDetail()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed")
      } finally {
        setBusy(false)
      }
    },
    [watchId, fetchDetail]
  )

  const removeWatch = React.useCallback(async () => {
    if (!watch) return
    if (
      !(await confirm({
        title: `Delete "${watch.title}"?`,
        message:
          "This removes the watch, its learned filters, and its audit history. The Smart Monitor agent wake pauses automatically if this is your last watch.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    setBusy(true)
    try {
      const res = await fetch(`/api/monitor/watches/${watchId}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(await asError(res))
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setBusy(false)
    }
  }, [watch, watchId, confirm, onDeleted])

  const removePattern = React.useCallback(
    async (patternId: string) => {
      if (
        !(await confirm({
          title: "Remove this suppress pattern?",
          message:
            "Future matches that this pattern was dropping will start surfacing again until the model (or you) add a new pattern.",
          confirmLabel: "Remove",
        }))
      )
        return
      setBusy(true)
      try {
        const res = await fetch(
          `/api/monitor/watches/${watchId}/patterns/${patternId}`,
          { method: "DELETE" }
        )
        if (!res.ok) throw new Error(await asError(res))
        await fetchDetail()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to remove pattern"
        )
      } finally {
        setBusy(false)
      }
    },
    [watchId, fetchDetail, confirm]
  )

  const makePatternPermanent = React.useCallback(
    async (patternId: string) => {
      setBusy(true)
      try {
        const res = await fetch(
          `/api/monitor/watches/${watchId}/patterns/${patternId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expires_at: null }),
          }
        )
        if (!res.ok) throw new Error(await asError(res))
        await fetchDetail()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update pattern"
        )
      } finally {
        setBusy(false)
      }
    },
    [watchId, fetchDetail]
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-foreground/40" />
      </div>
    )
  }

  if (!watch) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-foreground/55">
          {error ?? "Watch not found."}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border/60 px-3 py-1 text-[12px] hover:bg-[#f0ede6] dark:hover:bg-muted"
        >
          Back
        </button>
      </div>
    )
  }

  const decisionEvents = events.filter(
    (event) => event.kind !== "check" && event.kind !== "cadence_change"
  )

  return (
    <>
      {dialog}
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-3 md:gap-3 md:px-5 md:py-4">
        <button
          onClick={onBack}
          className="shrink-0 rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="shrink-0 text-foreground/55">
          {sourceIcon(watch.source, "size-5")}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[16px] font-semibold">
              {watch.title}
            </span>
            {watch.consecutive_errors > 0 && (
              <span
                className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-[#802020] dark:bg-red-950/30 dark:text-red-300"
                title={watch.last_error ?? ""}
              >
                error
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-foreground/55">
            {sourceLabel(watch.source)} · {watch.target}
          </div>
        </div>
        <Switch
          checked={watch.enabled}
          disabled={busy}
          onCheckedChange={(next) => void setEnabled(next)}
          aria-label={watch.enabled ? "Pause watch" : "Enable watch"}
        />
        <button
          title="Delete watch"
          disabled={busy}
          onClick={() => void removeWatch()}
          className="shrink-0 rounded-md p-2 text-[#802020] hover:bg-red-50 disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          title="Close"
          onClick={onClose}
          className="hidden shrink-0 rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] md:inline-flex dark:hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </header>

      {error && (
        <div className="border-b border-border/60 bg-red-50 px-5 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
      {watch.last_error && (
        <div className="border-b border-border/60 bg-amber-50/70 px-5 py-2 text-[12px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Last error: {watch.last_error}
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 md:px-5 md:py-5">
        <Section title="Intent">
          <div className="min-w-0 rounded-md border border-border/60 bg-background px-3 py-2">
            <div className="text-[13px] break-words text-foreground/80">
              {watch.rule_description}
            </div>
            <div className="mt-1 text-[12px] text-foreground/45">
              {sourceLabel(watch.source)} · {watch.target}
            </div>
          </div>
        </Section>

        <Section title="Agent wake">
          <div className="space-y-1 text-[13px] break-words text-foreground/70">
            <p>
              This watch is handled by the single Smart Monitor agent. It starts
              at 15 minutes by default, then the agent adjusts future wakes from
              task state and run history.
            </p>
            <p className="text-[12px] text-foreground/50">
              Notifications and summaries are model decisions at wake time, not
              fixed watch rules.
            </p>
          </div>
        </Section>

        <Section title="Allowed actions">
          {watch.allowed_actions_detailed.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              Notify only. The model cannot take any other action on matches for
              this watch.
            </p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              <li className="flex items-start gap-2">
                <Bell className="mt-0.5 size-3.5 shrink-0 text-foreground/55" />
                <span className="min-w-0 break-words">
                  notify Inbox (always allowed)
                </span>
              </li>
              {watch.allowed_actions_detailed.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-foreground/55" />
                  <span className="min-w-0 break-words">{a.description}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Learned filters (${watch.suppress_patterns.length})`}>
          {watch.suppress_patterns.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No learned filters yet. The agent can add narrow filters when
              repeated candidates turn out to be noise.
            </p>
          ) : (
            <ul className="space-y-2">
              {watch.suppress_patterns.map((p) => (
                <li
                  key={p.id}
                  className="min-w-0 rounded-md border border-border/60 bg-background px-3 py-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium break-words text-foreground">
                        {p.reason}
                      </div>
                      <div className="mt-0.5 max-w-full font-mono text-[11px] [overflow-wrap:anywhere] break-words text-foreground/55">
                        {p.rule_description}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground/45">
                        <span>added {formatPast(p.created_at, now)}</span>
                        <span>{p.match_count} hit(s)</span>
                        {p.last_matched_at && (
                          <span>
                            last hit {formatPast(p.last_matched_at, now)}
                          </span>
                        )}
                        {p.expires_at ? (
                          <span
                            className="inline-flex items-center gap-1"
                            title={`Temporary learned filter. It stops suppressing matches on ${new Date(p.expires_at).toLocaleString()}.`}
                          >
                            <Clock3 className="size-3" />
                            temporary · expires{" "}
                            {formatRelative(p.expires_at, now)}
                          </span>
                        ) : (
                          <span>permanent</span>
                        )}
                      </div>
                    </div>
                    {p.expires_at && (
                      <button
                        title="Make learned filter permanent"
                        aria-label="Make learned filter permanent"
                        disabled={busy}
                        onClick={() => void makePatternPermanent(p.id)}
                        className="shrink-0 rounded-md p-1 text-foreground/45 hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                      >
                        <InfinityIcon className="size-3.5" />
                      </button>
                    )}
                    <button
                      title="Remove pattern"
                      disabled={busy}
                      onClick={() => void removePattern(p.id)}
                      className="shrink-0 rounded-md p-1 text-foreground/45 hover:bg-red-50 hover:text-[#802020] disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent decisions">
          {loadingEvents ? (
            <div className="flex items-center gap-2 text-[12px] text-foreground/55">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </div>
          ) : decisionEvents.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No decisions yet. Silent agent wakes are still recorded in
              Scheduling Past runs.
            </p>
          ) : (
            <ul className="space-y-1">
              {decisionEvents.map((e) => {
                const summary = watchEventSummary(e)
                return (
                  <li
                    key={e.id}
                    className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1 hover:bg-foreground/5"
                  >
                    <span
                      className={cn(
                        "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase",
                        eventKindBadgeClass(e.kind)
                      )}
                    >
                      {e.kind}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-foreground/55">
                        {new Date(e.ts).toLocaleString()} ·{" "}
                        {formatPast(e.ts, now)}
                      </div>
                      {summary && (
                        <div className="mt-0.5 text-[12px] break-words text-foreground/70">
                          {summary}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      </div>
    </>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-foreground/45 uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function watchEventSummary(event: WatchEvent): string | null {
  const payload = event.payload ?? {}
  const text = (key: string) =>
    typeof payload[key] === "string" ? String(payload[key]) : null
  if (event.kind === "match") return text("summary")
  if (event.kind === "notify") return text("summary") ?? text("title")
  if (event.kind === "suppress")
    return text("reason") ?? text("patternReason") ?? text("summary")
  if (event.kind === "feedback") return text("reason")
  if (event.kind === "wake") {
    const matches =
      typeof payload.matches === "number" ? payload.matches : undefined
    return matches === undefined ? "Agent wake" : `${matches} candidate(s)`
  }
  if (event.kind === "action") return text("kind")
  if (event.kind === "error") return text("message")
  return null
}

function scheduleSummary(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return "manual"
  }
  const spec = schedule as { kind?: unknown; everyMs?: unknown; startAt?: unknown }
  if (spec.kind === "manual") return "manual"
  if (spec.kind === "interval") {
    const everyMs = typeof spec.everyMs === "number" ? spec.everyMs : null
    const every = everyMs ? formatDuration(everyMs) : "interval"
    const start =
      typeof spec.startAt === "number"
        ? ` · starts ${new Date(spec.startAt).toLocaleString()}`
        : ""
    return `every ${every}${start}`
  }
  return String(spec.kind ?? "custom")
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function codeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return "(unserializable)"
  }
}

function MicroscriptRowCard({
  script,
  selected,
  onSelect,
}: {
  script: MicroscriptRow
  selected: boolean
  onSelect: () => void
}) {
  const hasError = script.status === "error" || script.consecutive_failures > 0
  const now = useNow(1000)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group w-full min-w-0 cursor-pointer rounded-lg border border-border/60 bg-background px-3 py-3 text-left transition-colors hover:bg-[#f0ede6]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 dark:hover:bg-muted",
        selected && "border-foreground/40 bg-[#f0ede6] dark:bg-muted",
        !script.enabled && "opacity-65"
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 text-foreground/55">
          <FileCode2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
              {script.title}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                hasError
                  ? "bg-red-100 text-[#802020] dark:bg-red-950/30 dark:text-red-300"
                  : script.status === "running"
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                    : "bg-foreground/10 text-foreground/65"
              )}
            >
              {script.status}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-foreground/55">
            {scheduleSummary(script.schedule)}
          </div>
          <div className="mt-1 truncate text-[12px] text-foreground/60">
            {script.description}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/45">
            <span>{script.permission_count} permission(s)</span>
            <span>{script.run_count} run(s)</span>
            {script.next_run_at && <span>next {formatRelative(script.next_run_at, now)}</span>}
            {script.expires_at && <span>expires {new Date(script.expires_at).toLocaleDateString()}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function MicroscriptDetailPanel({
  scriptId,
  onClose,
  onBack,
  registerRefresh,
}: {
  scriptId: string
  onClose: () => void
  onBack: () => void
  registerRefresh: (fn: () => void) => void
}) {
  const [script, setScript] = React.useState<MicroscriptDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const now = useNow(1000)

  const fetchDetail = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/monitor/microscripts/${scriptId}`, {
        cache: "no-store",
      })
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as { script: MicroscriptDetail }
      setScript(data.script)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load microscript")
    }
  }, [scriptId])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setScript(null)
    fetchDetail().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [fetchDetail])

  React.useEffect(() => {
    registerRefresh(() => {
      void fetchDetail()
    })
  }, [registerRefresh, fetchDetail])

  useAppEvent(["microscripts.changed", "microscript_runs.changed"], (event) => {
    const targetId =
      (event as { scriptId?: string }).scriptId === undefined
        ? null
        : (event as { scriptId?: string }).scriptId
    if (targetId !== null && targetId !== scriptId) return
    void fetchDetail()
  })

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-foreground/40" />
      </div>
    )
  }

  if (!script) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-foreground/55">
          {error ?? "Microscript not found."}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border/60 px-3 py-1 text-[12px] hover:bg-[#f0ede6] dark:hover:bg-muted"
        >
          Back
        </button>
      </div>
    )
  }

  return (
    <>
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-3 md:gap-3 md:px-5 md:py-4">
        <button
          onClick={onBack}
          className="shrink-0 rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="shrink-0 text-foreground/55">
          <FileCode2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[16px] font-semibold">
              {script.title}
            </span>
            <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/65">
              {script.status}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-foreground/55">
            {scheduleSummary(script.schedule)}
          </div>
        </div>
        <button
          title="Close"
          onClick={onClose}
          className="hidden shrink-0 rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] md:inline-flex dark:hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </header>

      {error && (
        <div className="border-b border-border/60 bg-red-50 px-5 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
      {script.last_run_error && (
        <div className="border-b border-border/60 bg-amber-50/70 px-5 py-2 text-[12px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Last error: {script.last_run_error}
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 md:px-5 md:py-5">
        <Section title="Purpose">
          <div className="rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] break-words text-foreground/80">
            {script.description}
          </div>
        </Section>

        <Section title="Runtime">
          <div className="grid gap-2 text-[12px] text-foreground/65 sm:grid-cols-2">
            <KeyValue label="Status" value={script.status} />
            <KeyValue label="Schedule" value={scheduleSummary(script.schedule)} />
            <KeyValue label="Next run" value={formatRelative(script.next_run_at, now)} />
            <KeyValue label="Last run" value={formatPast(script.last_run_at, now)} />
            <KeyValue label="Runs" value={String(script.run_count)} />
            <KeyValue label="Permissions" value={String(script.permission_count)} />
          </div>
        </Section>

        <Section title="Code">
          <details className="rounded-md border border-border/60 bg-background">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium text-foreground/75">
              <Code2 className="size-3.5" />
              View Python code
            </summary>
            <pre className="max-h-[460px] overflow-auto border-t border-border/60 bg-foreground/[0.03] p-3 text-[12px] leading-5">
              <code>{script.code}</code>
            </pre>
          </details>
        </Section>

        <Section title="Manifest">
          <pre className="max-h-[300px] overflow-auto rounded-md border border-border/60 bg-background p-3 text-[12px] leading-5">
            <code>{codeJson(script.manifest)}</code>
          </pre>
        </Section>

        <Section title="State">
          <pre className="max-h-[220px] overflow-auto rounded-md border border-border/60 bg-background p-3 text-[12px] leading-5">
            <code>{codeJson(script.state)}</code>
          </pre>
        </Section>

        <Section title="Recent runs">
          <MicroscriptRuns runs={script.runs} now={now} />
        </Section>

        <Section title="Recent events">
          <MicroscriptEvents events={script.events} now={now} />
        </Section>
      </div>
    </>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="text-[11px] font-semibold tracking-wider text-foreground/40 uppercase">
        {label}
      </div>
      <div className="mt-0.5 break-words text-foreground/75">{value}</div>
    </div>
  )
}

function MicroscriptRuns({
  runs,
  now,
}: {
  runs: MicroscriptRun[]
  now: number
}) {
  if (runs.length === 0) {
    return (
      <p className="text-[12px] text-foreground/55">
        No runs recorded yet.
      </p>
    )
  }
  return (
    <ul className="space-y-1">
      {runs.map((run) => (
        <li
          key={run.id}
          className="min-w-0 rounded-md border border-border/60 bg-background px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                run.status === "ok"
                  ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-300"
              )}
            >
              {run.status}
            </span>
            <span>{run.trigger}</span>
            <span>{formatPast(run.startedAt, now)}</span>
            <span>{run.phases} phase(s)</span>
            <span>{run.operations} operation(s)</span>
            {run.surfaced && <span>Inbox</span>}
          </div>
          <div className="mt-1 text-[12px] break-words text-foreground/65">
            {run.error ?? run.summary}
          </div>
        </li>
      ))}
    </ul>
  )
}

function MicroscriptEvents({
  events,
  now,
}: {
  events: MicroscriptEvent[]
  now: number
}) {
  if (events.length === 0) {
    return (
      <p className="text-[12px] text-foreground/55">
        No events recorded yet.
      </p>
    )
  }
  return (
    <ul className="space-y-1">
      {events.map((event) => (
        <li
          key={event.id}
          className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1 hover:bg-foreground/5"
        >
          <span className="mt-0.5 shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-foreground/55 uppercase">
            {event.kind}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-foreground/55">
              {new Date(event.ts).toLocaleString()} · {formatPast(event.ts, now)}
            </div>
            {event.payload && (
              <pre className="mt-0.5 max-h-28 overflow-auto rounded bg-foreground/[0.03] p-2 text-[11px] leading-4 text-foreground/65">
                <code>{codeJson(event.payload)}</code>
              </pre>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function MonitorView() {
  const [activeTab, setActiveTab] = React.useState<"watches" | "microscripts">(
    "watches"
  )
  const [watches, setWatches] = React.useState<WatchRow[]>([])
  const [microscripts, setMicroscripts] = React.useState<MicroscriptRow[]>([])
  const [status, setStatus] = React.useState<HeartbeatStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadingMicroscripts, setLoadingMicroscripts] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selectedMicroscriptId, setSelectedMicroscriptId] = React.useState<
    string | null
  >(null)
  const [busyRowIds, setBusyRowIds] = React.useState<Set<string>>(new Set())
  const detailRefreshRef = React.useRef<(() => void) | null>(null)
  const microscriptDetailRefreshRef = React.useRef<(() => void) | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const [watchesRes, statusRes] = await Promise.all([
        fetch("/api/monitor/watches", { cache: "no-store" }),
        fetch("/api/monitor/status", { cache: "no-store" }),
      ])
      if (!watchesRes.ok) throw new Error(await asError(watchesRes))
      if (!statusRes.ok) throw new Error(await asError(statusRes))
      const w = (await watchesRes.json()) as { watches: WatchRow[] }
      const s = (await statusRes.json()) as HeartbeatStatus
      setWatches(w.watches)
      setStatus(s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])

  const refreshMicroscripts = React.useCallback(async () => {
    setLoadingMicroscripts(true)
    try {
      const res = await fetch("/api/monitor/microscripts", {
        cache: "no-store",
      })
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as { scripts: MicroscriptRow[] }
      setMicroscripts(data.scripts)
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load microscripts"
      )
    } finally {
      setLoadingMicroscripts(false)
    }
  }, [])

  useAppEvent(["monitor_watches.changed"], () => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    ) {
      void refresh()
    }
  })

  useAppEvent(["microscripts.changed", "microscript_runs.changed"], () => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    ) {
      void refreshMicroscripts()
      microscriptDetailRefreshRef.current?.()
    }
  })

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    void refreshMicroscripts()
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void refresh()
        void refreshMicroscripts()
      }
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [refresh, refreshMicroscripts])

  const toggleEnabled = React.useCallback(
    async (id: string, enabled: boolean) => {
      setBusyRowIds((prev) => new Set(prev).add(id))
      try {
        const res = await fetch(`/api/monitor/watches/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) throw new Error(await asError(res))
        await refresh()
        detailRefreshRef.current?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed")
      } finally {
        setBusyRowIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [refresh]
  )

  const handleDeleted = React.useCallback(() => {
    setSelectedId(null)
    void refresh()
  }, [refresh])

  const registerDetailRefresh = React.useCallback((fn: () => void) => {
    detailRefreshRef.current = fn
  }, [])

  const selected = React.useMemo(
    () => watches.find((w) => w.id === selectedId) ?? null,
    [watches, selectedId]
  )
  const selectedMicroscript = React.useMemo(
    () => microscripts.find((script) => script.id === selectedMicroscriptId) ?? null,
    [microscripts, selectedMicroscriptId]
  )

  const registerMicroscriptDetailRefresh = React.useCallback((fn: () => void) => {
    microscriptDetailRefreshRef.current = fn
  }, [])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex min-w-0 flex-col gap-3 border-b border-border/60 px-4 py-3 md:px-5 md:py-4">
        <div className="flex min-w-0 items-start gap-3 md:items-center">
          <SidebarTrigger className="md:hidden" />
          <Radar className="mt-0.5 size-5 shrink-0 text-foreground/55 md:mt-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold">Smart monitor</div>
            <div className="mt-0.5 text-[12px] leading-5 break-words text-foreground/55">
              Model-led watches and deterministic microscripts share this
              monitoring surface. Use watches for judgement-heavy recurring
              work and microscripts for cheap runtime gates.
            </div>
          </div>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            setActiveTab(value === "microscripts" ? "microscripts" : "watches")
          }
          className="gap-0"
        >
          <TabsList className="h-9 self-start border-b-0">
            <TabsTrigger value="watches" className="h-9 px-2.5 text-[13px]">
              <Radar className="size-3.5" />
              Watches
            </TabsTrigger>
            <TabsTrigger
              value="microscripts"
              className="h-9 px-2.5 text-[13px]"
            >
              <FileCode2 className="size-3.5" />
              Microscripts
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {activeTab === "watches" ? (
        <StatusHeader status={status} loading={loading} />
      ) : (
        <div className="border-b border-border/60 px-4 py-3 text-[12px] text-foreground/65 md:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  loadingMicroscripts ? "bg-foreground/30" : "bg-emerald-500"
                )}
              />
              <span className="font-semibold text-foreground">
                Microscripts
              </span>
              <span>
                {loadingMicroscripts
                  ? "loading..."
                  : `${microscripts.filter((s) => s.enabled).length} active`}
              </span>
            </div>
            <span>{microscripts.length} total</span>
            <span>
              {
                microscripts.filter(
                  (s) => s.status === "error" || s.consecutive_failures > 0
                ).length
              }{" "}
              errored
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="border-b border-border/60 bg-red-50 px-5 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeTab === "watches" ? (
          <>
            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3",
                selected &&
                  "hidden md:block md:max-w-[420px] md:border-r md:border-border/60"
              )}
            >
              {loading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-foreground/40" />
                </div>
              ) : watches.length === 0 ? (
                <EmptyState />
              ) : (
                <ul className="space-y-2">
                  {watches.map((w) => (
                    <li key={w.id}>
                      <WatchRowCard
                        watch={w}
                        selected={selectedId === w.id}
                        busy={busyRowIds.has(w.id)}
                        onSelect={() => setSelectedId(w.id)}
                        onToggleEnabled={(enabled) =>
                          toggleEnabled(w.id, enabled)
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selected && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
                <WatchDetailPanel
                  key={selected.id}
                  watchId={selected.id}
                  onClose={() => setSelectedId(null)}
                  onBack={() => setSelectedId(null)}
                  onDeleted={handleDeleted}
                  registerRefresh={registerDetailRefresh}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3",
                selectedMicroscript &&
                  "hidden md:block md:max-w-[420px] md:border-r md:border-border/60"
              )}
            >
              {loadingMicroscripts ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-foreground/40" />
                </div>
              ) : microscripts.length === 0 ? (
                <div className="mx-auto max-w-md py-10 text-center">
                  <FileCode2 className="mx-auto mb-3 size-8 text-foreground/30" />
                  <h2 className="text-[15px] font-semibold text-foreground">
                    No microscripts yet
                  </h2>
                  <p className="mt-2 text-[13px] text-foreground/60">
                    Microscripts are short Python automations for deterministic
                    checks, small state machines, and model escalation after a
                    concrete condition matches.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {microscripts.map((script) => (
                    <li key={script.id}>
                      <MicroscriptRowCard
                        script={script}
                        selected={selectedMicroscriptId === script.id}
                        onSelect={() => setSelectedMicroscriptId(script.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selectedMicroscript && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
                <MicroscriptDetailPanel
                  key={selectedMicroscript.id}
                  scriptId={selectedMicroscript.id}
                  onClose={() => setSelectedMicroscriptId(null)}
                  onBack={() => setSelectedMicroscriptId(null)}
                  registerRefresh={registerMicroscriptDetailRefresh}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
