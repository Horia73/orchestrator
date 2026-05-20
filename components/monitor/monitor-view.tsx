"use client"

import * as React from "react"
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Loader2,
  Moon,
  Radar,
  Trash2,
  X,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { cn } from "@/lib/utils"
import { useAppEvent } from "@/hooks/use-app-events"

import { EmptyState } from "./empty-state"
import { GlobalSettingsPanel } from "./global-settings-panel"
import {
  asError,
  eventKindBadgeClass,
  formatCadence,
  formatPast,
  formatRelative,
  sourceIcon,
  sourceLabel,
  useNow,
} from "./helpers"
import { StatusHeader } from "./status-header"
import type {
  HeartbeatStatus,
  MonitorSettings,
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
      const data = (await res.json()) as { watch: WatchDetail & { allowed_actions: Array<{ raw: unknown; description: string }> } }
      // Server uses `allowed_actions` for the rich form here; map into the
      // shape our component expects without losing the compact label list.
      const detailedActions = (data.watch.allowed_actions as unknown as Array<{ raw: unknown; description: string }>)
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
        { cache: "no-store" },
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
    },
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
    [watchId, fetchDetail],
  )

  const removeWatch = React.useCallback(async () => {
    if (!watch) return
    if (
      !(await confirm({
        title: `Delete "${watch.title}"?`,
        message:
          "This removes the watch, its suppress patterns, and its audit history. The Smart Monitor heartbeat pauses automatically if this is your last watch.",
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
          { method: "DELETE" },
        )
        if (!res.ok) throw new Error(await asError(res))
        await fetchDetail()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove pattern")
      } finally {
        setBusy(false)
      }
    },
    [watchId, fetchDetail, confirm],
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
        <div className="shrink-0 text-foreground/55">{sourceIcon(watch.source, "size-5")}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[16px] font-semibold">{watch.title}</span>
            {watch.consecutive_errors > 0 && (
              <span
                className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-[#802020] dark:bg-red-950/30 dark:text-red-300"
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
          className="rounded-md p-2 text-[#802020] hover:bg-red-50 disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          title="Close"
          onClick={onClose}
          className="hidden rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] md:inline-flex dark:hover:bg-muted"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <Section title="Rule">
          <div className="rounded-md bg-foreground/5 px-3 py-2 font-mono text-[12px] text-foreground/75">
            {watch.rule_description}
          </div>
        </Section>

        <Section title="Cadence">
          <KeyValueGrid
            rows={[
              ["Current", formatCadence(watch.cadence.current)],
              ["Min", formatCadence(watch.cadence.min)],
              ["Max", formatCadence(watch.cadence.max)],
              ["Adaptive", watch.cadence.adaptive ? "yes (engine widens/tightens)" : "no (fixed)"],
              ["Next check", formatRelative(watch.next_check_at, now)],
              ["Last check", formatPast(watch.last_checked_at, now)],
              ["Active runs", String(watch.state.activeRuns ?? watch.active_runs)],
              ["Quiet runs", String(watch.state.quietRuns ?? watch.quiet_runs)],
            ]}
          />
        </Section>

        <Section title="Notify policy">
          <KeyValueGrid
            rows={[
              ["On match", watch.notify.onMatch ? "surface to Inbox immediately" : "no immediate Inbox notify"],
              ["Daily digest at", watch.notify.digestAt ?? "—"],
              [
                "Quiet hours",
                watch.notify.quietHours
                  ? `${watch.notify.quietHours.from}-${watch.notify.quietHours.to} (${watch.notify.quietHours.timezone})`
                  : "—",
              ],
            ]}
          />
        </Section>

        <Section title="Allowed actions">
          {watch.allowed_actions_detailed.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              Notify only. The model cannot take any other action on matches for this watch.
            </p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              <li className="flex items-start gap-2">
                <Bell className="mt-0.5 size-3.5 text-foreground/55" />
                <span>notify Inbox (always allowed)</span>
              </li>
              {watch.allowed_actions_detailed.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 text-foreground/55" />
                  <span>{a.description}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Suppress patterns (${watch.suppress_patterns.length})`}>
          {watch.suppress_patterns.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No patterns yet. The model will author them via wake feedback when matches turn out to be noise.
            </p>
          ) : (
            <ul className="space-y-2">
              {watch.suppress_patterns.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md border border-border/60 bg-background px-3 py-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-foreground">
                        {p.reason}
                      </div>
                      <div className="mt-0.5 break-all font-mono text-[11px] text-foreground/55">
                        {p.rule_description}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground/45">
                        <span>added {formatPast(p.created_at, now)}</span>
                        <span>{p.match_count} hit(s)</span>
                        {p.last_matched_at && (
                          <span>last hit {formatPast(p.last_matched_at, now)}</span>
                        )}
                        {p.expires_at && (
                          <span>expires {formatRelative(p.expires_at, now)}</span>
                        )}
                      </div>
                    </div>
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

        <Section title="Recent activity">
          {loadingEvents ? (
            <div className="flex items-center gap-2 text-[12px] text-foreground/55">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </div>
          ) : events.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No events yet — the next master tick will start filling this log.
            </p>
          ) : (
            <ul className="space-y-1">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-foreground/5"
                >
                  <span
                    className={cn(
                      "mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      eventKindBadgeClass(e.kind),
                    )}
                  >
                    {e.kind}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-foreground/55">
                      {new Date(e.ts).toLocaleString()} ·{" "}
                      {formatPast(e.ts, now)}
                    </div>
                    {e.payload && Object.keys(e.payload).length > 0 && (
                      <pre className="mt-0.5 whitespace-pre-wrap break-all rounded bg-foreground/5 px-2 py-1 font-mono text-[11px] text-foreground/70">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              ))}
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
    <section className="mb-6">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-foreground/45">
        {title}
      </h3>
      {children}
    </section>
  )
}

function KeyValueGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[140px_1fr]">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-[12px] text-foreground/55">{k}</dt>
          <dd className="text-[13px] text-foreground">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function MonitorView() {
  const [watches, setWatches] = React.useState<WatchRow[]>([])
  const [status, setStatus] = React.useState<HeartbeatStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [busyRowIds, setBusyRowIds] = React.useState<Set<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settings, setSettings] = React.useState<MonitorSettings | null>(null)
  const detailRefreshRef = React.useRef<(() => void) | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const [watchesRes, statusRes, settingsRes] = await Promise.all([
        fetch("/api/monitor/watches", { cache: "no-store" }),
        fetch("/api/monitor/status", { cache: "no-store" }),
        fetch("/api/monitor/settings", { cache: "no-store" }),
      ])
      if (!watchesRes.ok) throw new Error(await asError(watchesRes))
      if (!statusRes.ok) throw new Error(await asError(statusRes))
      if (!settingsRes.ok) throw new Error(await asError(settingsRes))
      const w = (await watchesRes.json()) as { watches: WatchRow[] }
      const s = (await statusRes.json()) as HeartbeatStatus
      const cfg = (await settingsRes.json()) as { settings: MonitorSettings }
      setWatches(w.watches)
      setStatus(s)
      setSettings(cfg.settings)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])

  useAppEvent(["monitor_watches.changed"], () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void refresh()
    }
  })

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [refresh])

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
    [refresh],
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
    [watches, selectedId],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
        <SidebarTrigger className="md:hidden" />
        <Radar className="size-5 text-foreground/55" />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">Smart monitor</div>
          <div className="mt-0.5 text-[12px] text-foreground/55">
            One consolidated heartbeat across Gmail, WhatsApp, Home Assistant, and
            web endpoints. Add watches from chat — the orchestrator will set them up.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          title="Global quiet hours"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2 text-[12px] text-foreground/65 hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-muted",
            settingsOpen && "border-foreground/30 bg-[#f0ede6] text-foreground dark:bg-muted",
            settings?.quietHours && !settingsOpen && "border-foreground/20 text-foreground",
          )}
        >
          <Moon className="size-3.5" />
          {settings?.quietHours
            ? `Quiet ${settings.quietHours.from}-${settings.quietHours.to}`
            : "Quiet hours"}
        </button>
      </header>

      <GlobalSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChanged={() => void refresh()}
      />

      <StatusHeader status={status} loading={loading} />

      {error && (
        <div className="border-b border-border/60 bg-red-50 px-5 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-3 py-3",
            selected && "hidden md:block md:max-w-[420px] md:border-r md:border-border/60",
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
                    onToggleEnabled={(enabled) => toggleEnabled(w.id, enabled)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <div className="flex min-h-0 flex-1 flex-col bg-background">
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
      </div>
    </div>
  )
}
