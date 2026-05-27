"use client"

import * as React from "react"
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Dumbbell,
  LocateFixed,
  MapPinned,
  MessageCircle,
  RefreshCw,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { LocationDayGoogleMap } from "@/components/library/location-day-google-map"
import type { LibraryPlaceDayResponse } from "@/app/api/library/places/[date]/route"
import type { LibraryPlacesResponse } from "@/app/api/library/places/route"
import type {
  LocationDayDetail,
  LocationDaySummary,
  LocationIntelligenceIntegrationStatus,
  LocationStop,
} from "@/lib/location-intelligence/schema"

const SETUP_PROMPT =
  "Help me set up optional Location Intelligence. I want Home Assistant location updates to flow into a local microscript journal, preserve raw points in points.jsonl, infer stays from gaps until the next webhook, run daily summaries, support retention including keep everything, and show Library Places with Places/Raw layers. Do not enable tracking until I explicitly opt in."
const PREVIEW_BASE_PATH =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_PREVIEW_BASE_PATH ?? ""

function apiPath(path: string) {
  return `${PREVIEW_BASE_PATH}${path}`
}

export function PlacesTab() {
  const [data, setData] = React.useState<LibraryPlacesResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<LocationDayDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailError, setDetailError] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<"places" | "raw">("places")
  const [focusCommand, setFocusCommand] = React.useState<{
    type: "recenter"
    nonce: number
    position: [number, number]
    zoom: number
  } | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(apiPath("/api/library/places?limit=90"), {
        cache: "no-store",
      })
      const body = (await res.json().catch(() => ({}))) as
        | LibraryPlacesResponse
        | { error?: string }
      if (!("status" in body)) {
        throw new Error(
          "error" in body && body.error ? body.error : `HTTP ${res.status}`
        )
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      setData(body)
      setSelectedDate((current) => {
        if (current && body.days.some((day) => day.date === current)) {
          return current
        }
        return latestDate(body.days)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Places")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!selectedDate) {
      setDetail(null)
      return
    }
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    void fetch(apiPath(`/api/library/places/${selectedDate}`), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as
          | LibraryPlaceDayResponse
          | { error?: string }
        if (!("day" in body)) {
          throw new Error(
            "error" in body && body.error ? body.error : `HTTP ${res.status}`
          )
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        setDetail(body.day)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setDetail(null)
        setDetailError(
          err instanceof Error ? err.message : "Failed to load this day"
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false)
      })

    return () => controller.abort()
  }, [selectedDate])

  const status = data?.status
  const days = data?.days ?? []
  const selectedSummary = selectedDate
    ? (days.find((day) => day.date === selectedDate) ?? null)
    : null
  const selectedDay = detail ?? selectedSummary ?? null
  const placeStops = isDayDetail(selectedDay) ? selectedDay.stops : []
  const rawStops = isDayDetail(selectedDay) ? selectedDay.observations : []
  const hasPlaces = placeStops.length > 0
  const hasRaw = rawStops.length > 0
  const activeMode =
    mode === "raw" && hasRaw ? "raw" : hasPlaces ? "places" : "raw"
  const displayStops = activeMode === "raw" ? rawStops : placeStops

  React.useEffect(() => {
    setFocusCommand(null)
  }, [selectedDate, activeMode])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Local location days from the optional Location Intelligence journal:
          map, approximate route, stats, summarized Places, and raw points.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            "disabled:cursor-default disabled:opacity-50"
          )}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <PlacesSkeleton />
      ) : status &&
        (!status.configured || !status.enabled || days.length === 0) ? (
        <PlacesEmptyState status={status} />
      ) : status && selectedDay ? (
        <>
          <PlacesStatusBar
            status={status}
            totalDays={data?.total ?? days.length}
          />
          {detailError ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {detailError}
            </div>
          ) : null}
          <section className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background/80">
            <DayOverview
              day={selectedDay}
              detailLoading={detailLoading}
              mode={activeMode}
              canToggle={hasPlaces && hasRaw}
              onModeChange={setMode}
              days={days}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
            <div className="h-[min(72vh,780px)] min-h-[560px] bg-muted/30">
              {detailLoading && !detail ? (
                <div className="h-full animate-pulse bg-muted/35" />
              ) : (
                <LocationDayGoogleMap
                  title={`Places · ${selectedDay.label}`}
                  route={isDayDetail(selectedDay) ? selectedDay.route : []}
                  stops={displayStops}
                  actionCommand={focusCommand}
                />
              )}
            </div>
            <StopRail
              stops={displayStops}
              mode={activeMode}
              detailLoading={detailLoading}
              onFocus={(stop) => {
                if (!stop.position) return
                setFocusCommand({
                  type: "recenter",
                  nonce: Date.now(),
                  position: stop.position,
                  zoom: activeMode === "raw" ? 17 : 16,
                })
              }}
            />
          </section>
        </>
      ) : null}
    </div>
  )
}

