"use client"

import * as React from "react"
import {
  BookmarkPlus,
  Check,
  Loader2,
  MapPinned,
  Pencil,
  Route,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  formatAreaSqKm,
  formatDate,
  MAX_ROUTE_STOPS,
  type SavedMapArea,
  type SavedMapPlace,
  type SmartMapItem,
} from "@/components/maps/smart-maps-model"
import { cn } from "@/lib/utils"

export function MapLibraryDrawer({
  maps,
  savedPlaces,
  savedAreas,
  allCount,
  savedPlacesCount,
  savedAreasCount,
  query,
  listLoading,
  listError,
  mapDeletingId,
  mapDeleteError,
  savedPlacesLoading,
  savedPlacesError,
  savedAreasLoading,
  savedAreasError,
  savedPlacesVisible,
  savedAreasVisible,
  routePlaceIds,
  routeLoading,
  routeError,
  routeSaveLoading,
  routeSaveError,
  routeSummary,
  routeWarning,
  routeSavedMapId,
  activeMapId,
  onSavedPlacesVisibleChange,
  onSavedAreasVisibleChange,
  onToggleRoutePlace,
  onClearRoutePlaces,
  onBuildRoute,
  onSaveRouteMap,
  onQueryChange,
  onShowChat,
  onShowPlaces,
  onClose,
  onSelect,
  onDeleteMap,
  onSelectSavedPlace,
  onDeleteSavedPlace,
  onSelectSavedArea,
  onDeleteSavedArea,
  docked = false,
}: {
  maps: SmartMapItem[]
  savedPlaces: SavedMapPlace[]
  savedAreas: SavedMapArea[]
  allCount: number
  savedPlacesCount: number
  savedAreasCount: number
  query: string
  listLoading: boolean
  listError: string | null
  mapDeletingId: string | null
  mapDeleteError: string | null
  savedPlacesLoading: boolean
  savedPlacesError: string | null
  savedAreasLoading: boolean
  savedAreasError: string | null
  savedPlacesVisible: boolean
  savedAreasVisible: boolean
  routePlaceIds: string[]
  routeLoading: boolean
  routeError: string | null
  routeSaveLoading: boolean
  routeSaveError: string | null
  routeSummary: string | null
  routeWarning: string | null
  routeSavedMapId: string | null
  activeMapId: string | null
  onSavedPlacesVisibleChange: (visible: boolean) => void
  onSavedAreasVisibleChange: (visible: boolean) => void
  onToggleRoutePlace: (id: string) => void
  onClearRoutePlaces: () => void
  onBuildRoute: () => void
  onSaveRouteMap: () => void
  onQueryChange: (value: string) => void
  onShowChat: () => void
  onShowPlaces: () => void
  onClose: () => void
  onSelect: (id: string) => void
  onDeleteMap: (item: SmartMapItem) => void
  onSelectSavedPlace: (place: SavedMapPlace) => void
  onDeleteSavedPlace: (id: string) => void
  onSelectSavedArea: (area: SavedMapArea) => void
  onDeleteSavedArea: (id: string) => void
  docked?: boolean
}) {
  const hasQuery = query.trim().length > 0
  const hasAnyResults =
    savedPlaces.length > 0 || savedAreas.length > 0 || maps.length > 0
  const routePlaceIdSet = React.useMemo(
    () => new Set(routePlaceIds),
    [routePlaceIds]
  )
  const routeSelectionCount = routePlaceIds.length

  return (
    <aside
      className={cn(
        "flex w-[380px] max-w-[100vw] shrink-0 flex-col overflow-hidden border-l border-border/70 bg-background shadow-xl",
        docked
          ? "relative h-full rounded-none border-y-0 border-r-0 shadow-none"
          : "absolute top-0 right-0 bottom-0 z-[70] max-sm:fixed max-sm:inset-0 max-sm:z-[80] max-sm:w-auto max-sm:rounded-none max-sm:border-0"
      )}
    >
      <header className="shrink-0 border-b border-border/70 px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              Maps
            </div>
            <div className="text-[11px] text-muted-foreground">
              {savedPlacesCount} places · {savedAreasCount} areas · {allCount}{" "}
              maps
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close map library"
            title="Close map library"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div
          className="mt-3 grid h-8 min-w-0 grid-cols-3 rounded-lg bg-muted p-0.5"
          aria-label="Map sidebar mode"
        >
          <button
            type="button"
            onClick={onShowChat}
            className="rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Chat
          </button>
          <button
            type="button"
            onClick={onShowPlaces}
            className="rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Places
          </button>
          <button
            type="button"
            aria-pressed
            className="rounded-md bg-background px-2 text-[12px] font-medium text-foreground shadow-sm"
          >
            Map
          </button>
        </div>
      </header>

      <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search maps, places, and areas..."
            className="h-9 pl-8 text-[13px]"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={savedPlacesVisible ? "secondary" : "outline"}
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
            disabled={savedPlacesCount === 0}
            aria-pressed={savedPlacesVisible}
            onClick={() => onSavedPlacesVisibleChange(!savedPlacesVisible)}
          >
            <BookmarkPlus className="size-3.5" />
            <span>Places</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {savedPlacesCount}
            </span>
          </Button>
          <Button
            type="button"
            variant={savedAreasVisible ? "secondary" : "outline"}
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
            disabled={savedAreasCount === 0}
            aria-pressed={savedAreasVisible}
            onClick={() => onSavedAreasVisibleChange(!savedAreasVisible)}
          >
            <Pencil className="size-3.5" />
            <span>Areas</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {savedAreasCount}
            </span>
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {listLoading && savedPlacesLoading && savedAreasLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading Smart Maps...
          </div>
        ) : !hasAnyResults &&
          !listError &&
          !mapDeleteError &&
          !savedPlacesError &&
          !savedAreasError ? (
          <EmptyDrawerState hasQuery={hasQuery} />
        ) : (
          <div className="space-y-4">
            <DrawerSectionHeader
              title="Saved places"
              count={savedPlaces.length}
              loading={savedPlacesLoading}
            />
            {savedPlacesError ? (
              <DrawerError>{savedPlacesError}</DrawerError>
            ) : savedPlaces.length === 0 ? (
              <DrawerEmptyLine>
                {hasQuery
                  ? "No saved places match that search."
                  : "Open a pin and press Save to keep it here."}
              </DrawerEmptyLine>
            ) : (
              <ul className="space-y-1.5">
                {savedPlaces.map((place) => (
                  <li key={place.id}>
                    <SavedPlaceButton
                      place={place}
                      selectedForRoute={routePlaceIdSet.has(place.id)}
                      routeOrder={
                        routePlaceIdSet.has(place.id)
                          ? routePlaceIds.indexOf(place.id) + 1
                          : null
                      }
                      routeDisabled={
                        !routePlaceIdSet.has(place.id) &&
                        routePlaceIds.length >= MAX_ROUTE_STOPS
                      }
                      onSelect={() => onSelectSavedPlace(place)}
                      onToggleRoute={() => onToggleRoutePlace(place.id)}
                      onDelete={() => onDeleteSavedPlace(place.id)}
                    />
                  </li>
                ))}
              </ul>
            )}

            <div className="border-t border-border/70 pt-3">
              <DrawerSectionHeader
                title="Saved areas"
                count={savedAreas.length}
                loading={savedAreasLoading}
              />
              {savedAreasError ? (
                <DrawerError>{savedAreasError}</DrawerError>
              ) : savedAreas.length === 0 ? (
                <DrawerEmptyLine>
                  {hasQuery
                    ? "No saved areas match that search."
                    : "Use Draw area on the map, then press Save."}
                </DrawerEmptyLine>
              ) : (
                <ul className="space-y-1.5">
                  {savedAreas.map((area) => (
                    <li key={area.id}>
                      <SavedAreaButton
                        area={area}
                        onSelect={() => onSelectSavedArea(area)}
                        onDelete={() => onDeleteSavedArea(area.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-border/70 pt-3">
              <DrawerSectionHeader
                title="Maps"
                count={maps.length}
                loading={listLoading}
              />
              {listError || mapDeleteError ? (
                <DrawerError>{listError ?? mapDeleteError}</DrawerError>
              ) : maps.length === 0 ? (
                <DrawerEmptyLine>
                  {hasQuery
                    ? "No maps match that search."
                    : "Ask Greeny to show locations on a map, or save a route from selected places."}
                </DrawerEmptyLine>
              ) : (
                <ul className="space-y-1.5">
                  {maps.map((item) => (
                    <li key={item.id}>
                      <MapLibraryButton
                        item={item}
                        active={item.id === activeMapId}
                        deleting={mapDeletingId === item.id}
                        onSelect={() => onSelect(item.id)}
                        onDelete={() => onDeleteMap(item)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {(routeSelectionCount > 0 || routeError || routeSummary) && (
        <div className="shrink-0 border-t border-border/70 bg-background/95 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-foreground">
                {routeSelectionCount > 0
                  ? `${routeSelectionCount} saved ${
                      routeSelectionCount === 1 ? "place" : "places"
                    } selected`
                  : "Saved route"}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {routeSummary ??
                  "Starts from your current Smart Maps location."}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {routeSelectionCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-[12px]"
                  onClick={onClearRoutePlaces}
                >
                  Clear
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-[12px]"
                disabled={routeSelectionCount === 0 || routeLoading}
                onClick={onBuildRoute}
              >
                {routeLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Route className="size-3.5" />
                )}
                Route
              </Button>
              {routeSummary && (
                <Button
                  type="button"
                  variant={routeSavedMapId ? "secondary" : "outline"}
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-[12px]"
                  disabled={routeSaveLoading || Boolean(routeSavedMapId)}
                  onClick={onSaveRouteMap}
                >
                  {routeSaveLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : routeSavedMapId ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {routeSavedMapId ? "Saved" : "Save"}
                </Button>
              )}
            </div>
          </div>
          {(routeError || routeSaveError || routeWarning) && (
            <div
              className={cn(
                "mt-2 rounded-md border px-2 py-1.5 text-[11.5px] leading-snug",
                routeError || routeSaveError
                  ? "border-destructive/25 bg-destructive/5 text-destructive"
                  : "border-amber-500/25 bg-amber-50 text-amber-900 dark:bg-amber-950/25 dark:text-amber-200"
              )}
            >
              {routeError ?? routeSaveError ?? routeWarning}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function EmptyDrawerState({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <div className="mx-auto flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/30">
          <MapPinned className="size-4 text-muted-foreground" />
        </div>
        <h2 className="mt-3 text-sm font-semibold text-foreground">
          {hasQuery ? "No maps match that search" : "No maps yet"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {hasQuery
            ? "Try another title, conversation, or artifact id."
            : "Ask Greeny to show locations, trips, routes, or research results on a map."}
        </p>
      </div>
    </div>
  )
}

function DrawerSectionHeader({
  title,
  count,
  loading,
}: {
  title: string
  count: number
  loading: boolean
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 px-1">
      <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
        {loading && <Loader2 className="size-3 animate-spin" />}
        {count}
      </span>
    </div>
  )
}

function DrawerError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
      {children}
    </div>
  )
}

function DrawerEmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12px] leading-snug text-muted-foreground">
      {children}
    </div>
  )
}

function SavedPlaceButton({
  place,
  selectedForRoute,
  routeOrder,
  routeDisabled,
  onSelect,
  onToggleRoute,
  onDelete,
}: {
  place: SavedMapPlace
  selectedForRoute: boolean
  routeOrder: number | null
  routeDisabled: boolean
  onSelect: () => void
  onToggleRoute: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-stretch overflow-hidden rounded-lg border border-border/60 bg-background transition-colors hover:border-border hover:bg-muted/35">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <BookmarkPlus className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {place.title}
          </span>
          {place.address && (
            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
              {place.address}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {formatDate(place.updatedAt)}
          </span>
        </span>
        {typeof place.rating === "number" && (
          <span className="mt-1 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
            {place.rating.toFixed(1)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onToggleRoute}
        disabled={routeDisabled}
        aria-label={
          selectedForRoute
            ? `Remove ${place.title} from route`
            : `Add ${place.title} to route`
        }
        title={selectedForRoute ? "Remove from route" : "Add to route"}
        className={cn(
          "flex w-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground opacity-80 transition-colors group-hover:opacity-100 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35",
          selectedForRoute &&
            "bg-cyan-700 text-white hover:bg-cyan-800 hover:text-white"
        )}
      >
        {selectedForRoute && routeOrder ? (
          <span className="text-[11px] font-bold tabular-nums">
            {routeOrder}
          </span>
        ) : (
          <Route className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete saved place ${place.title}`}
        title="Delete saved place"
        className="flex w-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground opacity-70 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function SavedAreaButton({
  area,
  onSelect,
  onDelete,
}: {
  area: SavedMapArea
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-stretch overflow-hidden rounded-lg border border-border/60 bg-background transition-colors hover:border-border hover:bg-muted/35">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
      >
        <span
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-white"
          style={{ background: area.color || "#1a73e8" }}
        >
          <Pencil className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {area.title}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            {formatAreaSqKm(area.areaSqKm ?? 0)} · {area.ring.length} pts
          </span>
          {area.description && (
            <span className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-foreground/75">
              {area.description}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {formatDate(area.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete saved area ${area.title}`}
        title="Delete saved area"
        className="flex w-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground opacity-70 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function MapLibraryButton({
  item,
  active,
  deleting,
  onSelect,
  onDelete,
}: {
  item: SmartMapItem
  active: boolean
  deleting: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-stretch overflow-hidden rounded-lg border transition-colors",
        active
          ? "border-foreground/25 bg-muted/70"
          : "border-border/60 bg-background hover:border-border hover:bg-muted/35"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-3 p-3 text-left"
      >
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-[13px] leading-snug font-semibold text-foreground">
            {item.title}
          </h3>
          <p className="mt-1 truncate text-[11.5px] text-muted-foreground">
            {item.conversationTitle ?? "Untitled conversation"}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{item.identifier}</span>
          <span className="shrink-0 tabular-nums">
            v{item.version} - {formatDate(item.createdAt)}
          </span>
        </div>
      </button>
      {item.deletable && (
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label={`Delete saved map ${item.title}`}
          title="Delete saved map"
          className="flex w-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground opacity-70 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive disabled:cursor-wait disabled:opacity-45"
        >
          {deleting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </button>
      )}
    </div>
  )
}
