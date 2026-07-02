"use client"

import * as React from "react"
import {
  ArrowLeft,
  ArrowUpDown,
  BookmarkPlus,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  ExternalLink,
  GripVertical,
  LocateFixed,
  Loader2,
  MapPin,
  MapPinPlus,
  MessageCircle,
  Navigation,
  Phone,
  PersonStanding,
  Plus,
  Save,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type {
  MapCoordinate,
  MapDay,
  MapPin as MapPinType,
} from "@/lib/maps/schema"
import { normalizeSafeHttpUrl } from "@/lib/maps/urls"

import type {
  ActiveDirections,
  DirectionsPoint,
  DirectionsRequest,
  DirectionsTravelMode,
  PinActionIntent,
  PinRow,
  RouteSearchSuggestion,
} from "./types"

import { compactDateLabel } from "./day-tabs"
import {
  createDirectionsSessionToken,
  currentDirectionsPoint,
  directionsPointFromRow,
  formatBusinessStatus,
  formatCompactCount,
  formatPriceLevel,
  isCurrentLocationText,
  nullPoint,
  phoneCallHref,
  routeSummary,
  searchDirectionsPoint,
  todayOpeningHours,
  TRAVEL_MODE_OPTIONS,
  visiblePinDescription,
} from "./directions-utils"

export { DayTabs } from "./day-tabs"
export {
  appendDirectionsNotice,
  currentDirectionsPoint,
  directionsPointFromRow,
  distanceMetersBetween,
  fallbackTravelModes,
  fetchDirectionsRoute,
  formatRouteDistance,
  googleDirectionsUrl,
  isMapCoordinate,
  isTerminalDirectionsError,
  lastRouteCoordinate,
  resolveDirectionsPoint,
  travelModeLabel,
} from "./directions-utils"

const RICH_SIDEBAR_TRANSITION_CLASS =
  "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"

// ---------------------------------------------------------------------------
// Sidebar — cards with photo, name, address, rating. Click → flyToPin.
// Stacked layout on inline mode (sidebar below map); side panel on panel mode.
// ---------------------------------------------------------------------------

/**
 * Inline chips row — wrapping number-and-name chips below the map.
 *
 * No horizontal scroll (the previous design's biggest UX miss was that
 * scroll affordance wasn't obvious). Chips wrap to multiple lines, stay
 * compact, and each is a tap target that flies the map to that pin and
 * opens its InfoWindow. Active chip gets a subtle accent fill so the
 * connection back to the marker stays visible.
 *
 * For more detail (photo, address, description) the user opens the map
 * in fullscreen via the corner button — the rich sidebar lives there.
 */
export function ChipsRow({
  rows,
  activeKey,
  onSelect,
}: {
  rows: PinRow[]
  activeKey: string | null
  onSelect: (row: PinRow) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-0.5">
      {rows.map((row) => {
        const active = row.key === activeKey
        return (
          <button
            key={row.key}
            type="button"
            onClick={() => onSelect(row)}
            className={cn(
              "group inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] font-medium transition-all",
              active
                ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                : "border-border/60 bg-background text-foreground/85 hover:border-border hover:bg-muted/50"
            )}
            title={row.pin.address ?? row.pin.label ?? ""}
          >
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white tabular-nums transition-transform",
                active && "scale-110"
              )}
              style={{ background: row.pin.color ?? "#ef4444" }}
              aria-hidden
            >
              {row.number}
            </span>
            <span className="max-w-[160px] truncate">
              {row.pin.label ?? `Location ${row.number}`}
            </span>
            {typeof row.pin.rating === "number" && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground">
                <Star
                  className="size-2.5 fill-amber-500 text-amber-500"
                  aria-hidden
                />
                {row.pin.rating.toFixed(1)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

const FLOATING_SHEET_COLLAPSED_KEY = "orch:maps:floating-sheet:collapsed"

function useFloatingSheetCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = React.useState(() => {
    if (typeof window === "undefined") return false
    try {
      return window.localStorage.getItem(FLOATING_SHEET_COLLAPSED_KEY) === "1"
    } catch {
      // localStorage may be unavailable (e.g. private mode); default to expanded.
      return false
    }
  })

  React.useEffect(() => {
    if (typeof window === "undefined") return
    function onStorage(event: StorageEvent) {
      if (event.key !== FLOATING_SHEET_COLLAPSED_KEY) return
      setCollapsed(event.newValue === "1")
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const update = React.useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(
        FLOATING_SHEET_COLLAPSED_KEY,
        next ? "1" : "0"
      )
    } catch {
      // Best-effort persistence; in-memory state still updates.
    }
  }, [])

  return [collapsed, update]
}

export function FloatingPlaceSheet({
  row,
  roomy,
  directions,
  activeDirections,
  directionsLoading,
  directionsError,
  onDirections,
  onAddStop,
  onRemoveStop,
  onReorderStops,
  streetViewAvailable,
  onStreetView,
  onClose,
}: {
  row: PinRow
  roomy: boolean
  directions: ActiveDirections | null
  activeDirections?: ActiveDirections | null
  directionsLoading: boolean
  directionsError: string | null
  onDirections: (row: PinRow, request?: DirectionsRequest) => void
  onAddStop?: (row: PinRow) => void | Promise<void>
  onRemoveStop?: (stopIndex: number) => void | Promise<void>
  onReorderStops?: (stops: DirectionsPoint[]) => void | Promise<void>
  streetViewAvailable: boolean
  onStreetView: (row: PinRow) => void
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useFloatingSheetCollapsed()
  const expandedMaxHeight = roomy ? "calc(100% - 2rem)" : "min(72%, 360px)"

  return (
    <section
      aria-label={pinTitle(row)}
      className={cn(
        "absolute right-2 bottom-2 left-14 z-20 flex flex-col overflow-hidden rounded-lg border border-border/70 bg-background text-foreground shadow-2xl",
        "sm:right-auto sm:w-[min(420px,calc(100%_-_4.5rem))]",
        roomy && "right-4 bottom-4 left-16 sm:w-[420px]"
      )}
      style={{ maxHeight: expandedMaxHeight }}
    >
      {collapsed ? (
        <CollapsedPlaceHeader
          row={row}
          onExpand={() => setCollapsed(false)}
          onClose={onClose}
        />
      ) : (
        <>
          {!roomy && (
            <div
              aria-hidden
              className="absolute top-1.5 left-1/2 z-30 h-1 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/30"
            />
          )}
          <div className="absolute top-2 right-2 z-30 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse"
              title="Collapse"
              className="flex size-8 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm ring-1 ring-border/60 backdrop-blur transition-colors hover:bg-muted"
            >
              <ChevronDown className="size-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              className="flex size-8 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm ring-1 ring-border/60 backdrop-blur transition-colors hover:bg-muted"
            >
              <X className="size-4" />
            </button>
          </div>
          <div
            className="min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
            style={{ maxHeight: "inherit" }}
          >
            <div className="relative">
              <PlaceHero row={row} roomy={roomy} />
            </div>
            <div className="space-y-4 p-4">
              <PlaceTitleBlock row={row} />
              <PlaceMeta pin={row.pin} />
              <PlaceActions
                row={row}
                directions={directions}
                activeDirections={activeDirections ?? directions}
                directionsLoading={directionsLoading}
                directionsError={directionsError}
                onDirections={onDirections}
                onAddStop={onAddStop}
                onRemoveStop={onRemoveStop}
                onReorderStops={onReorderStops}
                streetViewAvailable={streetViewAvailable}
                onStreetView={onStreetView}
              />
              <PlaceDescription pin={row.pin} />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function CollapsedPlaceHeader({
  row,
  onExpand,
  onClose,
}: {
  row: PinRow
  onExpand: () => void
  onClose: () => void
}) {
  const loading = isRowLoading(row)
  const photoUrl = safeImageUrl(row.pin.photoUrl)
  const title = row.pin.label?.trim() || pinTitle(row)

  function handleExpandKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (loading) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onExpand()
    }
  }

  return (
    <div className="flex items-center gap-3 p-2.5">
      <div
        role="button"
        tabIndex={loading ? -1 : 0}
        onClick={loading ? undefined : onExpand}
        onKeyDown={handleExpandKey}
        aria-label="Expand"
        aria-disabled={loading || undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !loading && "cursor-pointer"
        )}
      >
        {loading ? (
          <Skeleton className="size-11 shrink-0 rounded-md" />
        ) : photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt=""
            loading="lazy"
            className="size-11 shrink-0 rounded-md bg-muted object-cover"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = "none"
            }}
          />
        ) : (
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-[15px] font-bold text-white tabular-nums shadow-sm"
            style={{ background: row.pin.color ?? "#2563eb" }}
            aria-hidden
          >
            {row.number > 0 ? row.number : <MapPin className="size-5" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          {loading ? (
            <>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </>
          ) : (
            <>
              <span className="block truncate text-[14.5px] leading-tight font-semibold text-foreground">
                {title}
              </span>
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
                {typeof row.pin.rating === "number" && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground">
                    <Star
                      className="size-3 fill-amber-500 text-amber-500"
                      aria-hidden
                    />
                    {row.pin.rating.toFixed(1)}
                    {typeof row.pin.userRatingCount === "number" &&
                      row.pin.userRatingCount > 0 && (
                        <span className="font-medium text-muted-foreground">
                          ({formatCompactCount(row.pin.userRatingCount)})
                        </span>
                      )}
                  </span>
                )}
                <CompactCoordinates position={row.pin.position} />
              </span>
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand"
        title="Expand"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

/**
 * Side panel — panel/fullscreen mode uses the same detail UI as inline, but
 * as a stable right rail. With no active pin it shows the place list.
 */
export function RichSidebar({
  open = true,
  title,
  rows,
  activeKey,
  activeRow,
  onSelect,
  onCloseActive,
  activeDirections,
  directionsLoadingKey,
  directionsError,
  tripDays,
  activeDay,
  onDayChange,
  onDirections,
  onAddStop,
  onRemoveStop,
  onReorderStops,
  streetViewAvailable,
  onStreetView,
  assistantOpen,
  onOpenAssistant,
  onOpenMapLibrary,
  onCollapse,
  framed = false,
}: {
  open?: boolean
  title: string
  rows: PinRow[]
  activeKey: string | null
  activeRow: PinRow | null
  onSelect: (row: PinRow) => void
  onCloseActive: () => void
  activeDirections: ActiveDirections | null
  directionsLoadingKey: string | null
  directionsError: string | null
  tripDays: MapDay[]
  activeDay: number
  onDayChange: (index: number) => void
  onDirections: (row: PinRow, request?: DirectionsRequest) => void
  onAddStop?: (row: PinRow) => void | Promise<void>
  onRemoveStop?: (stopIndex: number) => void | Promise<void>
  onReorderStops?: (stops: DirectionsPoint[]) => void | Promise<void>
  streetViewAvailable: boolean
  onStreetView: (row: PinRow) => void
  assistantOpen: boolean
  onOpenAssistant?: () => void
  onOpenMapLibrary?: () => void
  onCollapse?: () => void
  framed?: boolean
}) {
  const activeRowRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      })
    }
  }, [activeKey])

  if (activeRow) {
    return (
      <aside
        aria-hidden={!open}
        className={cn(
          framed
            ? "flex h-full w-[380px] max-w-[100vw] shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background shadow-none max-sm:w-full"
            : "absolute right-2 bottom-2 left-2 z-20 flex max-h-[min(72dvh,calc(100%_-_1rem))] flex-col overflow-hidden rounded-lg border border-border/60 bg-background shadow-2xl transition-[width,opacity,transform] will-change-[width,transform,opacity] xl:relative xl:inset-auto xl:z-auto xl:max-h-none xl:min-w-0 xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l xl:shadow-none",
          !framed && RICH_SIDEBAR_TRANSITION_CLASS,
          !framed &&
            (open
              ? "pointer-events-auto translate-x-0 opacity-100 xl:w-[380px]"
              : "pointer-events-none translate-x-4 opacity-0 xl:w-0")
        )}
      >
        <header className="border-b border-border/60 px-3 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCloseActive}
              aria-label="Back to locations"
              title="Back to locations"
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1" />
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Close locations"
                title="Close locations"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="mt-2.5">
            <SidebarModeToggle
              mode={assistantOpen ? "chat" : "places"}
              onShowPlaces={onCloseActive}
              onShowAssistant={onOpenAssistant}
              onShowMap={onOpenMapLibrary}
            />
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          <PlaceHero row={activeRow} roomy />
          <div className="space-y-4 p-4">
            <PlaceTitleBlock row={activeRow} />
            <PlaceMeta pin={activeRow.pin} />
            <PlaceActions
              row={activeRow}
              directions={
                activeDirections?.destinationKey === activeRow.key
                  ? activeDirections
                  : null
              }
              activeDirections={activeDirections}
              onAddStop={onAddStop}
              onRemoveStop={onRemoveStop}
              onReorderStops={onReorderStops}
              directionsLoading={
                directionsLoadingKey === activeRow.key ||
                directionsLoadingKey === activeDirections?.destinationKey
              }
              directionsError={directionsError}
              onDirections={onDirections}
              streetViewAvailable={streetViewAvailable}
              onStreetView={onStreetView}
            />
            <PlaceDescription pin={activeRow.pin} />
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        framed
          ? "flex h-full w-[380px] max-w-[100vw] shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background shadow-none max-sm:w-full"
          : "absolute right-2 bottom-2 left-2 z-20 flex max-h-[min(72dvh,calc(100%_-_1rem))] flex-col overflow-hidden rounded-lg border border-border/60 bg-background shadow-2xl transition-[width,opacity,transform] will-change-[width,transform,opacity] xl:relative xl:inset-auto xl:z-auto xl:max-h-none xl:min-w-0 xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l xl:shadow-none",
        !framed && RICH_SIDEBAR_TRANSITION_CLASS,
        !framed &&
          (open
            ? "pointer-events-auto translate-x-0 opacity-100 xl:w-[380px]"
            : "pointer-events-none translate-x-4 opacity-0 xl:w-0")
      )}
    >
      <header className="border-b border-border/60">
        <div className="flex items-center gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              <span className="xl:hidden">Locations</span>
              <span className="hidden xl:inline">{title}</span>
            </div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {rows.length} places
            </div>
          </div>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Close locations"
              title="Close locations"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="px-3 pt-3 pb-3">
          <SidebarModeToggle
            mode={assistantOpen ? "chat" : "places"}
            onShowAssistant={onOpenAssistant}
            onShowMap={onOpenMapLibrary}
          />
        </div>
      </header>
      {tripDays.length > 0 && (
        <TripSidebarSummary
          days={tripDays}
          activeDay={activeDay}
          onDayChange={onDayChange}
        />
      )}
      <ul className="flex-1 overflow-y-auto">
        {rows.map((row) => {
          const active = row.key === activeKey
          const photoUrl = safeImageUrl(row.pin.photoUrl)
          return (
            <li
              key={row.key}
              className="border-b border-border/40 last:border-b-0"
            >
              <button
                ref={active ? activeRowRef : null}
                type="button"
                onClick={() => onSelect(row)}
                className={cn(
                  "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                  active ? "bg-muted/60" : "hover:bg-muted/30"
                )}
              >
                {photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoUrl}
                    alt=""
                    loading="lazy"
                    className="mb-1 h-32 w-full rounded-md bg-muted object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = "none"
                    }}
                  />
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white tabular-nums"
                    style={{ background: row.pin.color ?? "#ef4444" }}
                  >
                    {row.number}
                  </span>
                  <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">
                    {row.pin.label ?? `Location ${row.number}`}
                  </span>
                </div>
                {row.pin.address && (
                  <div className="truncate text-[12px] text-muted-foreground">
                    {row.pin.address}
                  </div>
                )}
                {typeof row.pin.rating === "number" && (
                  <div className="flex items-center gap-1 text-[11.5px] font-medium text-foreground">
                    <Star
                      className="size-3 fill-amber-500 text-amber-500"
                      aria-hidden
                    />
                    {row.pin.rating.toFixed(1)}
                  </div>
                )}
                {visiblePinDescription(row.pin) && (
                  <div className="line-clamp-2 text-[12px] text-foreground/80">
                    {visiblePinDescription(row.pin)}
                  </div>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function SidebarModeToggle({
  mode,
  onShowPlaces,
  onShowAssistant,
  onShowMap,
}: {
  mode: "chat" | "places" | "map"
  onShowPlaces?: () => void
  onShowAssistant?: () => void
  onShowMap?: () => void
}) {
  if (!onShowAssistant && !onShowMap) return <div className="min-w-0 flex-1" />

  return (
    <div
      className="grid h-8 min-w-0 flex-1 grid-cols-3 rounded-lg bg-muted p-0.5"
      aria-label="Map sidebar mode"
    >
      <button
        type="button"
        onClick={onShowAssistant}
        disabled={!onShowAssistant}
        aria-pressed={mode === "chat"}
        className={cn(
          "rounded-md px-2 text-[12px] font-medium transition-colors disabled:cursor-default disabled:opacity-80",
          mode === "chat"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Chat
      </button>
      <button
        type="button"
        onClick={onShowPlaces}
        disabled={!onShowPlaces}
        aria-pressed={mode === "places"}
        className={cn(
          "rounded-md px-2 text-[12px] font-medium transition-colors disabled:cursor-default disabled:opacity-80",
          mode === "places"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Places
      </button>
      <button
        type="button"
        onClick={onShowMap}
        disabled={!onShowMap}
        aria-pressed={mode === "map"}
        className={cn(
          "rounded-md px-2 text-[12px] font-medium transition-colors disabled:cursor-default disabled:opacity-80",
          mode === "map"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Map
      </button>
    </div>
  )
}

function TripSidebarSummary({
  days,
  activeDay,
  onDayChange,
}: {
  days: MapDay[]
  activeDay: number
  onDayChange: (index: number) => void
}) {
  if (activeDay >= 0) {
    const day = days[activeDay]
    if (!day) return null
    return <ActiveDaySummary day={day} />
  }

  return (
    <section className="border-b border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold text-foreground">Itinerary</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {days.length} days
        </span>
      </div>
      <div className="space-y-1.5">
        {days.map((day, index) => (
          <button
            key={day.id}
            type="button"
            onClick={() => onDayChange(index)}
            className="flex w-full min-w-0 items-start gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted"
          >
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-background tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-foreground">
                {day.label}
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                {daySubtitle(day)}
              </span>
              {day.summary && (
                <span className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-foreground/75">
                  {day.summary}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ActiveDaySummary({ day }: { day: MapDay }) {
  const subtitle = daySubtitle(day)
  if (!day.summary && !subtitle) return null
  return (
    <section className="space-y-2 border-b border-border/60 bg-muted/20 px-4 py-3">
      {subtitle && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 py-1">
            <CalendarPlus className="size-3.5" aria-hidden />
            {subtitle}
          </span>
          {day.routes.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 py-1">
              <Navigation className="size-3.5" aria-hidden />
              {day.routes.length} {day.routes.length === 1 ? "route" : "routes"}
            </span>
          )}
        </div>
      )}
      {day.summary && (
        <p className="text-[12.5px] leading-relaxed text-foreground/80">
          {day.summary}
        </p>
      )}
    </section>
  )
}

function daySubtitle(day: MapDay): string {
  const date = day.date ? compactDateLabel(day.date) : null
  const time =
    day.startTime || day.endTime
      ? [day.startTime ?? null, day.endTime ?? null].filter(Boolean).join("–")
      : null
  const count = `${day.pins.length} ${day.pins.length === 1 ? "place" : "places"}`
  return [date, time, count].filter(Boolean).join(" · ")
}

function PlaceHero({ row, roomy }: { row: PinRow; roomy: boolean }) {
  const loading = isRowLoading(row)
  const photoUrl = safeImageUrl(row.pin.photoUrl)

  if (loading) {
    return (
      <Skeleton
        className={cn("block w-full rounded-none", roomy ? "h-40" : "h-28")}
      />
    )
  }

  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        className={cn(
          "block w-full bg-muted object-cover",
          roomy ? "h-40" : "h-28"
        )}
        onError={(e) => {
          ;(e.target as HTMLImageElement).style.display = "none"
        }}
      />
    )
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 bg-muted px-4",
        roomy ? "h-28" : "h-20"
      )}
    >
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-[18px] font-bold text-white tabular-nums shadow-sm"
        style={{ background: row.pin.color ?? "#2563eb" }}
        aria-hidden
      >
        {row.number > 0 ? row.number : <MapPin className="size-5" />}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-foreground">
          {pinTitle(row)}
        </div>
        {row.pin.address && (
          <div className="truncate text-[12px] text-muted-foreground">
            {row.pin.address}
          </div>
        )}
      </div>
    </div>
  )
}

function PlaceTitleBlock({ row }: { row: PinRow }) {
  const loading = isRowLoading(row)
  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        {loading ? (
          <Skeleton className="mt-1 h-6 w-2/3" />
        ) : (
          <h2 className="min-w-0 text-[24px] leading-tight font-semibold tracking-normal break-words text-foreground">
            {pinTitle(row)}
          </h2>
        )}
        {loading ? (
          <Skeleton className="mt-1 h-6 w-14 rounded-md" />
        ) : (
          typeof row.pin.rating === "number" && (
            <div className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[12px] font-semibold text-foreground">
              <Star
                className="size-3 fill-amber-500 text-amber-500"
                aria-hidden
              />
              {row.pin.rating.toFixed(1)}
              {typeof row.pin.userRatingCount === "number" &&
                row.pin.userRatingCount > 0 && (
                  <span className="font-medium text-muted-foreground">
                    ({formatCompactCount(row.pin.userRatingCount)})
                  </span>
                )}
            </div>
          )
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-4 w-4/5" />
      ) : (
        row.pin.address && (
          <div className="mt-3 flex items-start gap-2 text-[13px] leading-snug text-muted-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{row.pin.address}</span>
          </div>
        )
      )}
      <CoordinatesLine position={row.pin.position} />
      {row.dayLabel && (
        <div className="mt-2 text-[12px] font-medium text-muted-foreground">
          {row.dayLabel}
        </div>
      )}
    </div>
  )
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded-md bg-muted-foreground/15",
        className
      )}
    />
  )
}

function CoordinatesLine({ position }: { position: MapCoordinate }) {
  const [lng, lat] = position
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  const formatted = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  return (
    <div className="group/coords mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground tabular-nums">
      <span>({formatted})</span>
      <CopyCoordsButton value={`${lat},${lng}`} />
    </div>
  )
}

/**
 * Compact inline coordinates with hover-revealed copy button. Same shape
 * as `CoordinatesLine` but tuned for the collapsed sheet meta row, where
 * vertical space is tight and the coords sit next to a rating chip.
 */
function CompactCoordinates({ position }: { position: MapCoordinate }) {
  const [lng, lat] = position
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  const formatted = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  return (
    <span className="group/coords inline-flex min-w-0 items-center gap-1 tabular-nums">
      <span className="truncate">({formatted})</span>
      <CopyCoordsButton value={`${lat},${lng}`} compact />
    </span>
  )
}

function CopyCoordsButton({
  value,
  compact = false,
}: {
  value: string
  compact?: boolean
}) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      // Stop propagation so a parent click-target (e.g. the collapsed-sheet
      // expand area) doesn't fire when the user only wanted to copy coords.
      event.stopPropagation()
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value)
        } else {
          const el = document.createElement("textarea")
          el.value = value
          el.setAttribute("readonly", "")
          el.style.position = "absolute"
          el.style.left = "-9999px"
          document.body.appendChild(el)
          el.select()
          document.execCommand("copy")
          document.body.removeChild(el)
        }
        setCopied(true)
      } catch {
        // Clipboard access can fail (permission, focus). Silent — the user
        // can still read the coordinates on screen.
      }
    },
    [value]
  )

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied" : "Copy coordinates"}
      aria-label={copied ? "Coordinates copied" : "Copy coordinates"}
      className={cn(
        "inline-flex items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-muted hover:text-foreground",
        compact ? "size-5" : "size-6",
        "opacity-0 group-hover/coords:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        copied && "text-emerald-600 opacity-100 dark:text-emerald-400"
      )}
    >
      {copied ? (
        <Check className={compact ? "size-3" : "size-3.5"} aria-hidden />
      ) : (
        <Copy className={compact ? "size-3" : "size-3.5"} aria-hidden />
      )}
    </button>
  )
}

function isRowLoading(row: PinRow): boolean {
  return Boolean(row.loading) && !row.pin.label?.trim()
}

function PlaceMeta({ pin }: { pin: MapPinType }) {
  const openingLine = todayOpeningHours(pin.openingHours)
  const businessStatus = formatBusinessStatus(pin.businessStatus)
  const priceLevel = formatPriceLevel(pin.priceLevel)
  const phoneHref = pin.phoneNumber ? phoneCallHref(pin.phoneNumber) : null
  const hasMeta =
    typeof pin.openNow === "boolean" ||
    Boolean(openingLine) ||
    Boolean(pin.phoneNumber) ||
    Boolean(priceLevel) ||
    Boolean(businessStatus)

  if (!hasMeta) return null

  return (
    <section className="space-y-2 text-[12.5px] leading-snug text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        {typeof pin.openNow === "boolean" && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-semibold",
              pin.openNow
                ? "border-emerald-600/20 bg-emerald-50 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-950/35 dark:text-emerald-200"
                : "border-rose-600/20 bg-rose-50 text-rose-800 dark:border-rose-400/20 dark:bg-rose-950/35 dark:text-rose-200"
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                pin.openNow ? "bg-emerald-600" : "bg-rose-600"
              )}
              aria-hidden
            />
            {pin.openNow ? "Deschis acum" : "Închis acum"}
          </span>
        )}
        {businessStatus && (
          <span className="inline-flex items-center rounded-full border border-border/70 px-2 py-1 font-medium text-foreground">
            {businessStatus}
          </span>
        )}
        {priceLevel && (
          <span className="inline-flex items-center rounded-full border border-border/70 px-2 py-1 font-medium text-foreground">
            {priceLevel}
          </span>
        )}
      </div>
      {openingLine && (
        <div className="flex min-w-0 items-start gap-2">
          <Clock3 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{openingLine}</span>
        </div>
      )}
      {pin.phoneNumber && (
        <div className="flex min-w-0 items-center gap-2">
          <Phone className="size-3.5 shrink-0" aria-hidden />
          {phoneHref ? (
            <a
              href={phoneHref}
              aria-label={`Call ${pin.phoneNumber}`}
              title={`Call ${pin.phoneNumber}`}
              className="min-w-0 truncate font-medium text-foreground underline-offset-2 transition-colors hover:underline"
            >
              {pin.phoneNumber}
            </a>
          ) : (
            <span className="min-w-0 truncate">{pin.phoneNumber}</span>
          )}
        </div>
      )}
    </section>
  )
}

function PlaceActions({
  row,
  directions,
  activeDirections,
  directionsLoading,
  directionsError,
  onDirections,
  onAddStop,
  streetViewAvailable,
  onStreetView,
}: {
  row: PinRow
  directions: ActiveDirections | null
  activeDirections?: ActiveDirections | null
  directionsLoading: boolean
  directionsError: string | null
  onDirections: (row: PinRow, request?: DirectionsRequest) => void
  onAddStop?: (row: PinRow) => void | Promise<void>
  onRemoveStop?: (stopIndex: number) => void | Promise<void>
  onReorderStops?: (stops: DirectionsPoint[]) => void | Promise<void>
  streetViewAvailable: boolean
  onStreetView: (row: PinRow) => void
}) {
  const routeForButton = activeDirections ?? directions
  const placeRoleOnRoute = placeRoleOnActiveRoute(row, routeForButton)
  const canAddStop = Boolean(
    onAddStop && routeForButton && placeRoleOnRoute === null
  )
  const plannerDirections = activeDirections ?? directions

  return (
    <div className="space-y-3">
      {canAddStop && routeForButton && onAddStop && (
        <AddStopBanner
          row={row}
          directions={routeForButton}
          onAddStop={onAddStop}
        />
      )}
      <PinIntentActions
        row={row}
        streetViewAvailable={streetViewAvailable}
        onStreetView={onStreetView}
      />
      <DirectionsPlanner
        row={row}
        directions={plannerDirections}
        directionsLoading={directionsLoading}
        directionsError={directionsError}
        onDirections={onDirections}
        showStopEditor={!canAddStop}
      />
    </div>
  )
}

function placeRoleOnActiveRoute(
  row: PinRow,
  directions: ActiveDirections | null | undefined
): "destination" | "origin" | "stop" | null {
  if (!directions) return null
  if (directions.destinationKey === row.key) return "destination"
  const rowPoint = directionsPointFromRow(row)
  if (samePointAsRow(directions.originPoint, rowPoint)) return "origin"
  for (const stop of directions.stops) {
    if (samePointAsRow(stop, rowPoint)) return "stop"
  }
  return null
}

function samePointAsRow(a: DirectionsPoint, b: DirectionsPoint): boolean {
  if (a.placeId && b.placeId) return a.placeId === b.placeId
  if (!a.position || !b.position) return false
  return (
    Math.abs(a.position[0] - b.position[0]) < 1e-6 &&
    Math.abs(a.position[1] - b.position[1]) < 1e-6
  )
}

function AddStopBanner({
  row,
  directions,
  onAddStop,
}: {
  row: PinRow
  directions: ActiveDirections
  onAddStop: (row: PinRow) => void | Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const handleClick = React.useCallback(async () => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      await onAddStop(row)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nu am putut adăuga escala."
      )
    } finally {
      setPending(false)
    }
  }, [onAddStop, pending, row])

  const stopNumber = directions.stops.length + 1
  return (
    <section className="rounded-md border border-cyan-600/30 bg-cyan-50/70 p-3 text-cyan-900 dark:border-cyan-400/30 dark:bg-cyan-950/30 dark:text-cyan-100">
      <div className="flex items-start gap-2">
        <MapPinPlus
          className="mt-0.5 size-4 shrink-0 text-cyan-700 dark:text-cyan-300"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-[12.5px] leading-snug font-semibold">
            Ai o rută activă spre {directions.destinationLabel || "destinație"}.
          </div>
          <div className="text-[11.5px] leading-snug text-cyan-800/80 dark:text-cyan-200/80">
            Vrei să adaugi acest loc ca escală #{stopNumber} înainte de
            destinație?
          </div>
          <button
            type="button"
            onClick={() => void handleClick()}
            disabled={pending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-cyan-700 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-cyan-800 disabled:cursor-wait disabled:opacity-70 dark:bg-cyan-400 dark:text-cyan-950 dark:hover:bg-cyan-300"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            <span>Adaugă ca escală</span>
          </button>
          {error && (
            <div className="text-[11.5px] text-destructive">{error}</div>
          )}
        </div>
      </div>
    </section>
  )
}

function PinIntentActions({
  row,
  streetViewAvailable,
  onStreetView,
}: {
  row: PinRow
  streetViewAvailable: boolean
  onStreetView: (row: PinRow) => void
}) {
  const externalLinks = pinExternalLinks(row.pin)
  const [savedPlaceId, setSavedPlaceId] = React.useState<string | null>(
    row.pin.savedPlaceId ?? null
  )
  const [saveState, setSaveState] = React.useState<PinSaveState>(
    row.pin.savedPlaceId ? "saved" : "idle"
  )

  React.useEffect(() => {
    setSavedPlaceId(row.pin.savedPlaceId ?? null)
    setSaveState(row.pin.savedPlaceId ? "saved" : "idle")
  }, [row.key, row.pin.savedPlaceId])

  // Street View visibility lags the availability signal so the button doesn't
  // flicker while a new pin's check is in flight, and fades out instead of
  // popping when the answer is genuinely "no".
  const [streetViewMounted, setStreetViewMounted] =
    React.useState(streetViewAvailable)
  const [streetViewVisible, setStreetViewVisible] =
    React.useState(streetViewAvailable)

  React.useEffect(() => {
    let mountTimer: ReturnType<typeof setTimeout> | undefined
    let fadeTimer: ReturnType<typeof setTimeout> | undefined

    if (streetViewAvailable) {
      setStreetViewMounted(true)
      fadeTimer = setTimeout(() => setStreetViewVisible(true), 20)
    } else {
      fadeTimer = setTimeout(() => {
        setStreetViewVisible(false)
        mountTimer = setTimeout(() => setStreetViewMounted(false), 220)
      }, 450)
    }

    return () => {
      if (mountTimer) clearTimeout(mountTimer)
      if (fadeTimer) clearTimeout(fadeTimer)
    }
  }, [streetViewAvailable])

  const saved = Boolean(savedPlaceId) || saveState === "saved"
  const busy = saveState === "saving" || saveState === "deleting"

  return (
    <section className="space-y-2 border-t border-border/60 pt-4">
      <div className="grid grid-cols-2 gap-2">
        <PinIntentButton
          label={
            saveState === "deleting" ? "Removing" : saved ? "Unsave" : "Save"
          }
          title={saved ? "Remove this saved place" : "Save this place"}
          Icon={saved ? Trash2 : BookmarkPlus}
          disabled={busy}
          active={saved && saveState !== "deleting"}
          danger={saved}
          onClick={() => {
            if (savedPlaceId) {
              void deleteSavedPlaceFromPin(
                savedPlaceId,
                setSaveState,
                setSavedPlaceId
              )
              return
            }
            void savePinToSavedPlaces(row, setSaveState, setSavedPlaceId)
          }}
        />
        <PinIntentButton
          label="Event"
          title="Create a calendar event here"
          Icon={CalendarPlus}
          onClick={() => draftPinAction(row, "calendar")}
        />
        <PinIntentButton
          label="WhatsApp"
          title="Prepare a WhatsApp message with this place"
          Icon={MessageCircle}
          onClick={() => draftPinAction(row, "whatsapp")}
        />
        <PinIntentButton
          label="Research"
          title="Research this place"
          Icon={Search}
          onClick={() => draftPinAction(row, "research")}
        />
      </div>

      {(streetViewMounted || externalLinks.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {externalLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{link.label}</span>
            </a>
          ))}
          {streetViewMounted && (
            <button
              type="button"
              onClick={() => onStreetView(row)}
              disabled={!streetViewAvailable}
              aria-hidden={!streetViewVisible}
              className={cn(
                "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-[12px] font-medium text-muted-foreground transition-opacity duration-200 hover:bg-muted hover:text-foreground",
                streetViewVisible
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              )}
            >
              <PersonStanding className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">Street View</span>
            </button>
          )}
        </div>
      )}
      {saveState === "error" && (
        <div className="rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-[11.5px] text-destructive">
          Could not update this saved place.
        </div>
      )}
      {savedPlaceId && (
        <SavedPlaceNotes
          savedPlaceId={savedPlaceId}
          initialNotes={row.pin.notes ?? ""}
        />
      )}
    </section>
  )
}