function PlacesStatusBar({
  status,
  totalDays,
}: {
  status: LocationIntelligenceIntegrationStatus
  totalDays: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[12px] text-muted-foreground">
      <StatusPill
        icon={status.connected ? CheckCircle2 : AlertCircle}
        label={status.connected ? "Ready" : "Needs setup"}
        tone={status.connected ? "success" : "warn"}
      />
      <span>{totalDays} days</span>
      <span className="text-border">|</span>
      <span>{status.retention.label}</span>
      <span className="text-border">|</span>
      <span>Maps mode: {status.mapsMode}</span>
      {status.source.label || status.source.entityId ? (
        <>
          <span className="text-border">|</span>
          <span className="truncate">
            Source: {status.source.label ?? status.source.entityId}
          </span>
        </>
      ) : null}
    </div>
  )
}

function StatusPill({
  icon: Icon,
  label,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  tone: "success" | "warn"
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "success"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  )
}

function DayNavigator({
  days,
  selectedDate,
  onSelect,
  compact = false,
}: {
  days: LocationDaySummary[]
  selectedDate: string | null
  onSelect: (date: string) => void
  compact?: boolean
}) {
  const [calendarOpen, setCalendarOpen] = React.useState(false)
  const sortedDays = React.useMemo(
    () => [...days].sort((a, b) => a.date.localeCompare(b.date)),
    [days]
  )
  const selectedIndex = sortedDays.findIndex((day) => day.date === selectedDate)
  const selectedDay =
    selectedIndex >= 0 ? sortedDays[selectedIndex] : (sortedDays.at(-1) ?? null)
  const previousDay = selectedIndex > 0 ? sortedDays[selectedIndex - 1] : null
  const nextDay =
    selectedIndex >= 0 && selectedIndex < sortedDays.length - 1
      ? sortedDays[selectedIndex + 1]
      : null

  return (
    <div
      className={cn(
        "relative z-20 flex",
        compact ? "justify-start" : "justify-center"
      )}
    >
      <div
        className={cn(
          "grid w-full grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-2 rounded-lg border border-border/70 bg-background/80 p-1",
          compact
            ? "shadow-none sm:min-w-[380px]"
            : "shadow-sm sm:w-auto sm:min-w-[420px]"
        )}
      >
        <button
          type="button"
          onClick={() => previousDay && onSelect(previousDay.date)}
          disabled={!previousDay}
          aria-label="Previous location day"
          className={cn(
            "grid size-10 place-items-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            "disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          )}
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          type="button"
          onClick={() => setCalendarOpen((open) => !open)}
          className="min-w-0 rounded-md px-3 py-2 text-center transition-colors hover:bg-muted/70"
          aria-haspopup="dialog"
          aria-expanded={calendarOpen}
        >
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {selectedDay ? formatDayLabelLong(selectedDay) : "No day selected"}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {selectedDay
              ? dayNavigatorSubtitle(selectedDay)
              : "Click to choose a day"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => nextDay && onSelect(nextDay.date)}
          disabled={!nextDay}
          aria-label="Next location day"
          className={cn(
            "grid size-10 place-items-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            "disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          )}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      {calendarOpen ? (
        <LocationCalendarPopover
          days={sortedDays}
          selectedDate={selectedDay?.date ?? null}
          onSelect={(date) => {
            onSelect(date)
            setCalendarOpen(false)
          }}
          onClose={() => setCalendarOpen(false)}
        />
      ) : null}
    </div>
  )
}

