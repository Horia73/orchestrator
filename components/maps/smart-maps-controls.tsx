"use client"

import * as React from "react"
import {
  Bike,
  BookmarkPlus,
  Building2,
  ChevronDown,
  Check,
  Copy,
  Layers2,
  Loader2,
  MapPinned,
  Move3D,
  Orbit,
  PanelRightOpen,
  Pencil,
  Route,
  Save,
  Search,
  TrafficCone,
  TrainFront,
  Trash2,
  Undo2,
  X,
} from "lucide-react"

import type {
  MapAreaSelection,
  MapRuntimeBasemap,
  MapRuntimeSettings,
} from "@/components/artifacts/renderers/map-renderer"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  BASEMAP_OPTIONS,
  activate3DMapSettings,
  deactivate3DMapSettings,
  formatAreaSelectionLabel,
  type SmartMapSearchResult,
  type SmartMapSearchSuggestion,
} from "@/components/maps/smart-maps-model"
import { cn } from "@/lib/utils"

export function SmartMapTopControls({
  mapSettings,
  searchText,
  searchResults,
  searchSuggestions,
  searchOpen,
  searchLoading,
  suggestionsLoading,
  searchError,
  savedPlacesVisible,
  savedPlacesCount,
  savedAreasVisible,
  savedAreasCount,
  areaSaveLoading,
  areaSaveError,
  areaCopyState,
  selectedAreaSavedId,
  sidePanelOpen,
  reserveDetailSidebar,
  compactChrome = false,
  areaDrawing,
  areaSelection,
  earth3dAvailable,
  showPhoneViewControls,
  onMapSettingsChange,
  onSavedPlacesVisibleChange,
  onSavedAreasVisibleChange,
  onSearchTextChange,
  onSearchSubmit,
  onSearchFocus,
  onSearchClose,
  onClearSearch,
  onSelectSearchResult,
  onSelectSearchSuggestion,
  onStartAreaDraw,
  onCancelAreaDraw,
  onClearAreaSelection,
  onUndoAreaPoint,
  onFinishAreaDraw,
  onSaveAreaSelection,
  onCopyAreaGeoJson,
  onDraftAreaResearch,
  onOpenSidePanel,
  onOrbitEarthAroundCenter,
  is3dOrbiting = false,
}: {
  mapSettings: MapRuntimeSettings
  searchText: string
  searchResults: SmartMapSearchResult[]
  searchSuggestions: SmartMapSearchSuggestion[]
  searchOpen: boolean
  searchLoading: boolean
  suggestionsLoading: boolean
  searchError: string | null
  savedPlacesVisible: boolean
  savedPlacesCount: number
  savedAreasVisible: boolean
  savedAreasCount: number
  areaSaveLoading: boolean
  areaSaveError: string | null
  areaCopyState: "idle" | "copied" | "error"
  selectedAreaSavedId: string | null
  sidePanelOpen: boolean
  reserveDetailSidebar: boolean
  compactChrome?: boolean
  areaDrawing: boolean
  areaSelection: MapAreaSelection | null
  earth3dAvailable: boolean
  showPhoneViewControls: boolean
  onMapSettingsChange: React.Dispatch<React.SetStateAction<MapRuntimeSettings>>
  onSavedPlacesVisibleChange: (visible: boolean) => void
  onSavedAreasVisibleChange: (visible: boolean) => void
  onSearchTextChange: (value: string) => void
  onSearchSubmit: (event?: React.FormEvent) => void
  onSearchFocus: () => void
  onSearchClose: () => void
  onClearSearch: () => void
  onSelectSearchResult: (
    result: SmartMapSearchResult,
    keepOpen?: boolean
  ) => void
  onSelectSearchSuggestion: (suggestion: SmartMapSearchSuggestion) => void
  onStartAreaDraw: () => void
  onCancelAreaDraw: () => void
  onClearAreaSelection: () => void
  onUndoAreaPoint: () => void
  onFinishAreaDraw: () => void
  onSaveAreaSelection: () => void
  onCopyAreaGeoJson: () => void
  onDraftAreaResearch: () => void
  onOpenSidePanel: () => void
  onOrbitEarthAroundCenter: () => void
  is3dOrbiting?: boolean
}) {
  const hasSearchPanel =
    searchOpen &&
    (searchLoading ||
      suggestionsLoading ||
      searchError ||
      searchResults.length > 0 ||
      searchSuggestions.length > 0)
  const setViewMode = React.useCallback(
    (mode: "2d" | "3d") => {
      onMapSettingsChange((current) =>
        mode === "3d"
          ? activate3DMapSettings(current)
          : deactivate3DMapSettings(current)
      )
    },
    [onMapSettingsChange]
  )
  // Earth3D (gmp-map-3d) always renders in HYBRID — City/Satellite/Terrain
  // and the traffic/transit/bicycling layers only modify the hidden 2D map,
  // so showing them in 3D is misleading. Hide both groups while in 3D.
  const is3d = mapSettings.earth3d && earth3dAvailable
  const showCompactOptions = showPhoneViewControls || compactChrome
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-[calc(0.75rem+env(safe-area-inset-top))] right-3 left-3 z-20 flex flex-col items-start gap-2 md:top-3 md:flex-row md:flex-wrap",
        reserveDetailSidebar && "xl:right-[calc(380px_+_1.5rem)]"
      )}
    >
      <div className="flex w-full min-w-0 items-start gap-2 md:min-w-[320px] md:flex-1">
        <SidebarTrigger className="pointer-events-auto size-10 rounded-full border border-border/70 bg-background/95 text-foreground/70 shadow-lg backdrop-blur hover:bg-muted hover:text-foreground md:hidden" />
        <div className="pointer-events-auto relative min-w-0 flex-1 md:max-w-[560px]">
          <form
            onSubmit={onSearchSubmit}
            className="flex h-11 min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 shadow-lg backdrop-blur"
          >
            <button
              type="submit"
              aria-label="Search Google Maps"
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Search className="size-4" />
            </button>
            <Input
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
              onFocus={onSearchFocus}
              onKeyDown={(event) => {
                if (event.key === "Escape") onSearchClose()
              }}
              aria-label="Search Google Maps"
              placeholder="Search Google Maps"
              className="h-9 border-0 bg-transparent px-0 text-[14px] shadow-none ring-0 placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0"
            />
            {searchLoading || suggestionsLoading ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : searchText ? (
              <button
                type="button"
                onClick={onClearSearch}
                aria-label="Clear map search"
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </form>

          {hasSearchPanel && (
            <div className="absolute top-[calc(100%_+_0.35rem)] right-0 left-0 max-h-[min(390px,calc(100dvh_-_88px))] overflow-y-auto rounded-xl border border-border/70 bg-background/95 p-1.5 shadow-xl backdrop-blur">
              {searchLoading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Searching...
                </div>
              ) : searchError ? (
                <div className="px-3 py-2 text-[13px] text-destructive">
                  {searchError}
                </div>
              ) : suggestionsLoading && searchResults.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Searching Google...
                </div>
              ) : searchResults.length > 0 ? (
                <ul className="space-y-1">
                  {searchResults.map((result) => (
                    <li key={result.id}>
                      <button
                        type="button"
                        onClick={() => onSelectSearchResult(result, false)}
                        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted"
                      >
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <MapPinned className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-foreground">
                            {result.title}
                          </span>
                          {result.address && (
                            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                              {result.address}
                            </span>
                          )}
                        </span>
                        {typeof result.rating === "number" && (
                          <span className="mt-1 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                            {result.rating.toFixed(1)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="space-y-1">
                  {searchSuggestions.map((suggestion) => (
                    <li key={suggestion.id}>
                      <button
                        type="button"
                        onClick={() => onSelectSearchSuggestion(suggestion)}
                        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted"
                      >
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                          {suggestion.kind === "place" ? (
                            <MapPinned className="size-4" />
                          ) : (
                            <Search className="size-4" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-foreground">
                            {suggestion.title}
                          </span>
                          {suggestion.subtitle && (
                            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                              {suggestion.subtitle}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(areaDrawing || areaSelection) && (
            <div className="mt-2 flex max-w-full flex-wrap items-start gap-2 rounded-lg border border-border/70 bg-background/95 px-2 py-2 text-[12px] text-foreground shadow-lg backdrop-blur sm:flex-nowrap">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                {areaDrawing ? (
                  <Pencil className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </span>
              <span className="min-w-[180px] flex-1">
                <span className="block font-semibold">
                  {areaDrawing
                    ? "Drawing area"
                    : formatAreaSelectionLabel(areaSelection)}
                </span>
                {areaDrawing && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    Click the map to add points. Drag blue points to edit; Undo
                    removes the last point.
                  </span>
                )}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {areaDrawing && (
                  <>
                    <button
                      type="button"
                      onClick={onUndoAreaPoint}
                      aria-label="Undo last area point"
                      title="Undo last area point"
                      className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Undo2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={onFinishAreaDraw}
                      className="flex h-7 items-center gap-1.5 rounded-full bg-foreground px-2.5 text-[11px] font-semibold text-background transition-opacity hover:opacity-90"
                    >
                      <Check className="size-3" />
                      Done
                    </button>
                  </>
                )}
                {!areaDrawing && areaSelection && (
                  <>
                    <button
                      type="button"
                      onClick={onSaveAreaSelection}
                      disabled={areaSaveLoading}
                      title={
                        selectedAreaSavedId ? "Update saved area" : "Save area"
                      }
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70"
                    >
                      {areaSaveLoading ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Save className="size-3" />
                      )}
                      {selectedAreaSavedId ? "Update" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={onCopyAreaGeoJson}
                      title="Copy area GeoJSON"
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
                    >
                      {areaCopyState === "copied" ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      {areaCopyState === "error" ? "Copy failed" : "GeoJSON"}
                    </button>
                    <button
                      type="button"
                      onClick={onDraftAreaResearch}
                      title="Open a new chat with this polygon as research context"
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-2.5 text-[11px] font-semibold text-background transition-opacity hover:opacity-90"
                    >
                      <Search className="size-3" />
                      Research
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={
                    areaDrawing ? onCancelAreaDraw : onClearAreaSelection
                  }
                  aria-label={
                    areaDrawing ? "Cancel area drawing" : "Clear area"
                  }
                  title={areaDrawing ? "Cancel area drawing" : "Clear area"}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {areaDrawing ? (
                    <X className="size-3.5" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              </span>
              {!areaDrawing && areaSelection && areaSaveError && (
                <span className="basis-full rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
                  {areaSaveError}
                </span>
              )}
            </div>
          )}
        </div>

        <div
          className={cn(
            "pointer-events-auto hidden flex-col items-end gap-2 md:flex",
            compactChrome && "md:hidden"
          )}
        >
          {!is3d && !compactChrome && (
            <MapBasemapSegmented
              mapSettings={mapSettings}
              onMapSettingsChange={onMapSettingsChange}
            />
          )}
          {is3d && <Earth3DGestureHint />}
        </div>
        <MapViewModeSegmented
          mapSettings={mapSettings}
          earth3dAvailable={earth3dAvailable}
          onViewModeChange={setViewMode}
          className={cn(
            "pointer-events-auto hidden md:flex",
            compactChrome && "md:hidden"
          )}
        />
        {is3d && (
          <button
            type="button"
            aria-pressed={is3dOrbiting}
            aria-label={is3dOrbiting ? "Stop orbit" : "Orbit around centre"}
            title={is3dOrbiting ? "Stop orbit" : "Orbit around centre"}
            onClick={onOrbitEarthAroundCenter}
            className={cn(
              "pointer-events-auto hidden size-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted md:flex",
              compactChrome && "md:hidden",
              is3dOrbiting &&
                "bg-foreground text-background hover:bg-foreground/90"
            )}
          >
            <Orbit className={cn("size-4", is3dOrbiting && "animate-spin")} />
          </button>
        )}
        <button
          type="button"
          aria-pressed={areaDrawing}
          aria-label={areaDrawing ? "Cancel area drawing" : "Draw area"}
          title={areaDrawing ? "Cancel area drawing" : "Draw area"}
          onClick={areaDrawing ? onCancelAreaDraw : onStartAreaDraw}
          className={cn(
            "pointer-events-auto hidden size-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted md:flex",
            compactChrome && "md:hidden",
            areaDrawing &&
              "bg-foreground text-background hover:bg-foreground/90"
          )}
        >
          <Pencil className="size-4" />
        </button>
      </div>

      <div
        className={cn(
          "pointer-events-auto flex w-full items-center justify-between gap-2 md:w-auto md:shrink-0 xl:hidden",
          compactChrome && "xl:flex"
        )}
      >
        <MapMobileOptionsMenu
          mapSettings={mapSettings}
          savedPlacesVisible={savedPlacesVisible}
          savedPlacesCount={savedPlacesCount}
          savedAreasVisible={savedAreasVisible}
          savedAreasCount={savedAreasCount}
          areaDrawing={areaDrawing}
          earth3dAvailable={earth3dAvailable}
          showBasemapControls={showCompactOptions}
          showViewControls={showCompactOptions}
          showDrawAction={showCompactOptions}
          onMapSettingsChange={onMapSettingsChange}
          onSavedPlacesVisibleChange={onSavedPlacesVisibleChange}
          onSavedAreasVisibleChange={onSavedAreasVisibleChange}
          onStartAreaDraw={onStartAreaDraw}
          onCancelAreaDraw={onCancelAreaDraw}
          onViewModeChange={setViewMode}
        />

        {!sidePanelOpen && (
          <button
            type="button"
            onClick={onOpenSidePanel}
            aria-label="Open map sidebar"
            aria-pressed={sidePanelOpen}
            title="Open map sidebar"
            className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
          >
            <PanelRightOpen className="size-4" />
          </button>
        )}
      </div>

      <div
        className={cn(
          "pointer-events-auto ml-auto hidden max-w-full flex-wrap justify-end gap-2 max-lg:ml-0 max-lg:justify-start xl:flex",
          compactChrome && "xl:hidden"
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-10 items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 text-[12px] font-semibold text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
            >
              <Layers2 className="size-4" />
              Layers
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Map overlays</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={savedPlacesVisible}
              disabled={savedPlacesCount === 0}
              onCheckedChange={(checked) =>
                onSavedPlacesVisibleChange(checked === true)
              }
            >
              <BookmarkPlus className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">Saved places</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {savedPlacesCount}
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={savedAreasVisible}
              disabled={savedAreasCount === 0}
              onCheckedChange={(checked) =>
                onSavedAreasVisibleChange(checked === true)
              }
            >
              <Pencil className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">Saved areas</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {savedAreasCount}
              </span>
            </DropdownMenuCheckboxItem>
            {/* Traffic / Transit / Bike / Labels only affect the hidden 2D
                map when Earth3D is active — Map3DElement renders HYBRID
                photorealistic tiles independent of these toggles. Hide them
                in 3D so the menu doesn't show controls that do nothing. */}
            {!is3d && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={mapSettings.traffic}
                  onCheckedChange={(checked) =>
                    onMapSettingsChange((current) => ({
                      ...current,
                      traffic: checked === true,
                    }))
                  }
                >
                  <TrafficCone className="size-4 text-muted-foreground" />
                  Traffic
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={mapSettings.transit}
                  onCheckedChange={(checked) =>
                    onMapSettingsChange((current) => ({
                      ...current,
                      transit: checked === true,
                    }))
                  }
                >
                  <TrainFront className="size-4 text-muted-foreground" />
                  Transit
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={mapSettings.bicycling}
                  onCheckedChange={(checked) =>
                    onMapSettingsChange((current) => ({
                      ...current,
                      bicycling: checked === true,
                    }))
                  }
                >
                  <Bike className="size-4 text-muted-foreground" />
                  Bike lanes
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={mapSettings.satelliteLabels}
                  disabled={mapSettings.basemap !== "satellite"}
                  onCheckedChange={(checked) =>
                    onMapSettingsChange((current) => ({
                      ...current,
                      satelliteLabels: checked === true,
                    }))
                  }
                >
                  <Route className="size-4 text-muted-foreground" />
                  Labels and roads
                </DropdownMenuCheckboxItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {!sidePanelOpen && (
          <button
            type="button"
            onClick={onOpenSidePanel}
            aria-label="Open map sidebar"
            aria-pressed={sidePanelOpen}
            title="Open map sidebar"
            className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
          >
            <PanelRightOpen className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}

function MapBasemapSegmented({
  mapSettings,
  onMapSettingsChange,
  className,
}: {
  mapSettings: MapRuntimeSettings
  onMapSettingsChange: React.Dispatch<React.SetStateAction<MapRuntimeSettings>>
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex h-11 shrink-0 overflow-hidden rounded-full border border-border/70 bg-background/95 p-1 shadow-lg backdrop-blur",
        className
      )}
      aria-label="Map style"
    >
      {BASEMAP_OPTIONS.map(({ value, label, Icon }) => {
        const active = mapSettings.basemap === value
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onMapSettingsChange((current) => ({
                ...current,
                basemap: value,
              }))
            }
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors",
              active
                ? "bg-foreground text-background shadow-sm"
                : "text-foreground/75 hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="size-3.5" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function MapViewModeSegmented({
  mapSettings,
  earth3dAvailable,
  onViewModeChange,
  className,
}: {
  mapSettings: MapRuntimeSettings
  earth3dAvailable: boolean
  onViewModeChange: (mode: "2d" | "3d") => void
  className?: string
}) {
  const is3d = mapSettings.earth3d && earth3dAvailable

  return (
    <div
      className={cn(
        "flex h-11 shrink-0 overflow-hidden rounded-full border border-border/70 bg-background/95 p-1 shadow-lg backdrop-blur",
        className
      )}
      aria-label="Map view mode"
    >
      <button
        type="button"
        aria-pressed={!is3d}
        onClick={() => onViewModeChange("2d")}
        className={cn(
          "flex h-9 min-w-12 items-center justify-center rounded-full px-3 text-[12px] font-semibold transition-colors",
          !is3d
            ? "bg-foreground text-background shadow-sm"
            : "text-foreground/75 hover:bg-muted hover:text-foreground"
        )}
      >
        2D
      </button>
      {earth3dAvailable && (
        <button
          type="button"
          aria-pressed={is3d}
          title="3D map"
          onClick={() => onViewModeChange("3d")}
          className={cn(
            "flex h-9 min-w-12 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors",
            is3d
              ? "bg-foreground text-background shadow-sm"
              : "text-foreground/75 hover:bg-muted hover:text-foreground"
          )}
        >
          <Move3D className="size-3.5" />
          3D
        </button>
      )}
    </div>
  )
}

function Earth3DGestureHint() {
  return (
    <div className="w-[260px] max-w-[calc(100vw_-_1.5rem)] rounded-lg border border-border/70 bg-background/95 px-3 py-2 text-[12px] leading-snug font-medium text-foreground/75 shadow-lg backdrop-blur">
      Double-click sau pinch, apoi trage ca sa inclini si sa rotesti.
    </div>
  )
}

function MapMobileOptionsMenu({
  mapSettings,
  savedPlacesVisible,
  savedPlacesCount,
  savedAreasVisible,
  savedAreasCount,
  areaDrawing,
  earth3dAvailable,
  showBasemapControls,
  showViewControls,
  showDrawAction,
  onMapSettingsChange,
  onSavedPlacesVisibleChange,
  onSavedAreasVisibleChange,
  onStartAreaDraw,
  onCancelAreaDraw,
  onViewModeChange,
}: {
  mapSettings: MapRuntimeSettings
  savedPlacesVisible: boolean
  savedPlacesCount: number
  savedAreasVisible: boolean
  savedAreasCount: number
  areaDrawing: boolean
  earth3dAvailable: boolean
  showBasemapControls: boolean
  showViewControls: boolean
  showDrawAction: boolean
  onMapSettingsChange: React.Dispatch<React.SetStateAction<MapRuntimeSettings>>
  onSavedPlacesVisibleChange: (visible: boolean) => void
  onSavedAreasVisibleChange: (visible: boolean) => void
  onStartAreaDraw: () => void
  onCancelAreaDraw: () => void
  onViewModeChange: (mode: "2d" | "3d") => void
}) {
  const is3d = mapSettings.earth3d && earth3dAvailable

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Map tools"
          title="Map tools"
          className="flex h-10 items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 text-[12px] font-semibold text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted md:size-10 md:justify-center md:px-0 lg:w-auto lg:px-3"
        >
          <Layers2 className="size-4" />
          <span className="md:sr-only lg:not-sr-only">Tools</span>
          <ChevronDown className="size-3.5 text-muted-foreground md:hidden lg:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        {showBasemapControls && !is3d && (
          <>
            <DropdownMenuLabel>Map style</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mapSettings.basemap}
              onValueChange={(value) =>
                onMapSettingsChange((current) => ({
                  ...current,
                  basemap: value as MapRuntimeBasemap,
                }))
              }
            >
              {BASEMAP_OPTIONS.map(({ value, label, Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon className="size-4 text-muted-foreground" />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {showBasemapControls && is3d && (
          <div className="px-2 py-2 text-[12px] leading-snug text-muted-foreground">
            Double-click sau pinch, apoi trage ca sa inclini si sa rotesti.
          </div>
        )}

        {showViewControls && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={is3d ? "3d" : "2d"}
              onValueChange={(value) =>
                onViewModeChange(value === "3d" ? "3d" : "2d")
              }
            >
              <DropdownMenuRadioItem value="2d">
                <Building2 className="size-4 text-muted-foreground" />
                2D map
              </DropdownMenuRadioItem>
              {earth3dAvailable && (
                <DropdownMenuRadioItem value="3d">
                  <Move3D className="size-4 text-muted-foreground" />
                  3D map
                </DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
          </>
        )}

        {(showBasemapControls || showViewControls) && <DropdownMenuSeparator />}
        <DropdownMenuLabel>Overlays</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={savedPlacesVisible}
          disabled={savedPlacesCount === 0}
          onCheckedChange={(checked) =>
            onSavedPlacesVisibleChange(checked === true)
          }
        >
          <BookmarkPlus className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">Saved places</span>
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {savedPlacesCount}
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={savedAreasVisible}
          disabled={savedAreasCount === 0}
          onCheckedChange={(checked) =>
            onSavedAreasVisibleChange(checked === true)
          }
        >
          <Pencil className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">Saved areas</span>
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {savedAreasCount}
          </span>
        </DropdownMenuCheckboxItem>
        {!is3d && (
          <>
            <DropdownMenuCheckboxItem
              checked={mapSettings.traffic}
              onCheckedChange={(checked) =>
                onMapSettingsChange((current) => ({
                  ...current,
                  traffic: checked === true,
                }))
              }
            >
              <TrafficCone className="size-4 text-muted-foreground" />
              Traffic
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={mapSettings.transit}
              onCheckedChange={(checked) =>
                onMapSettingsChange((current) => ({
                  ...current,
                  transit: checked === true,
                }))
              }
            >
              <TrainFront className="size-4 text-muted-foreground" />
              Transit
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={mapSettings.bicycling}
              onCheckedChange={(checked) =>
                onMapSettingsChange((current) => ({
                  ...current,
                  bicycling: checked === true,
                }))
              }
            >
              <Bike className="size-4 text-muted-foreground" />
              Bike lanes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={mapSettings.satelliteLabels}
              disabled={mapSettings.basemap !== "satellite"}
              onCheckedChange={(checked) =>
                onMapSettingsChange((current) => ({
                  ...current,
                  satelliteLabels: checked === true,
                }))
              }
            >
              <Route className="size-4 text-muted-foreground" />
              Labels and roads
            </DropdownMenuCheckboxItem>
          </>
        )}

        {showDrawAction && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() =>
                areaDrawing ? onCancelAreaDraw() : onStartAreaDraw()
              }
            >
              <Pencil className="size-4 text-muted-foreground" />
              {areaDrawing ? "Cancel drawing" : "Draw area"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