type PinSaveState = "idle" | "saving" | "saved" | "deleting" | "error"

function PinIntentButton({
  label,
  title,
  Icon,
  disabled = false,
  active = false,
  danger = false,
  onClick,
}: {
  label: string
  title: string
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  disabled?: boolean
  active?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border border-border/70 bg-background px-2.5 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70",
        active &&
          !danger &&
          "border-emerald-600/30 bg-emerald-50 text-emerald-800 hover:bg-emerald-50 dark:border-emerald-400/20 dark:bg-emerald-950/35 dark:text-emerald-200",
        active &&
          danger &&
          "border-destructive/25 bg-destructive/5 text-destructive hover:bg-destructive/10"
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  )
}

function SavedPlaceNotes({
  savedPlaceId,
  initialNotes,
}: {
  savedPlaceId: string
  initialNotes: string
}) {
  const [notes, setNotes] = React.useState(initialNotes)
  const [lastSaved, setLastSaved] = React.useState(initialNotes)
  const [state, setState] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")

  React.useEffect(() => {
    setNotes(initialNotes)
    setLastSaved(initialNotes)
    setState("idle")
  }, [initialNotes, savedPlaceId])

  const dirty = notes.trim() !== lastSaved.trim()

  async function saveNotes() {
    setState("saving")
    try {
      const cleanNotes = notes.trim()
      const response = await fetch(
        `/api/maps/saved-places/${encodeURIComponent(savedPlaceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: cleanNotes || null }),
        }
      )
      const body = (await response.json().catch(() => ({}))) as {
        place?: unknown
      }
      if (!response.ok) throw new Error("Failed to save notes.")
      setLastSaved(cleanNotes)
      setState("saved")
      window.dispatchEvent(
        new CustomEvent("orch:maps-saved-place-changed", {
          detail: body.place ?? null,
        })
      )
    } catch {
      setState("error")
    }
  }

  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label
          htmlFor={`saved-place-notes-${savedPlaceId}`}
          className="text-[12px] font-semibold text-foreground"
        >
          Notes
        </label>
        {state === "saved" && !dirty && (
          <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            Saved
          </span>
        )}
      </div>
      <textarea
        id={`saved-place-notes-${savedPlaceId}`}
        value={notes}
        maxLength={2000}
        onChange={(event) => {
          setNotes(event.target.value)
          if (state !== "idle") setState("idle")
        }}
        placeholder="Add private notes for this place..."
        className="min-h-20 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground transition-colors outline-none placeholder:text-muted-foreground focus:border-ring"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[11px]",
            state === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {state === "error"
            ? "Could not save notes."
            : `${notes.length.toLocaleString()}/2000`}
        </span>
        <button
          type="button"
          disabled={!dirty || state === "saving"}
          onClick={() => void saveNotes()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[12px] font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {state === "saving" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save notes
        </button>
      </div>
    </div>
  )
}

type RouteDragKey = "origin" | "destination" | `stop-${number}`

interface RouteWaypointItem {
  key: RouteDragKey
  point: DirectionsPoint
}

function DirectionsPlanner({
  row,
  directions,
  directionsLoading,
  directionsError,
  onDirections,
  showStopEditor = true,
}: {
  row: PinRow
  directions: ActiveDirections | null
  directionsLoading: boolean
  directionsError: string | null
  onDirections: (row: PinRow, request?: DirectionsRequest) => void
  showStopEditor?: boolean
}) {
  const defaultOrigin = React.useMemo(
    () => directions?.originPoint ?? currentDirectionsPoint(),
    [directions]
  )
  const defaultDestination = React.useMemo(
    () => directions?.destinationPoint ?? directionsPointFromRow(row),
    [directions, row]
  )
  const [originPoint, setOriginPoint] = React.useState<DirectionsPoint>(
    () => defaultOrigin
  )
  const [destinationPoint, setDestinationPoint] =
    React.useState<DirectionsPoint>(() => defaultDestination)
  const [originText, setOriginText] = React.useState(defaultOrigin.label)
  const [destinationText, setDestinationText] = React.useState(
    defaultDestination.label
  )
  const [travelMode, setTravelMode] =
    React.useState<DirectionsTravelMode>("driving")
  const [activeField, setActiveField] = React.useState<RoutePointField | null>(
    null
  )
  const [suggestions, setSuggestions] = React.useState<RouteSearchSuggestion[]>(
    []
  )
  const [suggestionsLoading, setSuggestionsLoading] = React.useState(false)
  const [pointResolvingField, setPointResolvingField] =
    React.useState<RoutePointField | null>(null)
  const [plannerError, setPlannerError] = React.useState<string | null>(null)
  const autocompleteRequestRef = React.useRef(0)
  const autocompleteSessionRef = React.useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = React.useState<RouteDragKey | null>(
    null
  )
  const [dragOverKey, setDragOverKey] = React.useState<RouteDragKey | null>(
    null
  )
  const [stopPoints, setStopPoints] = React.useState<DirectionsPoint[]>(
    () => directions?.stops ?? []
  )
  const [reorderMode, setReorderMode] = React.useState(false)
  const routePointCount = 2 + stopPoints.length
  const canDragRoutePoints = reorderMode && routePointCount > 2
  const routeWaypointItems = React.useMemo<RouteWaypointItem[]>(
    () => [
      { key: "origin", point: originPoint },
      ...stopPoints.map(
        (point, index): RouteWaypointItem => ({
          key: `stop-${index}` as RouteDragKey,
          point,
        })
      ),
      { key: "destination", point: destinationPoint },
    ],
    [destinationPoint, originPoint, stopPoints]
  )

  React.useEffect(() => {
    if (routePointCount <= 2) setReorderMode(false)
  }, [routePointCount])

  const syncStopPoints = React.useCallback(
    async (nextStops: DirectionsPoint[]) => {
      setPlannerError(null)
      setSuggestions([])
      setActiveField(null)
      setStopPoints(nextStops)
      if (!directions) return
      await onDirections(row, {
        destinationKey: directions.destinationKey,
        origin: originPoint,
        destination: destinationPoint,
        waypoints: nextStops,
        travelMode,
      })
    },
    [destinationPoint, directions, onDirections, originPoint, row, travelMode]
  )

  const removeStopPoint = React.useCallback(
    async (stopIndex: number) => {
      await syncStopPoints(stopPoints.filter((_, index) => index !== stopIndex))
    },
    [stopPoints, syncStopPoints]
  )

  const reorderRouteWaypoints = React.useCallback(
    (fromKey: RouteDragKey, toKey: RouteDragKey) => {
      if (fromKey === toKey) return
      const fromIndex = routeWaypointItems.findIndex(
        (item) => item.key === fromKey
      )
      const toIndex = routeWaypointItems.findIndex((item) => item.key === toKey)
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return

      const nextItems = routeWaypointItems.slice()
      const [moved] = nextItems.splice(fromIndex, 1)
      nextItems.splice(toIndex, 0, moved)
      const nextOrigin = nextItems[0]?.point
      const nextDestination = nextItems[nextItems.length - 1]?.point
      if (!nextOrigin || !nextDestination) return

      setPlannerError(null)
      setSuggestions([])
      setActiveField(null)
      setOriginPoint(nextOrigin)
      setOriginText(nextOrigin.label)
      setDestinationPoint(nextDestination)
      setDestinationText(nextDestination.label)
      const nextStops = nextItems.slice(1, -1).map((item) => item.point)
      setStopPoints(nextStops)
      if (directions) {
        onDirections(row, {
          destinationKey: directions.destinationKey,
          origin: nextOrigin,
          destination: nextDestination,
          waypoints: nextStops,
          travelMode,
        })
      }
    },
    [directions, onDirections, routeWaypointItems, row, travelMode]
  )

  const startRouteDrag = React.useCallback(
    (event: React.DragEvent, key: RouteDragKey) => {
      if (!canDragRoutePoints) return
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", key)
      setDraggingKey(key)
    },
    [canDragRoutePoints]
  )

  const dragOverRoutePoint = React.useCallback(
    (event: React.DragEvent, key: RouteDragKey) => {
      if (!draggingKey || draggingKey === key) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      setDragOverKey(key)
    },
    [draggingKey]
  )

  const dropRoutePoint = React.useCallback(
    (event: React.DragEvent, key: RouteDragKey) => {
      event.preventDefault()
      if (draggingKey) reorderRouteWaypoints(draggingKey, key)
      setDraggingKey(null)
      setDragOverKey(null)
    },
    [draggingKey, reorderRouteWaypoints]
  )

  const endRouteDrag = React.useCallback(() => {
    setDraggingKey(null)
    setDragOverKey(null)
  }, [])

  React.useEffect(() => {
    setOriginPoint(defaultOrigin)
    setOriginText(defaultOrigin.label)
    setDestinationPoint(defaultDestination)
    setDestinationText(defaultDestination.label)
    setStopPoints(directions?.stops ?? [])
    setTravelMode(directions?.requestedTravelMode ?? "driving")
    setPlannerError(null)
    setSuggestions([])
    setActiveField(null)
    setDraggingKey(null)
    setDragOverKey(null)
    setReorderMode(false)
    autocompleteSessionRef.current = null
  }, [
    defaultDestination,
    defaultOrigin,
    directions?.requestedTravelMode,
    directions?.stops,
  ])

  React.useEffect(() => {
    if (!activeField) {
      setSuggestions([])
      setSuggestionsLoading(false)
      return
    }

    const query =
      activeField === "origin" ? originText.trim() : destinationText.trim()
    if (query.length < 2 || isCurrentLocationText(query)) {
      setSuggestions([])
      setSuggestionsLoading(false)
      return
    }

    if (!autocompleteSessionRef.current) {
      autocompleteSessionRef.current = createDirectionsSessionToken()
    }
    const requestId = autocompleteRequestRef.current + 1
    autocompleteRequestRef.current = requestId
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSuggestionsLoading(true)
      const params = new URLSearchParams({
        q: query,
        center: `${row.pin.position[0]},${row.pin.position[1]}`,
        sessionToken:
          autocompleteSessionRef.current ?? createDirectionsSessionToken(),
      })
      if (navigator.language) params.set("language", navigator.language)

      fetch(`/api/maps/autocomplete?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as {
            suggestions?: RouteSearchSuggestion[]
          }
          if (!response.ok) throw new Error("Autocomplete failed.")
          return body.suggestions ?? []
        })
        .then((items) => {
          if (requestId !== autocompleteRequestRef.current) return
          setSuggestions(items)
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return
          if (requestId !== autocompleteRequestRef.current) return
          setSuggestions([])
        })
        .finally(() => {
          if (requestId === autocompleteRequestRef.current)
            setSuggestionsLoading(false)
        })
    }, 160)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [activeField, destinationText, originText, row.pin.position])

  const updateFieldText = React.useCallback(
    (field: RoutePointField, value: string) => {
      setPlannerError(null)
      setActiveField(field)
      if (field === "origin") {
        setOriginText(value)
        setOriginPoint(
          isCurrentLocationText(value) ? currentDirectionsPoint() : nullPoint()
        )
      } else {
        setDestinationText(value)
        setDestinationPoint(
          isCurrentLocationText(value) ? currentDirectionsPoint() : nullPoint()
        )
      }
    },
    []
  )

  const applyPoint = React.useCallback(
    (field: RoutePointField, point: DirectionsPoint) => {
      if (field === "origin") {
        setOriginPoint(point)
        setOriginText(point.label)
      } else {
        setDestinationPoint(point)
        setDestinationText(point.label)
      }
    },
    []
  )

  const resolveTypedPoint = React.useCallback(
    async (field: RoutePointField): Promise<DirectionsPoint> => {
      const currentPoint = field === "origin" ? originPoint : destinationPoint
      const text =
        field === "origin" ? originText.trim() : destinationText.trim()
      if (currentPoint.kind === "current" || currentPoint.position) {
        return currentPoint
      }
      if (isCurrentLocationText(text)) return currentDirectionsPoint()
      if (!text) {
        throw new Error(
          field === "origin" ? "Alege punctul de plecare." : "Alege destinația."
        )
      }
      const point = await searchDirectionsPoint(text, row.pin.position, {
        sessionToken: autocompleteSessionRef.current,
      })
      applyPoint(field, point)
      return point
    },
    [
      applyPoint,
      destinationPoint,
      destinationText,
      originPoint,
      originText,
      row.pin.position,
    ]
  )

  const selectSuggestion = React.useCallback(
    async (field: RoutePointField, suggestion: RouteSearchSuggestion) => {
      setPlannerError(null)
      setPointResolvingField(field)
      setSuggestions([])
      setActiveField(null)
      try {
        const point = await searchDirectionsPoint(
          suggestion.query || suggestion.title,
          row.pin.position,
          {
            placeId: suggestion.placeId,
            sessionToken: autocompleteSessionRef.current,
          }
        )
        autocompleteSessionRef.current = null
        applyPoint(field, point)
      } catch (error) {
        setPlannerError(
          error instanceof Error ? error.message : "Nu am găsit locația."
        )
      } finally {
        setPointResolvingField((current) =>
          current === field ? null : current
        )
      }
    },
    [applyPoint, row.pin.position]
  )

  const commitField = React.useCallback(
    async (field: RoutePointField) => {
      setPlannerError(null)
      setPointResolvingField(field)
      try {
        const point = await resolveTypedPoint(field)
        applyPoint(field, point)
      } catch (error) {
        setPlannerError(
          error instanceof Error ? error.message : "Nu am găsit locația."
        )
      } finally {
        setPointResolvingField((current) =>
          current === field ? null : current
        )
      }
    },
    [applyPoint, resolveTypedPoint]
  )

  const calculateRoute = React.useCallback(async () => {
    setPlannerError(null)
    setSuggestions([])
    setActiveField(null)
    setPointResolvingField("origin")
    try {
      const origin = await resolveTypedPoint("origin")
      setPointResolvingField("destination")
      const destination = await resolveTypedPoint("destination")
      autocompleteSessionRef.current = null
      onDirections(row, {
        destinationKey: directions?.destinationKey,
        origin,
        destination,
        waypoints: stopPoints,
        travelMode,
      })
    } catch (error) {
      setPlannerError(
        error instanceof Error ? error.message : "Nu am putut calcula ruta."
      )
    } finally {
      setPointResolvingField(null)
    }
  }, [directions, onDirections, resolveTypedPoint, row, stopPoints, travelMode])

  const summary = routeSummary(directions)
  const displayError = plannerError ?? directionsError

  return (
    <section className="space-y-3 border-t border-border/60 pt-4">
      <div className="space-y-2">
        <RoutePointInput
          field="origin"
          marker="A"
          value={originText}
          active={activeField === "origin"}
          loading={
            suggestionsLoading && activeField === "origin"
              ? true
              : pointResolvingField === "origin"
          }
          suggestions={activeField === "origin" ? suggestions : []}
          suggestionsLoading={suggestionsLoading && activeField === "origin"}
          onFocus={() => setActiveField("origin")}
          onBlur={() => {
            window.setTimeout(() => {
              setActiveField((current) =>
                current === "origin" ? null : current
              )
            }, 120)
          }}
          onChange={(value) => updateFieldText("origin", value)}
          onCommit={() => void commitField("origin")}
          onSelectSuggestion={(suggestion) =>
            void selectSuggestion("origin", suggestion)
          }
          draggable={canDragRoutePoints}
          dragging={draggingKey === "origin"}
          dragOver={dragOverKey === "origin"}
          onDragStart={(event) => startRouteDrag(event, "origin")}
          onDragOver={(event) => dragOverRoutePoint(event, "origin")}
          onDrop={(event) => dropRoutePoint(event, "origin")}
          onDragEnd={endRouteDrag}
        />
        {showStopEditor && stopPoints.length > 0 && (
          <RouteStopsEditor
            stops={stopPoints}
            onRemoveStop={removeStopPoint}
            draggable={canDragRoutePoints}
            draggingKey={draggingKey}
            dragOverKey={dragOverKey}
            onDragStart={startRouteDrag}
            onDragOver={dragOverRoutePoint}
            onDrop={dropRoutePoint}
            onDragEnd={endRouteDrag}
          />
        )}
        {showStopEditor && (
          <RouteStopAddControl
            stops={stopPoints}
            onStopsChange={syncStopPoints}
            searchCenter={row.pin.position}
            canReorder={routePointCount > 2}
            reorderMode={reorderMode}
            onToggleReorder={() => setReorderMode((current) => !current)}
          />
        )}
        <RoutePointInput
          field="destination"
          marker="B"
          value={destinationText}
          active={activeField === "destination"}
          loading={
            suggestionsLoading && activeField === "destination"
              ? true
              : pointResolvingField === "destination"
          }
          suggestions={activeField === "destination" ? suggestions : []}
          suggestionsLoading={
            suggestionsLoading && activeField === "destination"
          }
          onFocus={() => setActiveField("destination")}
          onBlur={() => {
            window.setTimeout(() => {
              setActiveField((current) =>
                current === "destination" ? null : current
              )
            }, 120)
          }}
          onChange={(value) => updateFieldText("destination", value)}
          onCommit={() => void commitField("destination")}
          onSelectSuggestion={(suggestion) =>
            void selectSuggestion("destination", suggestion)
          }
          draggable={canDragRoutePoints}
          dragging={draggingKey === "destination"}
          dragOver={dragOverKey === "destination"}
          onDragStart={(event) => startRouteDrag(event, "destination")}
          onDragOver={(event) => dragOverRoutePoint(event, "destination")}
          onDrop={(event) => dropRoutePoint(event, "destination")}
          onDragEnd={endRouteDrag}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex rounded-full border border-border/70 bg-background p-0.5">
          {TRAVEL_MODE_OPTIONS.map(({ value, label, Icon }) => {
            const active = travelMode === value
            return (
              <button
                key={value}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={active}
                onClick={() => setTravelMode(value)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                  active
                    ? "bg-cyan-700 text-white shadow-sm dark:bg-cyan-400 dark:text-cyan-950"
                    : "hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="size-4" />
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => void calculateRoute()}
          disabled={directionsLoading || pointResolvingField !== null}
          className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-cyan-700 px-3 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-cyan-800 disabled:cursor-wait disabled:opacity-70 dark:bg-cyan-400 dark:text-cyan-950 dark:hover:bg-cyan-300"
        >
          {directionsLoading || pointResolvingField ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <Navigation className="size-4 shrink-0" />
          )}
          <span className="truncate">
            {directions ? (summary ?? "Ruta afișată") : "Afișează ruta"}
          </span>
        </button>
      </div>

      {directions?.notice && (
        <div className="rounded-md border border-amber-500/25 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {directions.notice}
        </div>
      )}
      {displayError && (
        <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] leading-snug text-destructive">
          {displayError}
        </div>
      )}
    </section>
  )
}

function RouteStopsEditor({
  stops,
  onRemoveStop,
  draggable,
  draggingKey,
  dragOverKey,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  stops: DirectionsPoint[]
  onRemoveStop: (stopIndex: number) => void | Promise<void>
  draggable: boolean
  draggingKey: RouteDragKey | null
  dragOverKey: RouteDragKey | null
  onDragStart: (event: React.DragEvent, key: RouteDragKey) => void
  onDragOver: (event: React.DragEvent, key: RouteDragKey) => void
  onDrop: (event: React.DragEvent, key: RouteDragKey) => void
  onDragEnd: () => void
}) {
  const [busy, setBusy] = React.useState<{
    kind: "remove"
    index: number
  } | null>(null)

  const runRemove = React.useCallback(
    async (index: number) => {
      setBusy({ kind: "remove", index })
      try {
        await onRemoveStop(index)
      } finally {
        setBusy(null)
      }
    },
    [onRemoveStop]
  )

  return (
    <div className="space-y-1.5">
      {stops.map((stop, index) => {
        const dragKey = `stop-${index}` as RouteDragKey
        return (
          <RouteStopRow
            key={`stop-${index}-${stop.placeId ?? stop.label}`}
            marker={String(index + 1)}
            markerColor="bg-amber-600"
            label={stop.label || stop.address || "Escală"}
            draggable={draggable}
            dragging={draggingKey === dragKey}
            dragOver={dragOverKey === dragKey}
            onDragStart={(event) => onDragStart(event, dragKey)}
            onDragOver={(event) => onDragOver(event, dragKey)}
            onDrop={(event) => onDrop(event, dragKey)}
            onDragEnd={onDragEnd}
            actions={
              <RouteStopActions
                index={index}
                busy={busy}
                canRemove
                onRemove={() => void runRemove(index)}
              />
            }
          />
        )
      })}
    </div>
  )
}

function RouteStopAddControl({
  stops,
  onStopsChange,
  searchCenter,
  canReorder,
  reorderMode,
  onToggleReorder,
}: {
  stops: DirectionsPoint[]
  onStopsChange: (stops: DirectionsPoint[]) => void | Promise<void>
  searchCenter: MapCoordinate
  canReorder: boolean
  reorderMode: boolean
  onToggleReorder: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [showAddInput, setShowAddInput] = React.useState(false)
  const [addError, setAddError] = React.useState<string | null>(null)

  const runAppend = React.useCallback(
    async (point: DirectionsPoint) => {
      setBusy(true)
      try {
        await onStopsChange([...stops, point])
        setShowAddInput(false)
      } finally {
        setBusy(false)
      }
    },
    [onStopsChange, stops]
  )

  return (
    <div className="pt-1">
      {showAddInput ? (
        <RouteStopAddInput
          searchCenter={searchCenter}
          busy={busy}
          onCancel={() => {
            setShowAddInput(false)
            setAddError(null)
          }}
          onSelect={async (point) => {
            setAddError(null)
            try {
              await runAppend(point)
            } catch (err) {
              setAddError(
                err instanceof Error
                  ? err.message
                  : "Nu am putut adăuga escala."
              )
            }
          }}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowAddInput(true)}
            className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-dashed border-border/70 px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3 shrink-0" />
            <span className="truncate">Adaugă escală</span>
          </button>
          {canReorder && (
            <button
              type="button"
              onClick={onToggleReorder}
              aria-label="Reordonează ruta"
              title="Reordonează ruta"
              aria-pressed={reorderMode}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                reorderMode &&
                  "border-cyan-600/60 bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200"
              )}
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {addError && (
        <div className="mt-1 text-[11px] text-destructive">{addError}</div>
      )}
    </div>
  )
}

function RouteStopRow({
  marker,
  markerColor,
  label,
  actions,
  draggable,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  marker: string
  markerColor: string
  label: string
  actions?: React.ReactNode
  draggable?: boolean
  dragging?: boolean
  dragOver?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDrop?: (event: React.DragEvent) => void
  onDragEnd?: () => void
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-full border bg-background px-2.5 shadow-sm transition-colors",
        dragOver ? "border-cyan-600/70 bg-cyan-50/70" : "border-border/70",
        dragging && "opacity-60"
      )}
    >
      {draggable && (
        <button
          type="button"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Trage pentru reordonare"
          title="Trage pentru reordonare"
          className="-ml-1 flex size-6 shrink-0 cursor-grab items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
      )}
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
          markerColor
        )}
        aria-hidden
      >
        {marker}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {label}
      </span>
      {actions}
    </div>
  )
}