function LocationCalendarPopover({
  days,
  selectedDate,
  onSelect,
  onClose,
}: {
  days: LocationDaySummary[]
  selectedDate: string | null
  onSelect: (date: string) => void
  onClose: () => void
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const dayByDate = React.useMemo(
    () => new Map(days.map((day) => [day.date, day])),
    [days]
  )
  const initialMonth = selectedDate ?? days.at(-1)?.date ?? todayDateKey()
  const [visibleMonth, setVisibleMonth] = React.useState(() =>
    monthKey(initialMonth)
  )

  React.useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current) return
      if (rootRef.current.contains(event.target as Node)) return
      onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [onClose])

  const calendarDays = React.useMemo(
    () => calendarGridForMonth(visibleMonth),
    [visibleMonth]
  )

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Choose location day"
      className="absolute top-[calc(100%+8px)] z-50 w-[min(92vw,360px)] rounded-lg border border-border/70 bg-background p-3 shadow-2xl"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
          aria-label="Previous month"
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="text-center">
          <div className="text-[13px] font-semibold text-foreground">
            {formatMonthLabel(visibleMonth)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Days with location summaries
          </div>
        </div>
        <button
          type="button"
          onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
          aria-label="Next month"
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-muted-foreground uppercase">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
          <div key={label} className="py-1">
            {label}
          </div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {calendarDays.map((item) => {
          const day = item.date ? dayByDate.get(item.date) : undefined
          const active = item.date === selectedDate
          return (
            <button
              key={item.key}
              type="button"
              disabled={!day}
              onClick={() => day && onSelect(day.date)}
              className={cn(
                "relative grid h-10 place-items-center rounded-md text-[12px] transition-colors",
                item.inMonth ? "text-foreground" : "text-muted-foreground/40",
                day
                  ? "hover:bg-muted"
                  : "cursor-default text-muted-foreground/25",
                active &&
                  "bg-primary text-primary-foreground shadow-sm hover:bg-primary"
              )}
            >
              <span>{item.dayOfMonth}</span>
              {day && !active ? (
                <span className="absolute bottom-1 size-1 rounded-full bg-primary/70" />
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DayOverview({
  day,
  detailLoading,
  mode,
  canToggle,
  onModeChange,
  days,
  selectedDate,
  onSelectDate,
}: {
  day: LocationDaySummary | LocationDayDetail
  detailLoading: boolean
  mode: "places" | "raw"
  canToggle: boolean
  onModeChange: (mode: "places" | "raw") => void
  days: LocationDaySummary[]
  selectedDate: string | null
  onSelectDate: (date: string) => void
}) {
  const route = "route" in day ? day.route : []
  const visibleCount =
    mode === "raw" && "observations" in day
      ? day.observations.length
      : day.stats.stopCount

  return (
    <div className="grid gap-3 border-b border-border/60 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <DayNavigator
            compact
            days={days}
            selectedDate={selectedDate}
            onSelect={onSelectDate}
          />
          {day.stats.gymDetected ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400">
              <Dumbbell className="size-3" />
              Gym
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3" />
            {day.date}
          </span>
          {day.timezone ? <span>{day.timezone}</span> : null}
          {day.startTime || day.endTime ? (
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3" />
              {formatStopTime(day.startTime, day.endTime)}
            </span>
          ) : null}
        </p>
        {day.summary ? (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {day.summary}
          </p>
        ) : null}
        {canToggle ? (
          <div className="mt-2 inline-grid grid-cols-2 rounded-md border border-border/70 bg-muted/20 p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => onModeChange("places")}
              className={cn(
                "rounded px-2.5 py-1 font-medium transition-colors",
                mode === "places"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Places
            </button>
            <button
              type="button"
              onClick={() => onModeChange("raw")}
              className={cn(
                "rounded px-2.5 py-1 font-medium transition-colors",
                mode === "raw"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Raw
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap gap-2 md:justify-end">
        <Metric
          label={mode === "raw" ? "Raw pts" : "Stops"}
          value={String(visibleCount)}
        />
        <Metric
          label="Samples"
          value={
            day.stats.sampleCount ? String(day.stats.sampleCount) : "No data"
          }
        />
        <Metric
          label="Distance"
          value={
            day.stats.distanceMeters
              ? formatDistance(day.stats.distanceMeters)
              : "No data"
          }
        />
        <Metric
          label="Route"
          value={
            route.length >= 2
              ? `${route.length} pts`
              : detailLoading
                ? "Loading"
                : "Approx"
          }
        />
      </div>
    </div>
  )
}

function StopRail({
  stops,
  mode,
  detailLoading,
  onFocus,
}: {
  stops: LocationStop[]
  mode: "places" | "raw"
  detailLoading: boolean
  onFocus: (stop: LocationStop) => void
}) {
  return (
    <div className="border-t border-border/60 bg-background/95 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-[12px] font-semibold text-muted-foreground uppercase">
          {mode === "raw" ? "Raw points" : "Stops"}
        </h4>
        <span className="text-[11.5px] text-muted-foreground">
          {stops.length > 0
            ? mode === "raw"
              ? `${stops.length} raw observations`
              : `${stops.length} summarized places`
            : mode === "raw"
              ? "No raw observations"
              : "No summarized places"}
        </span>
      </div>

      {detailLoading && stops.length === 0 ? (
        <div className="flex gap-2 overflow-hidden">
          {[1, 2, 3, 4].map((item) => (
            <div
              key={item}
              className="h-16 min-w-[220px] animate-pulse rounded-md bg-muted/45"
            />
          ))}
        </div>
      ) : stops.length > 0 ? (
        <ol className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {stops.map((stop, index) => (
            <li key={stop.id || index} className="min-w-[230px]">
              <button
                type="button"
                disabled={!stop.position}
                onClick={() => onFocus(stop)}
                className={cn(
                  "grid min-h-[68px] w-full grid-cols-[24px_minmax(0,1fr)] gap-2 rounded-md bg-muted/25 px-2.5 py-2 text-left transition-colors",
                  stop.position
                    ? "hover:bg-muted/50"
                    : "cursor-default opacity-70"
                )}
              >
                <span className="mt-0.5 grid size-5 place-items-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-foreground">
                    {stop.label}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>{formatStopWindow(stop)}</span>
                    {stop.kind ? <span>{stop.kind}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[12.5px] text-muted-foreground">
          No stops were summarized for this day yet.
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[82px] rounded-md bg-muted/30 px-2.5 py-1.5">
      <div className="text-[10px] font-medium text-muted-foreground uppercase">
        {label}
      </div>
      <div className="truncate text-[12.5px] font-semibold text-foreground">
        {value}
      </div>
    </div>
  )
}

function PlacesEmptyState({
  status,
}: {
  status: LocationIntelligenceIntegrationStatus
}) {
  const title = !status.configured
    ? "Set up Location Intelligence"
    : !status.enabled
      ? "Location Intelligence is disabled"
      : "No location days yet"
  const description = !status.configured
    ? "Places is optional and reads only a configured local journal. Nothing is tracked until you opt in."
    : !status.enabled
      ? "The local config exists, but tracking is disabled. Ask your assistant to review the setup before enabling it."
      : "The journal is configured, but no daily summaries were found yet. The setup can still be verified from Settings."

  const startSetup = () => {
    try {
      window.localStorage.setItem(
        "chat:draft:new",
        status.setupPrompt || SETUP_PROMPT
      )
    } catch {
      // The chat link still works without a draft.
    }
  }

  return (
    <div className="flex min-h-[430px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/15 px-5 py-10 text-center">
      <div className="flex max-w-xl flex-col items-center gap-4">
        <span className="flex size-12 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm">
          <LocateFixed className="size-5" strokeWidth={1.75} />
        </span>
        <div>
          <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild size="sm">
            <a href="/" onClick={startSetup}>
              <MessageCircle className="size-3.5" />
              Ask your assistant to set up Location Intelligence
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/settings?tab=auth&auth=locationIntelligence">
              <MapPinned className="size-3.5" />
              View status
            </a>
          </Button>
        </div>
        <div className="grid gap-1.5 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-left text-[12px] text-muted-foreground">
          <div>Source: Home Assistant location entity via local webhook.</div>
          <div>Storage: local microscript journal JSON files.</div>
          <div>Retention: finite days or keep everything.</div>
        </div>
      </div>
    </div>
  )
}

function PlacesSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="h-10 animate-pulse rounded-lg bg-muted/35" />
      <div className="min-h-[640px] animate-pulse rounded-lg bg-muted/35" />
    </div>
  )
}

function isDayDetail(
  day: LocationDaySummary | LocationDayDetail | null
): day is LocationDayDetail {
  if (!day) return false
  return "route" in day && "stops" in day
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`
}

function formatStopTime(start: string | null, end: string | null): string {
  if (!start && !end) return "Time not summarized"
  if (start && end) return `${formatTime(start)}-${formatTime(end)}`
  return formatTime(start ?? end ?? "")
}

function formatStopWindow(stop: {
  startTime: string | null
  endTime: string | null
  durationMinutes: number | null
}): string {
  const start = formatTime(stop.startTime ?? "")
  const end = formatTime(stop.endTime ?? "")
  const duration =
    typeof stop.durationMinutes === "number" && stop.durationMinutes > 0
      ? Math.round(stop.durationMinutes)
      : null

  if (start && end && start !== end) {
    return duration ? `${start}-${end} · ${duration} min` : `${start}-${end}`
  }
  if (start || end) {
    if (duration && duration > 1) return `${start || end} · ${duration} min`
    return `${start || end} · <1 min`
  }
  return duration ? `${duration} min` : "Time not summarized"
}

function formatDayLabel(day: LocationDaySummary): string {
  const parsed = Date.parse(`${day.date}T12:00:00Z`)
  if (!Number.isFinite(parsed)) return day.label
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(parsed))
}

function formatDayLabelLong(day: LocationDaySummary): string {
  const parsed = Date.parse(`${day.date}T12:00:00Z`)
  if (!Number.isFinite(parsed)) return day.label
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(parsed))
}

function dayNavigatorSubtitle(day: LocationDaySummary): string {
  const parts: string[] = []
  if (day.stats.stopCount > 0) {
    parts.push(`${day.stats.stopCount} stops`)
  } else if ((day.stats.sampleCount ?? 0) > 0) {
    parts.push(`${day.stats.sampleCount} samples`)
  } else {
    parts.push("No stops")
  }
  if (day.stats.distanceMeters) {
    parts.push(formatDistance(day.stats.distanceMeters))
  }
  return parts.join(" · ")
}

function latestDate(days: LocationDaySummary[]): string | null {
  if (days.length === 0) return null
  return days.reduce((latest, day) => (day.date > latest.date ? day : latest))
    .date
}

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7)
}

function addMonths(yyyyMm: string, delta: number): string {
  const [year, month] = yyyyMm.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1, 12))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

function formatMonthLabel(yyyyMm: string): string {
  const [year, month] = yyyyMm.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1, 12))
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(date)
}

function calendarGridForMonth(yyyyMm: string): Array<{
  key: string
  date: string | null
  dayOfMonth: number | string
  inMonth: boolean
}> {
  const [year, month] = yyyyMm.split("-").map(Number)
  const first = new Date(Date.UTC(year, month - 1, 1, 12))
  const daysInMonth = new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
  const firstWeekdayMonday = (first.getUTCDay() + 6) % 7
  const cells: Array<{
    key: string
    date: string | null
    dayOfMonth: number | string
    inMonth: boolean
  }> = []

  for (let i = 0; i < firstWeekdayMonday; i++) {
    cells.push({
      key: `blank-start-${i}`,
      date: null,
      dayOfMonth: "",
      inMonth: false,
    })
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${yyyyMm}-${String(day).padStart(2, "0")}`
    cells.push({
      key: date,
      date,
      dayOfMonth: day,
      inMonth: true,
    })
  }
  while (cells.length % 7 !== 0) {
    const index = cells.length
    cells.push({
      key: `blank-end-${index}`,
      date: null,
      dayOfMonth: "",
      inMonth: false,
    })
  }
  return cells
}

function formatTime(value: string): string {
  if (!value) return ""
  if (/^\d{1,2}:\d{2}/.test(value)) return value.slice(0, 5)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed))
}