function RouteStopActions({
  index,
  busy,
  canRemove,
  onRemove,
}: {
  index: number
  busy: { kind: "remove"; index: number } | null
  canRemove: boolean
  onRemove: () => void
}) {
  const removing = busy?.kind === "remove" && busy.index === index
  const anyBusy = busy !== null
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={anyBusy}
          aria-label="Șterge escala"
          title="Șterge escala"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
        >
          {removing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <X className="size-3" />
          )}
        </button>
      )}
    </div>
  )
}

function RouteStopAddInput({
  searchCenter,
  busy,
  onSelect,
  onCancel,
}: {
  searchCenter: MapCoordinate
  busy?: boolean
  onSelect: (point: DirectionsPoint) => void | Promise<void>
  onCancel: () => void
}) {
  const [text, setText] = React.useState("")
  const [suggestions, setSuggestions] = React.useState<RouteSearchSuggestion[]>(
    []
  )
  const [loading, setLoading] = React.useState(false)
  const requestRef = React.useRef(0)
  const sessionRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const query = text.trim()
    if (query.length < 2) {
      setSuggestions([])
      setLoading(false)
      return
    }
    if (!sessionRef.current) {
      sessionRef.current = createDirectionsSessionToken()
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({
        q: query,
        center: `${searchCenter[0]},${searchCenter[1]}`,
        sessionToken: sessionRef.current ?? createDirectionsSessionToken(),
      })
      if (typeof navigator !== "undefined" && navigator.language) {
        params.set("language", navigator.language)
      }
      fetch(`/api/maps/autocomplete?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as {
            suggestions?: RouteSearchSuggestion[]
          }
          if (!response.ok) throw new Error("Autocomplete failed.")
          return body.suggestions ?? []
        })
        .then((items) => {
          if (requestId !== requestRef.current) return
          setSuggestions(items)
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return
          if (requestId !== requestRef.current) return
          setSuggestions([])
        })
        .finally(() => {
          if (requestId === requestRef.current) setLoading(false)
        })
    }, 160)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [searchCenter, text])

  const pickSuggestion = React.useCallback(
    async (suggestion: RouteSearchSuggestion) => {
      try {
        const point = await searchDirectionsPoint(
          suggestion.query || suggestion.title,
          searchCenter,
          {
            placeId: suggestion.placeId,
            sessionToken: sessionRef.current,
          }
        )
        sessionRef.current = null
        await onSelect(point)
      } catch {
        // Surface via parent; the parent shows the error.
      }
    },
    [onSelect, searchCenter]
  )

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <div className="flex h-9 items-center gap-2 rounded-md border border-cyan-600/60 bg-background px-2 shadow-sm">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                onCancel()
              }
            }}
            placeholder="Caută o escală"
            className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : loading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Anulează"
              title="Anulează"
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {suggestions.length > 0 && (
          <div className="absolute top-[calc(100%_+_4px)] right-0 left-0 z-40 max-h-60 overflow-auto rounded-lg border border-border/70 bg-background shadow-xl">
            {suggestions.map((suggestion) => (
              <button
                key={`escala-${suggestion.id}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void pickSuggestion(suggestion)}
                disabled={busy}
                className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70"
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-foreground">
                    {suggestion.title}
                  </span>
                  {suggestion.subtitle && (
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {suggestion.subtitle}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type RoutePointField = "origin" | "destination"

function RoutePointInput({
  field,
  marker,
  value,
  active,
  loading,
  suggestions,
  suggestionsLoading,
  onFocus,
  onBlur,
  onChange,
  onCommit,
  onSelectSuggestion,
  draggable,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  field: RoutePointField
  marker: string
  value: string
  active: boolean
  loading: boolean
  suggestions: RouteSearchSuggestion[]
  suggestionsLoading: boolean
  onFocus: () => void
  onBlur: () => void
  onChange: (value: string) => void
  onCommit: () => void
  onSelectSuggestion: (suggestion: RouteSearchSuggestion) => void
  draggable?: boolean
  dragging?: boolean
  dragOver?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDrop?: (event: React.DragEvent) => void
  onDragEnd?: () => void
}) {
  const showDropdown = active && (suggestionsLoading || suggestions.length > 0)

  return (
    <div className="relative">
      <div
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        className={cn(
          "flex h-10 min-w-0 items-center gap-2 rounded-full border bg-background px-2.5 shadow-sm transition-colors",
          dragOver
            ? "border-cyan-600/70 bg-cyan-50/70"
            : active
              ? "border-cyan-600/60"
              : "border-border/70",
          dragging && "opacity-60"
        )}
      >
        {draggable && (
          <button
            type="button"
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            aria-label="Trage pentru reordonare"
            title="Trage pentru reordonare"
            className="-ml-1 flex size-6 shrink-0 cursor-grab items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
        )}
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
            field === "origin" ? "bg-slate-600" : "bg-cyan-700"
          )}
          aria-hidden
        >
          {marker}
        </span>
        <input
          value={value}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onCommit()
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={field === "origin" ? "Punct de plecare" : "Destinație"}
        />
        {loading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : field === "origin" && isCurrentLocationText(value) ? (
          <LocateFixed className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      {showDropdown && (
        <div className="absolute top-[calc(100%_+_6px)] right-0 left-0 z-40 overflow-hidden rounded-lg border border-border/70 bg-background shadow-xl">
          {suggestionsLoading && suggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Caut...
            </div>
          ) : (
            suggestions.map((suggestion) => (
              <button
                key={`${field}-${suggestion.id}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectSuggestion(suggestion)}
                className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-foreground">
                    {suggestion.title}
                  </span>
                  {suggestion.subtitle && (
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {suggestion.subtitle}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function PlaceDescription({ pin }: { pin: MapPinType }) {
  const description =
    visiblePinDescription(pin) ?? pin.editorialSummary?.trim() ?? null
  if (!description) return null
  return (
    <section className="border-t border-border/60 pt-4">
      <h3 className="text-[13px] font-semibold text-foreground">Pe scurt</h3>
      <p className="mt-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
        {description}
      </p>
    </section>
  )
}

function pinTitle(row: PinRow): string {
  return row.pin.label ?? `Location ${row.number}`
}

function draftPinAction(row: PinRow, intent: PinActionIntent) {
  if (typeof window === "undefined") return
  const prompt = buildPinActionPrompt(row, intent)
  try {
    window.localStorage.setItem("chat:draft:new", prompt)
    window.localStorage.removeItem("chat:active-id")
  } catch {
    // Best-effort handoff; navigation still opens a fresh chat.
  }
  window.location.assign("/?new=1")
}

async function savePinToSavedPlaces(
  row: PinRow,
  setSaveState: React.Dispatch<React.SetStateAction<PinSaveState>>,
  setSavedPlaceId?: React.Dispatch<React.SetStateAction<string | null>>
) {
  setSaveState("saving")
  try {
    const response = await fetch("/api/maps/saved-places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pinSavedPlacePayload(row)),
    })
    const body = (await response.json().catch(() => ({}))) as {
      place?: unknown
      error?: string
    }
    if (!response.ok) throw new Error(body.error ?? "Failed to save place.")
    const savedPlaceId = readSavedPlaceId(body.place)
    if (savedPlaceId) setSavedPlaceId?.(savedPlaceId)
    setSaveState("saved")
    window.dispatchEvent(
      new CustomEvent("orch:maps-saved-place-changed", {
        detail: body.place ?? null,
      })
    )
  } catch {
    setSaveState("error")
  }
}

async function deleteSavedPlaceFromPin(
  savedPlaceId: string,
  setSaveState: React.Dispatch<React.SetStateAction<PinSaveState>>,
  setSavedPlaceId: React.Dispatch<React.SetStateAction<string | null>>
) {
  setSaveState("deleting")
  try {
    const response = await fetch(
      `/api/maps/saved-places/${encodeURIComponent(savedPlaceId)}`,
      { method: "DELETE" }
    )
    if (!response.ok) throw new Error("Failed to remove saved place.")
    setSavedPlaceId(null)
    setSaveState("idle")
    window.dispatchEvent(
      new CustomEvent("orch:maps-saved-place-changed", {
        detail: { deleted: true, id: savedPlaceId },
      })
    )
  } catch {
    setSaveState("error")
  }
}

function readSavedPlaceId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const id = (value as { id?: unknown }).id
  return typeof id === "string" && id ? id : null
}

function buildPinActionPrompt(row: PinRow, intent: PinActionIntent): string {
  const payload = pinActionPayload(row)
  const title = pinTitle(row)
  const intentPrompt: Record<PinActionIntent, string> = {
    save: `Am salvat locația "${title}". Ajută-mă să decid ce vreau să fac mai departe cu ea.`,
    calendar: `Pregătește un eveniment de calendar la locația "${title}". Întreabă-mă data, ora, durata și titlul dacă lipsesc. Nu crea evenimentul până nu confirm explicit.`,
    whatsapp: `Pregătește un mesaj WhatsApp cu locația "${title}". Întreabă-mă cui să trimiți și textul exact dacă lipsesc. Nu trimite mesajul până nu confirm explicit.`,
    research: `Cercetează locația "${title}" și întoarce-mi concluziile utile. Preferă researcher / web search pentru informații publice, review-uri, program, context de cartier și alternative; folosește browser_agent doar dacă pagina cere interacțiune vizuală, login sau o acțiune într-un site.`,
  }

  return [
    intentPrompt[intent],
    "",
    "Payload pin hartă:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")
}

function pinSavedPlacePayload(row: PinRow) {
  const pin = row.pin
  return {
    title: pinTitle(row),
    address: pin.address ?? null,
    description: visiblePinDescription(pin),
    position: pin.position,
    placeId: pin.placeId ?? null,
    googleMapsUri: safeExternalUrl(pin.googleMapsUri),
    websiteUri: safeExternalUrl(pin.websiteUri),
    sourceUrl: safeExternalUrl(pin.sourceUrl),
    photoUrl: safeImageUrl(pin.photoUrl),
    rating: typeof pin.rating === "number" ? pin.rating : null,
    userRatingCount:
      typeof pin.userRatingCount === "number" ? pin.userRatingCount : null,
    openNow: typeof pin.openNow === "boolean" ? pin.openNow : null,
    phoneNumber: pin.phoneNumber ?? null,
    notes: pin.notes ?? (row.dayLabel ? `From ${row.dayLabel}` : null),
  }
}

function pinActionPayload(row: PinRow) {
  const pin = row.pin
  return {
    id: pin.id,
    title: pinTitle(row),
    address: pin.address ?? null,
    description: visiblePinDescription(pin),
    position: {
      lng: Number(pin.position[0].toFixed(6)),
      lat: Number(pin.position[1].toFixed(6)),
    },
    dayLabel: row.dayLabel ?? null,
    rating: typeof pin.rating === "number" ? pin.rating : null,
    userRatingCount:
      typeof pin.userRatingCount === "number" ? pin.userRatingCount : null,
    placeId: pin.placeId ?? null,
    googleMapsUri: safeExternalUrl(pin.googleMapsUri),
    websiteUri: safeExternalUrl(pin.websiteUri),
    sourceUrl: safeExternalUrl(pin.sourceUrl),
    savedPlaceId: pin.savedPlaceId ?? null,
    notes: pin.notes ?? null,
    openNow: typeof pin.openNow === "boolean" ? pin.openNow : null,
    phoneNumber: pin.phoneNumber ?? null,
  }
}

function pinExternalLinks(
  pin: MapPinType
): Array<{ label: string; href: string }> {
  const googleMapsUrl =
    safeExternalUrl(pin.googleMapsUri) ?? coordinateGoogleMapsUrl(pin.position)
  const links: Array<{ label: string; href: string }> = [
    { label: "Google Maps", href: googleMapsUrl },
  ]
  const websiteUri = safeExternalUrl(pin.websiteUri)
  const sourceUrl = safeExternalUrl(pin.sourceUrl)
  if (websiteUri) links.push({ label: "Website", href: websiteUri })
  if (sourceUrl) links.push({ label: "Source", href: sourceUrl })
  return dedupeExternalLinks(links)
}

function safeExternalUrl(value: string | null | undefined): string | null {
  return normalizeSafeHttpUrl(value, { maxLength: 2000 })
}

function safeImageUrl(value: string | null | undefined): string | null {
  return normalizeSafeHttpUrl(value, { httpsOnly: true, maxLength: 2000 })
}

function coordinateGoogleMapsUrl(position: MapCoordinate): string {
  const [lng, lat] = position
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`
}

function dedupeExternalLinks(
  links: Array<{ label: string; href: string }>
): Array<{ label: string; href: string }> {
  const seen = new Set<string>()
  const out: Array<{ label: string; href: string }> = []
  for (const link of links) {
    if (!link.href || seen.has(link.href)) continue
    seen.add(link.href)
    out.push(link)
  }
  return out
}
