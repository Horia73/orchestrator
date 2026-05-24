"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, LocateFixed, PersonStanding } from "lucide-react"

import {
  MapRenderer,
  type MapActionCommand,
  type MapAreaSelection,
  type MapRuntimeSettings,
  type MapSearchTarget,
} from "@/components/artifacts/renderers/map-renderer"
import { MapChatPanel } from "@/components/maps/map-chat-panel"
import { MapLibraryDrawer } from "@/components/maps/map-library-drawer"
import { SmartMapsSetupState } from "@/components/maps/smart-maps-setup-state"
import { SmartMapTopControls } from "@/components/maps/smart-maps-controls"
import { useSidebar } from "@/components/ui/sidebar"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { type MapBBox, type MapRoute } from "@/lib/maps/schema"
import {
  DEFAULT_MAP_SETTINGS,
  MAPS_CONFIG_CHANGED_EVENT,
  MAPS_CONFIG_FETCH_TIMEOUT_MS,
  MAX_ROUTE_STOPS,
  areaSelectionToGeoJson,
  buildAreaResearchPrompt,
  buildHomeMapSource,
  buildSavedPlacesRouteArtifact,
  createSearchSessionToken,
  deactivate3DMapSettings,
  formatAreaSqKm,
  formatContextCoordinate,
  formatContextRing,
  geoErrorMessage,
  normalize,
  readStoredMapPreferences,
  routeDraftTitle,
  routeSummaryText,
  savedAreaToSelection,
  savedPlacesToOverlayPins,
  sourceWithSavedAreaOverlays,
  summarizeMapForPrompt,
  viewportCenterFromSource,
  writeStoredMapPreferences,
  type BrowserGeoState,
  type MapsConfigState,
  type MapsConfigSummary,
  type MapSidePanelMode,
  type SavedMapArea,
  type SavedMapPlace,
  type SavedPlacesRouteDraft,
  type ServerLocationState,
  type ServerMapLocation,
  type SmartMapActionRequest,
  type SmartMapItem,
  type SmartMapSearchResult,
  type SmartMapSearchSuggestion,
} from "@/components/maps/smart-maps-model"
import { optimizeStopOrder } from "@/lib/maps/route-optimizer"
import {
  artifactRowFromSmartMapOpenHandoff,
  clearSmartMapCameraSession,
  consumeSmartMapOpenHandoff,
} from "@/lib/maps/smart-map-open-handoff"
import type { UserMapLocation } from "@/lib/maps/user-location"
import { cn } from "@/lib/utils"

const MAP_SIDE_PANEL_TRANSITION_MS = 300
const RENDERER_SIDE_PANEL_FLOW_QUERY = "(min-width: 1280px)"
const WIDE_SIDE_PANEL_DOCK_QUERY = "(min-width: 1536px)"
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(query)
    const update = () => setMatches(mediaQuery.matches)
    update()
    mediaQuery.addEventListener("change", update)
    return () => mediaQuery.removeEventListener("change", update)
  }, [query])

  return matches
}

export function SmartMapsView({
  homeLocation,
  initialMapId,
}: {
  homeLocation: UserMapLocation
  initialMapId?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const {
    state: appSidebarState,
    isMobile,
    setOpen,
    setOpenMobile,
  } = useSidebar()
  const rendererSidePanelFlowViewport = useMediaQuery(
    RENDERER_SIDE_PANEL_FLOW_QUERY
  )
  const wideSidePanelDockViewport = useMediaQuery(WIDE_SIDE_PANEL_DOCK_QUERY)
  const requestedMapId = initialMapId ?? searchParams.get("map")

  const [mapsConfig, setMapsConfig] = React.useState<MapsConfigState>({
    status: "loading",
    config: null,
    error: null,
  })
  const [maps, setMaps] = React.useState<SmartMapItem[]>([])
  const [savedPlaces, setSavedPlaces] = React.useState<SavedMapPlace[]>([])
  const [savedAreas, setSavedAreas] = React.useState<SavedMapArea[]>([])
  const [routePlaceIds, setRoutePlaceIds] = React.useState<string[]>([])
  const [savedPlacesRouteDraft, setSavedPlacesRouteDraft] =
    React.useState<SavedPlacesRouteDraft | null>(null)
  const [savedPlacesRouteLoading, setSavedPlacesRouteLoading] =
    React.useState(false)
  const [savedPlacesRouteError, setSavedPlacesRouteError] = React.useState<
    string | null
  >(null)
  const [savedPlacesRouteSaveLoading, setSavedPlacesRouteSaveLoading] =
    React.useState(false)
  const [savedPlacesRouteSaveError, setSavedPlacesRouteSaveError] =
    React.useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = React.useState("")
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [chatOpen, setChatOpen] = React.useState(false)
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] =
    React.useState(true)
  const [savedPlacesVisible, setSavedPlacesVisible] = React.useState(true)
  const [savedAreasVisible, setSavedAreasVisible] = React.useState(true)
  const [mapPreferencesLoaded, setMapPreferencesLoaded] = React.useState(false)
  const [listLoading, setListLoading] = React.useState(true)
  const [listError, setListError] = React.useState<string | null>(null)
  const [mapDeletingId, setMapDeletingId] = React.useState<string | null>(null)
  const [mapDeleteError, setMapDeleteError] = React.useState<string | null>(
    null
  )
  const [savedPlacesLoading, setSavedPlacesLoading] = React.useState(true)
  const [savedPlacesError, setSavedPlacesError] = React.useState<string | null>(
    null
  )
  const [savedAreasLoading, setSavedAreasLoading] = React.useState(true)
  const [savedAreasError, setSavedAreasError] = React.useState<string | null>(
    null
  )
  const [selectedArtifact, setSelectedArtifact] =
    React.useState<ArtifactRow | null>(null)
  const [selectedLoading, setSelectedLoading] = React.useState(false)
  const [selectedError, setSelectedError] = React.useState<string | null>(null)
  const [mapSettings, setMapSettings] =
    React.useState<MapRuntimeSettings>(DEFAULT_MAP_SETTINGS)
  const [searchText, setSearchText] = React.useState("")
  const [searchResults, setSearchResults] = React.useState<
    SmartMapSearchResult[]
  >([])
  const [searchSuggestions, setSearchSuggestions] = React.useState<
    SmartMapSearchSuggestion[]
  >([])
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchLoading, setSearchLoading] = React.useState(false)
  const [suggestionsLoading, setSuggestionsLoading] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [searchTarget, setSearchTarget] =
    React.useState<MapSearchTarget | null>(null)
  const [mapAction, setMapAction] = React.useState<MapActionCommand | null>(
    null
  )
  const [areaDrawing, setAreaDrawing] = React.useState(false)
  const [areaSelection, setAreaSelection] =
    React.useState<MapAreaSelection | null>(null)
  const [selectedAreaSavedId, setSelectedAreaSavedId] = React.useState<
    string | null
  >(null)
  const [areaSaveLoading, setAreaSaveLoading] = React.useState(false)
  const [areaSaveError, setAreaSaveError] = React.useState<string | null>(null)
  const [areaCopyState, setAreaCopyState] = React.useState<
    "idle" | "copied" | "error"
  >("idle")
  const searchRequestRef = React.useRef(0)
  const autocompleteRequestRef = React.useRef(0)
  const autocompleteSessionRef = React.useRef<string | null>(null)
  const suppressAutocompleteTextRef = React.useRef<string | null>(null)
  const searchNonceRef = React.useRef(0)
  const actionNonceRef = React.useRef(0)
  const collapsedAppSidebarRef = React.useRef(false)
  const [browserGeo, setBrowserGeo] = React.useState<BrowserGeoState>({
    status: "idle",
  })
  const [geoRetry, setGeoRetry] = React.useState(0)
  const [serverLocation, setServerLocation] =
    React.useState<ServerLocationState>({
      status: "loading",
      location: null,
      error: null,
    })
  const [serverLocationRetry, setServerLocationRetry] = React.useState(0)
  const [streetViewVisible, setStreetViewVisible] = React.useState(false)
  const [is3dOrbiting, setIs3dOrbiting] = React.useState(false)
  const shouldUseBrowserGeolocation =
    serverLocation.status === "error" ||
    (serverLocation.status === "ready" &&
      serverLocation.location.source !== "home-assistant")

  useIsomorphicLayoutEffect(() => {
    if (collapsedAppSidebarRef.current) return
    collapsedAppSidebarRef.current = true
    if (isMobile) setOpenMobile(false)
    else setOpen(false)
  }, [isMobile, setOpen, setOpenMobile])

  const loadMapsConfig = React.useCallback(async () => {
    setMapsConfig((current) =>
      current.status === "ready"
        ? current
        : { status: "loading", config: null, error: null }
    )
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      MAPS_CONFIG_FETCH_TIMEOUT_MS
    )
    try {
      const res = await fetch("/api/integrations/maps/config", {
        cache: "no-store",
        signal: controller.signal,
      })
      const body = (await res.json().catch(() => ({}))) as {
        maps?: MapsConfigSummary
        error?: string
      }
      if (!res.ok || !body.maps) {
        throw new Error(
          body.error ?? `Failed to load Maps configuration (${res.status})`
        )
      }
      setMapsConfig({ status: "ready", config: body.maps, error: null })
    } catch (error) {
      setMapsConfig({
        status: "error",
        config: null,
        error:
          error instanceof DOMException && error.name === "AbortError"
            ? "Timed out while checking the local Maps configuration."
            : error instanceof Error
              ? error.message
              : "Failed to load Maps configuration.",
      })
    } finally {
      window.clearTimeout(timeout)
    }
  }, [])

  React.useEffect(() => {
    void loadMapsConfig()
    const refresh = () => void loadMapsConfig()
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    window.addEventListener(MAPS_CONFIG_CHANGED_EVENT, refresh)
    document.addEventListener("visibilitychange", refreshOnVisible)
    return () => {
      window.removeEventListener(MAPS_CONFIG_CHANGED_EVENT, refresh)
      document.removeEventListener("visibilitychange", refreshOnVisible)
    }
  }, [loadMapsConfig])

  React.useEffect(() => {
    const preferences = readStoredMapPreferences()
    const storedSettings = preferences?.mapSettings
    if (storedSettings) {
      setMapSettings((current) =>
        deactivate3DMapSettings({ ...current, ...storedSettings })
      )
    }
    if (typeof preferences?.savedPlacesVisible === "boolean") {
      setSavedPlacesVisible(preferences.savedPlacesVisible)
    }
    if (typeof preferences?.savedAreasVisible === "boolean") {
      setSavedAreasVisible(preferences.savedAreasVisible)
    }
    setMapPreferencesLoaded(true)
  }, [])

  React.useEffect(() => {
    if (!mapPreferencesLoaded) return
    writeStoredMapPreferences({
      mapSettings,
      savedPlacesVisible,
      savedAreasVisible,
    })
  }, [mapPreferencesLoaded, mapSettings, savedAreasVisible, savedPlacesVisible])

  const loadMaps = React.useCallback(async () => {
    setListLoading(true)
    setListError(null)
    setMapDeleteError(null)
    try {
      const res = await fetch("/api/maps/artifacts", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load maps (${res.status})`)
      const body = (await res.json()) as { maps?: SmartMapItem[] }
      setMaps(body.maps ?? [])
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load maps")
    } finally {
      setListLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadMaps()
  }, [loadMaps])

  const showMapArtifact = React.useCallback(
    (artifact: ArtifactRow) => {
      if (artifact.type !== "application/vnd.ant.map") return
      clearSmartMapCameraSession(artifact.id)
      setMapSettings((current) => deactivate3DMapSettings(current))
      setDrawerOpen(false)
      setSavedPlacesRouteDraft(null)
      void loadMaps()
      router.push(`/maps/${encodeURIComponent(artifact.id)}`)
    },
    [loadMaps, router]
  )

  React.useEffect(() => {
    if (!chatOpen) return
    const handler = (event: Event) => {
      const artifact = (event as CustomEvent<ArtifactRow>).detail
      if (!artifact) return
      showMapArtifact(artifact)
    }
    window.addEventListener("orch:artifact", handler)
    return () => window.removeEventListener("orch:artifact", handler)
  }, [chatOpen, showMapArtifact])

  const loadSavedPlaces = React.useCallback(async () => {
    setSavedPlacesLoading(true)
    setSavedPlacesError(null)
    try {
      const res = await fetch("/api/maps/saved-places", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load places (${res.status})`)
      const body = (await res.json()) as { places?: SavedMapPlace[] }
      setSavedPlaces(body.places ?? [])
    } catch (err) {
      setSavedPlacesError(
        err instanceof Error ? err.message : "Failed to load saved places"
      )
    } finally {
      setSavedPlacesLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadSavedPlaces()
    const handler = () => void loadSavedPlaces()
    window.addEventListener("orch:maps-saved-place-changed", handler)
    return () =>
      window.removeEventListener("orch:maps-saved-place-changed", handler)
  }, [loadSavedPlaces])

  const loadSavedAreas = React.useCallback(async () => {
    setSavedAreasLoading(true)
    setSavedAreasError(null)
    try {
      const res = await fetch("/api/maps/saved-areas", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load areas (${res.status})`)
      const body = (await res.json()) as { areas?: SavedMapArea[] }
      setSavedAreas(body.areas ?? [])
    } catch (err) {
      setSavedAreasError(
        err instanceof Error ? err.message : "Failed to load saved areas"
      )
    } finally {
      setSavedAreasLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadSavedAreas()
    const handler = () => void loadSavedAreas()
    window.addEventListener("orch:maps-saved-area-changed", handler)
    return () =>
      window.removeEventListener("orch:maps-saved-area-changed", handler)
  }, [loadSavedAreas])

  React.useEffect(() => {
    if (!shouldUseBrowserGeolocation) {
      setBrowserGeo({ status: "idle" })
      return
    }

    if (!("geolocation" in navigator)) {
      setBrowserGeo({
        status: "unavailable",
        message: "Browser geolocation is not available.",
      })
      return
    }

    setBrowserGeo({ status: "requesting" })
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setBrowserGeo({
          status: "watching",
          position: [position.coords.longitude, position.coords.latitude],
          accuracy: Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : null,
        })
      },
      (error) => {
        setBrowserGeo({
          status: error.code === error.PERMISSION_DENIED ? "denied" : "error",
          message: geoErrorMessage(error),
        })
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30_000,
        timeout: 15_000,
      }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [geoRetry, shouldUseBrowserGeolocation])

  React.useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setServerLocation({ status: "loading", location: null, error: null })

    fetch("/api/maps/current-location", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(`Failed to load current location (${res.status})`)
        return (await res.json()) as { location?: ServerMapLocation }
      })
      .then((body) => {
        if (cancelled) return
        if (!body.location)
          throw new Error("Current location response was empty.")
        setServerLocation({
          status: "ready",
          location: body.location,
          error: null,
        })
      })
      .catch((err) => {
        if (
          cancelled ||
          (err instanceof DOMException && err.name === "AbortError")
        )
          return
        setServerLocation({
          status: "error",
          location: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to load current location",
        })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [serverLocationRetry])

  React.useEffect(() => {
    if (!requestedMapId) {
      setSelectedArtifact(null)
      setSelectedError(null)
      setSelectedLoading(false)
      return
    }

    let cancelled = false
    const handoff = consumeSmartMapOpenHandoff(requestedMapId)
    clearSmartMapCameraSession(requestedMapId)
    setMapSettings((current) => deactivate3DMapSettings(current))
    setSelectedLoading(true)
    setSelectedError(null)
    setSelectedArtifact(
      handoff ? artifactRowFromSmartMapOpenHandoff(handoff) : null
    )
    fetch(`/api/artifacts/${encodeURIComponent(requestedMapId)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(
            res.status === 404
              ? "Map not found"
              : `Failed to load map (${res.status})`
          )
        return (await res.json()) as ArtifactRow
      })
      .then((row) => {
        if (cancelled) return
        if (row.type !== "application/vnd.ant.map") {
          throw new Error("This artifact is not a map.")
        }
        setSelectedArtifact(row)
      })
      .catch((err) => {
        if (!cancelled) {
          if (!handoff) setSelectedArtifact(null)
          setSelectedError(
            err instanceof Error ? err.message : "Failed to load map"
          )
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [requestedMapId])

  const filtered = React.useMemo(() => {
    const q = normalize(libraryQuery.trim())
    if (!q) return maps
    return maps.filter(
      (item) =>
        normalize(item.title).includes(q) ||
        normalize(item.identifier).includes(q) ||
        normalize(item.conversationTitle ?? "").includes(q)
    )
  }, [maps, libraryQuery])
  const filteredSavedPlaces = React.useMemo(() => {
    const q = normalize(libraryQuery.trim())
    if (!q) return savedPlaces
    return savedPlaces.filter(
      (place) =>
        normalize(place.title).includes(q) ||
        normalize(place.address ?? "").includes(q) ||
        normalize(place.description ?? "").includes(q)
    )
  }, [libraryQuery, savedPlaces])
  const filteredSavedAreas = React.useMemo(() => {
    const q = normalize(libraryQuery.trim())
    if (!q) return savedAreas
    return savedAreas.filter(
      (area) =>
        normalize(area.title).includes(q) ||
        normalize(area.description ?? "").includes(q) ||
        normalize(area.notes ?? "").includes(q)
    )
  }, [libraryQuery, savedAreas])
  const selectedRoutePlaces = React.useMemo(() => {
    const byId = new Map(savedPlaces.map((place) => [place.id, place]))
    return routePlaceIds
      .map((id) => byId.get(id))
      .filter((place): place is SavedMapPlace => Boolean(place))
  }, [routePlaceIds, savedPlaces])

  React.useEffect(() => {
    setRoutePlaceIds((current) => {
      const valid = new Set(savedPlaces.map((place) => place.id))
      const next = current.filter((id) => valid.has(id))
      return next.length === current.length ? current : next
    })
  }, [savedPlaces])

  const resolvedServerLocation =
    serverLocation.status === "ready" ? serverLocation.location : null
  const homeSource = React.useMemo(
    () => buildHomeMapSource(homeLocation, browserGeo, resolvedServerLocation),
    [browserGeo, homeLocation, resolvedServerLocation]
  )
  const baseActiveSource =
    savedPlacesRouteDraft?.source ?? selectedArtifact?.content ?? homeSource
  const activeSource = React.useMemo(
    () =>
      sourceWithSavedAreaOverlays(
        baseActiveSource,
        savedAreas,
        savedAreasVisible
      ),
    [baseActiveSource, savedAreas, savedAreasVisible]
  )
  const savedPlaceOverlayPins = React.useMemo(
    () =>
      savedPlacesVisible
        ? savedPlacesToOverlayPins(activeSource, savedPlaces)
        : [],
    [activeSource, savedPlaces, savedPlacesVisible]
  )
  const homeLabel =
    resolvedServerLocation?.source === "home-assistant"
      ? resolvedServerLocation.label
      : browserGeo.status === "watching"
        ? "Locatia curenta"
        : (resolvedServerLocation?.label ?? homeLocation.label)
  const activeTitle =
    savedPlacesRouteDraft?.title ??
    selectedArtifact?.title ??
    `Smart Maps - ${homeLabel}`
  const isHome = !selectedArtifact && !savedPlacesRouteDraft
  const searchCenter = React.useMemo(
    () =>
      viewportCenterFromSource(activeSource) ??
      resolvedServerLocation?.position ??
      homeLocation.position,
    [activeSource, homeLocation.position, resolvedServerLocation?.position]
  )

  const currentLocationPosition = React.useMemo<[number, number]>(() => {
    if (resolvedServerLocation?.source === "home-assistant") {
      return resolvedServerLocation.position
    }
    if (browserGeo.status === "watching") return browserGeo.position
    return resolvedServerLocation?.position ?? homeLocation.position
  }, [browserGeo, homeLocation.position, resolvedServerLocation])
  const buildMapChatPromptContext = React.useCallback(() => {
    const lines = [
      "Surface: Smart Maps.",
      "Maps doctrine/tools should be treated as active for this turn.",
      `Active map title: ${activeTitle}`,
      `Map state: ${isHome ? "home/current-location map" : "saved map artifact"}.`,
      `Current viewport/search center [lng,lat]: ${formatContextCoordinate(searchCenter)}.`,
      `Current location label: ${homeLabel}; position [lng,lat]: ${formatContextCoordinate(currentLocationPosition)}.`,
      `Visible overlays: saved places ${savedPlacesVisible ? "on" : "off"} (${savedPlaces.length}); saved areas ${savedAreasVisible ? "on" : "off"} (${savedAreas.length}).`,
    ]

    if (selectedArtifact) {
      lines.push(
        `Selected artifact id: ${selectedArtifact.id}; identifier: ${selectedArtifact.identifier}; version: ${selectedArtifact.version}.`
      )
    }
    if (savedPlacesRouteDraft) {
      lines.push(`Route draft: ${savedPlacesRouteDraft.summary}`)
      if (savedPlacesRouteDraft.warning) {
        lines.push(`Route warning: ${savedPlacesRouteDraft.warning}`)
      }
    }
    if (routePlaceIds.length > 0) {
      lines.push(`Selected saved places for route: ${routePlaceIds.length}.`)
    }

    lines.push(...summarizeMapForPrompt(activeSource))

    if (savedPlaceOverlayPins.length > 0) {
      lines.push(
        "Saved place overlays currently visible:",
        ...savedPlaceOverlayPins.slice(0, 24).map((pin) => {
          const label = pin.label ?? "Saved place"
          const address = pin.address ? `; address: ${pin.address}` : ""
          return `- ${label}: ${formatContextCoordinate(pin.position)}${address}`
        })
      )
      if (savedPlaceOverlayPins.length > 24) {
        lines.push(
          `- ${savedPlaceOverlayPins.length - 24} additional saved places omitted.`
        )
      }
    }

    if (areaSelection) {
      lines.push(
        "Selected area:",
        `- ring [lng,lat]: ${formatContextRing(areaSelection.ring)}`,
        `- bbox [west,south,east,north]: ${JSON.stringify(areaSelection.bbox.map((value) => Number(value.toFixed(6))))}`,
        `- center [lng,lat]: ${formatContextCoordinate(areaSelection.center)}`,
        `- area: ${
          typeof areaSelection.areaSqKm === "number"
            ? formatAreaSqKm(areaSelection.areaSqKm)
            : "unknown"
        }`
      )
    }

    if (searchText.trim()) {
      lines.push(`Current map search text: ${searchText.trim()}`)
    }

    return lines.join("\n")
  }, [
    activeSource,
    activeTitle,
    areaSelection,
    currentLocationPosition,
    homeLabel,
    isHome,
    routePlaceIds.length,
    savedAreas.length,
    savedAreasVisible,
    savedPlaceOverlayPins,
    savedPlaces.length,
    savedPlacesRouteDraft,
    savedPlacesVisible,
    searchCenter,
    searchText,
    selectedArtifact,
  ])

  const toggleRoutePlace = React.useCallback((id: string) => {
    setSavedPlacesRouteError(null)
    setRoutePlaceIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id)
      if (current.length >= MAX_ROUTE_STOPS) return current
      return [...current, id]
    })
  }, [])

  const clearRoutePlaces = React.useCallback(() => {
    setRoutePlaceIds([])
    setSavedPlacesRouteDraft(null)
    setSavedPlacesRouteError(null)
    setSavedPlacesRouteSaveError(null)
  }, [])

  const buildSavedPlacesRoute = React.useCallback(async () => {
    if (selectedRoutePlaces.length === 0) {
      setSavedPlacesRouteError("Select at least one saved place.")
      return
    }

    setSavedPlacesRouteLoading(true)
    setSavedPlacesRouteError(null)
    setSavedPlacesRouteSaveError(null)
    try {
      const optimized = optimizeStopOrder(
        selectedRoutePlaces.map((place) => ({
          id: place.id,
          label: place.title,
          position: place.position,
        })),
        {
          start: currentLocationPosition,
          startLabel: homeLabel,
        }
      )
      const orderedPlaces = optimized.orderedStops
        .map((stop) => selectedRoutePlaces[stop.originalIndex])
        .filter((place): place is SavedMapPlace => Boolean(place))
      const fallbackRoute: MapRoute = {
        id: "saved-places-route-approx",
        coordinates: optimized.waypointPositions,
        color: "#f97316",
        width: 5,
        label: `Approx. ${optimized.distanceTextApprox}`,
      }
      let route = fallbackRoute
      let fitBounds = optimized.fitBounds
      let warning: string | null = null
      let summary = `Approx. ${optimized.distanceTextApprox}`
      const routeWaypoints = [
        { position: currentLocationPosition },
        ...orderedPlaces.map((place) => ({
          position: place.position,
          placeId: place.placeId ?? undefined,
        })),
      ]

      try {
        const response = await fetch("/api/maps/directions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            waypoints: routeWaypoints,
            travelMode: "driving",
            languageCode:
              typeof navigator !== "undefined" ? navigator.language : undefined,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as {
          route?: MapRoute
          fitBounds?: MapBBox | null
          distanceMeters?: number | null
          durationText?: string | null
          error?: string
        }
        if (!response.ok || !body.route) {
          throw new Error(
            body.error ?? `Directions failed (${response.status})`
          )
        }
        route = {
          ...body.route,
          id: "saved-places-route",
          color: "#0891b2",
          width: 6,
          label: routeSummaryText(
            body.durationText,
            body.distanceMeters,
            optimized.distanceTextApprox
          ),
        }
        fitBounds = body.fitBounds ?? optimized.fitBounds
        summary = route.label ?? summary
      } catch (error) {
        warning = `Google Routes unavailable; showing approximate straight-line route. ${
          error instanceof Error ? error.message : "Directions failed."
        }`
      }

      const title = routeDraftTitle(orderedPlaces)
      const artifact = buildSavedPlacesRouteArtifact({
        start: currentLocationPosition,
        startLabel: homeLabel,
        places: orderedPlaces,
        route,
        fitBounds,
        warning,
      })
      setSelectedArtifact(null)
      setMapSettings((current) => deactivate3DMapSettings(current))
      setSavedPlacesRouteDraft({
        key: `saved-route-${Date.now()}`,
        title,
        source: JSON.stringify(artifact),
        summary,
        warning,
        savedMapId: null,
      })
      setDrawerOpen(false)
      if (
        typeof window !== "undefined" &&
        window.location.pathname !== "/maps"
      ) {
        window.history.replaceState(null, "", "/maps")
      }
    } catch (error) {
      setSavedPlacesRouteError(
        error instanceof Error ? error.message : "Failed to build route."
      )
    } finally {
      setSavedPlacesRouteLoading(false)
    }
  }, [currentLocationPosition, homeLabel, selectedRoutePlaces])

  const saveCurrentRouteMap = React.useCallback(async () => {
    if (!savedPlacesRouteDraft || savedPlacesRouteDraft.savedMapId) return
    setSavedPlacesRouteSaveLoading(true)
    setSavedPlacesRouteSaveError(null)
    try {
      const response = await fetch("/api/maps/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: savedPlacesRouteDraft.title,
          content: savedPlacesRouteDraft.source,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        map?: SmartMapItem
        error?: string
      }
      if (!response.ok || !body.map) {
        throw new Error(body.error ?? `Save failed (${response.status})`)
      }
      setMaps((current) => [
        body.map!,
        ...current.filter((item) => item.id !== body.map!.id),
      ])
      setSavedPlacesRouteDraft((current) =>
        current
          ? {
              ...current,
              savedMapId: body.map!.id,
            }
          : current
      )
      await loadMaps()
    } catch (error) {
      setSavedPlacesRouteSaveError(
        error instanceof Error ? error.message : "Failed to save map."
      )
    } finally {
      setSavedPlacesRouteSaveLoading(false)
    }
  }, [loadMaps, savedPlacesRouteDraft])

  const selectMap = React.useCallback(
    (id: string) => {
      setSavedPlacesRouteDraft(null)
      setSavedPlacesRouteError(null)
      setSavedPlacesRouteSaveError(null)
      setDrawerOpen(false)
      clearSmartMapCameraSession(id)
      router.replace(`/maps/${encodeURIComponent(id)}`, { scroll: false })
    },
    [router]
  )

  const deleteSavedMap = React.useCallback(
    async (item: SmartMapItem) => {
      if (!item.deletable || mapDeletingId) return
      const confirmed = window.confirm(
        `Delete "${item.title}" from Smart Maps?`
      )
      if (!confirmed) return

      const previousMaps = maps
      setMapDeletingId(item.id)
      setMapDeleteError(null)
      setMaps((current) => current.filter((map) => map.id !== item.id))

      const wasActive = selectedArtifact?.id === item.id
      if (wasActive) {
        setSelectedArtifact(null)
        setSelectedError(null)
        router.replace("/maps", { scroll: false })
      }

      setSavedPlacesRouteDraft((current) =>
        current?.savedMapId === item.id
          ? {
              ...current,
              savedMapId: null,
            }
          : current
      )

      try {
        const response = await fetch(
          `/api/maps/artifacts/${encodeURIComponent(item.id)}`,
          { method: "DELETE" }
        )
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `Delete failed (${response.status})`)
        }
      } catch (error) {
        setMaps(previousMaps)
        setMapDeleteError(
          error instanceof Error ? error.message : "Failed to delete map."
        )
        if (wasActive)
          router.replace(`/maps/${encodeURIComponent(item.id)}`, {
            scroll: false,
          })
      } finally {
        setMapDeletingId((current) => (current === item.id ? null : current))
      }
    },
    [mapDeletingId, maps, router, selectedArtifact?.id]
  )

  const issueMapAction = React.useCallback((command: SmartMapActionRequest) => {
    const nonce = actionNonceRef.current + 1
    actionNonceRef.current = nonce
    setMapAction({ ...command, nonce } as MapActionCommand)
  }, [])

  const selectSavedPlace = React.useCallback((place: SavedMapPlace) => {
    const nonce = searchNonceRef.current + 1
    searchNonceRef.current = nonce
    setDrawerOpen(false)
    setSearchOpen(false)
    setSearchText(place.title)
    setSearchResults([])
    setSearchSuggestions([])
    setSearchError(null)
    setSearchTarget({
      id: place.placeId ?? place.id,
      nonce,
      position: place.position,
      label: place.title,
      address: place.address,
      rating: place.rating,
      userRatingCount: place.userRatingCount,
      photoUrl: place.photoUrl,
      googleMapsUri: place.googleMapsUri,
      websiteUri: place.websiteUri,
      sourceUrl: place.sourceUrl,
      savedPlaceId: place.id,
      description: place.description,
      notes: place.notes,
      openNow: place.openNow,
      phoneNumber: place.phoneNumber,
      provider: place.placeId ? "google-places" : "google-geocoding",
      placeId: place.placeId,
    })
  }, [])

  const selectSavedArea = React.useCallback(
    (area: SavedMapArea) => {
      const selection = savedAreaToSelection(area)
      setDrawerOpen(false)
      setAreaDrawing(false)
      setAreaSelection(selection)
      setSelectedAreaSavedId(area.id)
      setAreaSaveError(null)
      setAreaCopyState("idle")
      setSavedAreasVisible(true)
      issueMapAction({ type: "set-area-selection", selection })
    },
    [issueMapAction]
  )

  const deleteSavedPlace = React.useCallback(
    async (id: string) => {
      const previous = savedPlaces
      setSavedPlaces((current) => current.filter((place) => place.id !== id))
      try {
        const res = await fetch(
          `/api/maps/saved-places/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
          }
        )
        if (!res.ok) throw new Error(`Failed to delete place (${res.status})`)
      } catch (err) {
        setSavedPlaces(previous)
        setSavedPlacesError(
          err instanceof Error ? err.message : "Failed to delete saved place"
        )
      }
    },
    [savedPlaces]
  )

  const deleteSavedArea = React.useCallback(
    async (id: string) => {
      const previous = savedAreas
      setSavedAreas((current) => current.filter((area) => area.id !== id))
      if (selectedAreaSavedId === id) {
        setSelectedAreaSavedId(null)
        setAreaSelection(null)
        issueMapAction({ type: "clear-area-selection" })
      }
      try {
        const res = await fetch(
          `/api/maps/saved-areas/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        )
        if (!res.ok) throw new Error(`Failed to delete area (${res.status})`)
      } catch (err) {
        setSavedAreas(previous)
        setSavedAreasError(
          err instanceof Error ? err.message : "Failed to delete saved area"
        )
      }
    },
    [issueMapAction, savedAreas, selectedAreaSavedId]
  )

  const refreshLocation = React.useCallback(() => {
    setGeoRetry((value) => value + 1)
    setServerLocationRetry((value) => value + 1)
  }, [])

  const clearMapSearchAction = React.useCallback(() => {
    issueMapAction({ type: "clear-search" })
  }, [issueMapAction])

  const openSidePanelMode = React.useCallback((mode: MapSidePanelMode) => {
    setDrawerOpen(mode === "map")
    setChatOpen(mode === "chat")
    setDetailSidebarCollapsed(mode !== "places")
  }, [])

  const collapseSidePanel = React.useCallback(() => {
    setDrawerOpen(false)
    setChatOpen(false)
    setDetailSidebarCollapsed(true)
  }, [])

  const toggleStreetView = React.useCallback(() => {
    issueMapAction({ type: "toggle-street-view" })
  }, [issueMapAction])

  const orbitEarthAroundCenter = React.useCallback(() => {
    issueMapAction({ type: "orbit-around-center" })
  }, [issueMapAction])

  const startAreaDraw = React.useCallback(() => {
    setAreaDrawing(true)
    setAreaSelection(null)
    setSelectedAreaSavedId(null)
    setAreaSaveError(null)
    setAreaCopyState("idle")
    issueMapAction({ type: "start-area-draw" })
  }, [issueMapAction])

  const cancelAreaDraw = React.useCallback(() => {
    setAreaDrawing(false)
    issueMapAction({ type: "cancel-area-draw" })
  }, [issueMapAction])

  const clearAreaSelection = React.useCallback(() => {
    setAreaDrawing(false)
    setAreaSelection(null)
    setSelectedAreaSavedId(null)
    setAreaSaveError(null)
    setAreaCopyState("idle")
    issueMapAction({ type: "clear-area-selection" })
  }, [issueMapAction])

  const undoAreaPoint = React.useCallback(() => {
    issueMapAction({ type: "undo-area-point" })
  }, [issueMapAction])

  const finishAreaDraw = React.useCallback(() => {
    issueMapAction({ type: "finish-area-draw" })
  }, [issueMapAction])

  const handleAreaSelected = React.useCallback(
    (selection: MapAreaSelection) => {
      setAreaDrawing(false)
      setAreaSelection(selection)
    },
    []
  )

  const handleAreaDrawingCancelled = React.useCallback(
    (clearSelection: boolean) => {
      setAreaDrawing(false)
      if (clearSelection) setAreaSelection(null)
    },
    []
  )

  const draftAreaResearch = React.useCallback(() => {
    if (!areaSelection) return
    const prompt = buildAreaResearchPrompt(areaSelection, activeTitle)
    try {
      window.localStorage.setItem("chat:draft:new", prompt)
      window.localStorage.removeItem("chat:active-id")
    } catch {
      // The draft handoff is best-effort; navigation still lands in a new chat.
    }
    window.location.assign("/?new=1")
  }, [activeTitle, areaSelection])

  const saveAreaSelection = React.useCallback(async () => {
    if (!areaSelection) return
    setAreaSaveLoading(true)
    setAreaSaveError(null)
    try {
      const existing = selectedAreaSavedId
        ? savedAreas.find((area) => area.id === selectedAreaSavedId)
        : null
      const title =
        existing?.title ??
        `Area ${new Date().toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })}`
      const endpoint = selectedAreaSavedId
        ? `/api/maps/saved-areas/${encodeURIComponent(selectedAreaSavedId)}`
        : "/api/maps/saved-areas"
      const res = await fetch(endpoint, {
        method: selectedAreaSavedId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: existing?.description ?? `Saved from ${activeTitle}`,
          ring: areaSelection.ring,
          color: existing?.color ?? "#1a73e8",
          notes: existing?.notes ?? null,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        area?: SavedMapArea
        error?: string
      }
      if (!res.ok || !body.area) {
        throw new Error(body.error ?? `Save failed (${res.status})`)
      }
      setSavedAreas((current) => {
        const exists = current.some((area) => area.id === body.area!.id)
        return exists
          ? current.map((area) =>
              area.id === body.area!.id ? body.area! : area
            )
          : [body.area!, ...current]
      })
      setSelectedAreaSavedId(body.area.id)
      setSavedAreasVisible(true)
      window.dispatchEvent(new Event("orch:maps-saved-area-changed"))
    } catch (err) {
      setAreaSaveError(
        err instanceof Error ? err.message : "Failed to save area"
      )
    } finally {
      setAreaSaveLoading(false)
    }
  }, [activeTitle, areaSelection, savedAreas, selectedAreaSavedId])

  const copyAreaGeoJson = React.useCallback(async () => {
    if (!areaSelection) return
    try {
      await navigator.clipboard.writeText(areaSelectionToGeoJson(areaSelection))
      setAreaCopyState("copied")
      window.setTimeout(() => setAreaCopyState("idle"), 1800)
    } catch {
      setAreaCopyState("error")
      window.setTimeout(() => setAreaCopyState("idle"), 1800)
    }
  }, [areaSelection])

  const handleStreetViewVisibleChange = React.useCallback(
    (visible: boolean) => {
      setStreetViewVisible(visible)
      if (visible) setDrawerOpen(false)
    },
    []
  )

  const handleOrbitStateChange = React.useCallback((active: boolean) => {
    setIs3dOrbiting(active)
  }, [])

  const focusSearchResult = React.useCallback(
    (result: SmartMapSearchResult, keepOpen = false) => {
      const nonce = searchNonceRef.current + 1
      searchNonceRef.current = nonce
      suppressAutocompleteTextRef.current = result.title
      setSearchText(result.title)
      setSearchSuggestions([])
      setSuggestionsLoading(false)
      setSearchOpen(keepOpen)
      setSearchTarget({
        id: result.id,
        nonce,
        position: result.position,
        label: result.title,
        address: result.address,
        rating: result.rating,
        photoUrl: result.photoUrl,
        googleMapsUri: result.googleMapsUri,
        provider: result.provider,
        placeId: result.provider === "google-places" ? result.id : null,
      })
    },
    []
  )

  React.useEffect(() => {
    const trimmed = searchText.trim()
    if (suppressAutocompleteTextRef.current === trimmed) {
      setSearchSuggestions([])
      setSuggestionsLoading(false)
      return
    }
    if (trimmed.length < 2) {
      setSearchSuggestions([])
      setSuggestionsLoading(false)
      return
    }

    if (!autocompleteSessionRef.current)
      autocompleteSessionRef.current = createSearchSessionToken()
    const requestId = autocompleteRequestRef.current + 1
    autocompleteRequestRef.current = requestId
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSuggestionsLoading(true)
      setSearchOpen(true)

      const params = new URLSearchParams({
        q: trimmed,
        center: `${searchCenter[0]},${searchCenter[1]}`,
        sessionToken:
          autocompleteSessionRef.current ?? createSearchSessionToken(),
      })
      const language = navigator.language
      if (language) params.set("language", language)

      fetch(`/api/maps/autocomplete?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as {
            suggestions?: SmartMapSearchSuggestion[]
          }
          if (!res.ok) throw new Error("Autocomplete failed")
          return body.suggestions ?? []
        })
        .then((suggestions) => {
          if (requestId !== autocompleteRequestRef.current) return
          setSearchSuggestions(suggestions)
          if (suggestions.length > 0) setSearchOpen(true)
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          if (requestId !== autocompleteRequestRef.current) return
          setSearchSuggestions([])
        })
        .finally(() => {
          if (requestId === autocompleteRequestRef.current)
            setSuggestionsLoading(false)
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [searchCenter, searchText])

  const runMapSearch = React.useCallback(
    async (
      query: string,
      options: { placeId?: string | null; sessionToken?: string | null } = {}
    ) => {
      const trimmed = query.trim()
      if (!trimmed) {
        setSearchOpen(false)
        setSearchError(null)
        return
      }

      const requestId = searchRequestRef.current + 1
      searchRequestRef.current = requestId
      setSearchLoading(true)
      setSuggestionsLoading(false)
      setSearchSuggestions([])
      setSearchError(null)
      setSearchOpen(true)

      try {
        const params = new URLSearchParams({ q: trimmed })
        params.set("center", `${searchCenter[0]},${searchCenter[1]}`)
        if (options.placeId) params.set("placeId", options.placeId)
        if (options.sessionToken)
          params.set("sessionToken", options.sessionToken)
        const language = navigator.language
        if (language) params.set("language", language)
        const res = await fetch(`/api/maps/search?${params.toString()}`, {
          cache: "no-store",
        })
        const body = (await res.json().catch(() => ({}))) as {
          results?: SmartMapSearchResult[]
          error?: string
        }
        if (requestId !== searchRequestRef.current) return
        if (!res.ok)
          throw new Error(body.error ?? `Search failed (${res.status})`)
        const results = body.results ?? []
        setSearchResults(results)
        if (results.length > 0) {
          focusSearchResult(results[0], results.length > 1)
        } else {
          setSearchError("No places found.")
          setSearchOpen(true)
        }
      } catch (err) {
        if (requestId !== searchRequestRef.current) return
        setSearchResults([])
        setSearchError(err instanceof Error ? err.message : "Search failed.")
        setSearchOpen(true)
      } finally {
        if (requestId === searchRequestRef.current) setSearchLoading(false)
      }
    },
    [focusSearchResult, searchCenter]
  )

  const submitMapSearch = React.useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault()
      const sessionToken = autocompleteSessionRef.current
      autocompleteSessionRef.current = null
      void runMapSearch(searchText, { sessionToken })
    },
    [runMapSearch, searchText]
  )

  const selectSearchSuggestion = React.useCallback(
    (suggestion: SmartMapSearchSuggestion) => {
      const sessionToken = autocompleteSessionRef.current
      autocompleteSessionRef.current = null
      suppressAutocompleteTextRef.current = suggestion.title
      setSearchText(suggestion.title)
      setSearchResults([])
      setSearchSuggestions([])
      setSearchError(null)
      setSearchOpen(true)
      void runMapSearch(suggestion.query, {
        placeId: suggestion.placeId,
        sessionToken,
      })
    },
    [runMapSearch]
  )

  const updateSearchText = React.useCallback((value: string) => {
    const trimmed = value.trim()
    suppressAutocompleteTextRef.current = null
    if (trimmed.length >= 2 && !autocompleteSessionRef.current) {
      autocompleteSessionRef.current = createSearchSessionToken()
    } else if (trimmed.length < 2) {
      autocompleteSessionRef.current = null
    }
    setSearchText(value)
    setSearchResults([])
    setSearchError(null)
  }, [])

  const clearSearch = React.useCallback(() => {
    autocompleteSessionRef.current = null
    suppressAutocompleteTextRef.current = null
    setSearchText("")
    setSearchResults([])
    setSearchSuggestions([])
    setSuggestionsLoading(false)
    setSearchError(null)
    setSearchOpen(false)
    setSearchTarget(null)
    clearMapSearchAction()
  }, [clearMapSearchAction])

  const sidePanelMode: MapSidePanelMode | null = drawerOpen
    ? "map"
    : chatOpen
      ? "chat"
      : detailSidebarCollapsed
        ? null
        : "places"
  const sidePanelOpen = sidePanelMode !== null
  const dockedSidePanelMode =
    sidePanelMode === "chat" || sidePanelMode === "map" ? sidePanelMode : null
  const [renderedDockedSidePanelMode, setRenderedDockedSidePanelMode] =
    React.useState<MapSidePanelMode | null>(dockedSidePanelMode)

  React.useEffect(() => {
    if (dockedSidePanelMode) {
      setRenderedDockedSidePanelMode(dockedSidePanelMode)
      return
    }
    if (sidePanelMode === "places") {
      if (renderedDockedSidePanelMode) setRenderedDockedSidePanelMode(null)
      return
    }
    if (!renderedDockedSidePanelMode) return

    const timer = window.setTimeout(
      () => setRenderedDockedSidePanelMode(null),
      MAP_SIDE_PANEL_TRANSITION_MS
    )
    return () => window.clearTimeout(timer)
  }, [dockedSidePanelMode, renderedDockedSidePanelMode, sidePanelMode])

  const visibleDockedSidePanelMode =
    sidePanelMode === "places"
      ? null
      : (dockedSidePanelMode ?? renderedDockedSidePanelMode)
  const shouldRenderDockedSidePanel = !isMobile && !streetViewVisible
  const desktopSidePanelExpanded =
    shouldRenderDockedSidePanel && sidePanelOpen
  const appSidebarExpanded = !isMobile && appSidebarState === "expanded"
  const rendererSidePanelInFlow =
    desktopSidePanelExpanded &&
    rendererSidePanelFlowViewport &&
    (!appSidebarExpanded || wideSidePanelDockViewport)
  const overlaySidePanelOpen =
    desktopSidePanelExpanded && !rendererSidePanelInFlow
  const shouldReserveMapChrome = desktopSidePanelExpanded

  if (mapsConfig.status === "loading") {
    return <SmartMapsSetupState status="loading" />
  }

  if (mapsConfig.status === "error") {
    return (
      <SmartMapsSetupState
        status="error"
        message={mapsConfig.error}
        onRetry={() => void loadMapsConfig()}
      />
    )
  }

  if (!mapsConfig.config.configured) {
    return <SmartMapsSetupState status="unconfigured" />
  }

  const renderMapLibraryDrawer = (docked: boolean) => (
    <MapLibraryDrawer
      docked={docked}
      maps={filtered}
      savedPlaces={filteredSavedPlaces}
      savedAreas={filteredSavedAreas}
      allCount={maps.length}
      savedPlacesCount={savedPlaces.length}
      savedAreasCount={savedAreas.length}
      query={libraryQuery}
      listLoading={listLoading}
      listError={listError}
      mapDeletingId={mapDeletingId}
      mapDeleteError={mapDeleteError}
      savedPlacesLoading={savedPlacesLoading}
      savedPlacesError={savedPlacesError}
      savedAreasLoading={savedAreasLoading}
      savedAreasError={savedAreasError}
      savedPlacesVisible={savedPlacesVisible}
      savedAreasVisible={savedAreasVisible}
      routePlaceIds={routePlaceIds}
      routeLoading={savedPlacesRouteLoading}
      routeError={savedPlacesRouteError}
      routeSaveLoading={savedPlacesRouteSaveLoading}
      routeSaveError={savedPlacesRouteSaveError}
      routeSummary={savedPlacesRouteDraft?.summary ?? null}
      routeWarning={savedPlacesRouteDraft?.warning ?? null}
      routeSavedMapId={savedPlacesRouteDraft?.savedMapId ?? null}
      activeMapId={selectedArtifact?.id ?? null}
      onSavedPlacesVisibleChange={setSavedPlacesVisible}
      onSavedAreasVisibleChange={setSavedAreasVisible}
      onToggleRoutePlace={toggleRoutePlace}
      onClearRoutePlaces={clearRoutePlaces}
      onBuildRoute={() => void buildSavedPlacesRoute()}
      onSaveRouteMap={() => void saveCurrentRouteMap()}
      onQueryChange={setLibraryQuery}
      onShowChat={() => openSidePanelMode("chat")}
      onShowPlaces={() => openSidePanelMode("places")}
      onClose={collapseSidePanel}
      onSelect={selectMap}
      onDeleteMap={(item) => void deleteSavedMap(item)}
      onSelectSavedPlace={selectSavedPlace}
      onDeleteSavedPlace={(id) => void deleteSavedPlace(id)}
      onSelectSavedArea={selectSavedArea}
      onDeleteSavedArea={(id) => void deleteSavedArea(id)}
    />
  )

  const renderMapChatPanel = (docked: boolean) => (
    <MapChatPanel
      open={
        docked
          ? visibleDockedSidePanelMode === "chat"
          : sidePanelMode === "chat"
      }
      mobile={!docked && isMobile}
      docked={docked}
      activeMapTitle={activeTitle}
      preferredConversationId={selectedArtifact?.conversationId ?? null}
      buildPromptContext={buildMapChatPromptContext}
      onShowPlaces={() => openSidePanelMode("places")}
      onShowMap={() => openSidePanelMode("map")}
      onCollapse={collapseSidePanel}
      onMapArtifact={showMapArtifact}
    />
  )

  const dockedSidePanelContent =
    shouldRenderDockedSidePanel && visibleDockedSidePanelMode === "map"
      ? renderMapLibraryDrawer(true)
      : shouldRenderDockedSidePanel && visibleDockedSidePanelMode === "chat"
        ? renderMapChatPanel(true)
        : null

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
      <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
        <MapRenderer
          source={activeSource}
          title={activeTitle}
          mode="panel"
          artifactId={selectedArtifact?.id}
          mapPage
          hideSidebar={false}
          assistantOpen={sidePanelMode === "chat"}
          sidebarCollapsed={sidePanelMode !== "places"}
          frameless
          className="h-full"
          mapSettings={mapSettings}
          searchTarget={searchTarget}
          overlayPins={savedPlaceOverlayPins}
          actionCommand={mapAction}
          cameraResetKey={
            savedPlacesRouteDraft?.key ?? selectedArtifact?.id ?? "home"
          }
          sidePanelOverride={dockedSidePanelContent}
          sidePanelOverrideOpen={dockedSidePanelMode !== null}
          sidePanelInFlow={rendererSidePanelInFlow}
          onAreaSelected={handleAreaSelected}
          onAreaDrawingCancelled={handleAreaDrawingCancelled}
          onStreetViewVisibleChange={handleStreetViewVisibleChange}
          onOpenAssistant={() => openSidePanelMode("chat")}
          onOpenMapLibrary={() => openSidePanelMode("map")}
          onSidebarCollapsedChange={(collapsed) => {
            if (collapsed) collapseSidePanel()
            else openSidePanelMode("places")
          }}
          onEarth3DUnavailable={() =>
            setMapSettings((current) => deactivate3DMapSettings(current))
          }
          onOrbitStateChange={handleOrbitStateChange}
        />

        {!streetViewVisible && (
          <SmartMapTopControls
            mapSettings={mapSettings}
            searchText={searchText}
            searchResults={searchResults}
            searchSuggestions={searchSuggestions}
            searchOpen={searchOpen}
            searchLoading={searchLoading}
            suggestionsLoading={suggestionsLoading}
            searchError={searchError}
            savedPlacesVisible={savedPlacesVisible}
            savedPlacesCount={savedPlaces.length}
            savedAreasVisible={savedAreasVisible}
            savedAreasCount={savedAreas.length}
            areaSaveLoading={areaSaveLoading}
            areaSaveError={areaSaveError}
            areaCopyState={areaCopyState}
            selectedAreaSavedId={selectedAreaSavedId}
            sidePanelOpen={sidePanelOpen}
            reserveDetailSidebar={shouldReserveMapChrome}
            compactChrome={overlaySidePanelOpen}
            areaDrawing={areaDrawing}
            areaSelection={areaSelection}
            earth3dAvailable
            showPhoneViewControls={isMobile}
            onMapSettingsChange={setMapSettings}
            onSavedPlacesVisibleChange={setSavedPlacesVisible}
            onSavedAreasVisibleChange={setSavedAreasVisible}
            onSearchTextChange={updateSearchText}
            onSearchSubmit={submitMapSearch}
            onSearchFocus={() => {
              if (
                searchResults.length > 0 ||
                searchSuggestions.length > 0 ||
                searchError
              )
                setSearchOpen(true)
            }}
            onSearchClose={() => setSearchOpen(false)}
            onClearSearch={clearSearch}
            onSelectSearchResult={focusSearchResult}
            onSelectSearchSuggestion={selectSearchSuggestion}
            onStartAreaDraw={startAreaDraw}
            onCancelAreaDraw={cancelAreaDraw}
            onClearAreaSelection={clearAreaSelection}
            onUndoAreaPoint={undoAreaPoint}
            onFinishAreaDraw={finishAreaDraw}
            onSaveAreaSelection={() => void saveAreaSelection()}
            onCopyAreaGeoJson={() => void copyAreaGeoJson()}
            onDraftAreaResearch={draftAreaResearch}
            onOpenSidePanel={() => {
              if (sidePanelOpen) collapseSidePanel()
              else openSidePanelMode("chat")
            }}
            onOrbitEarthAroundCenter={orbitEarthAroundCenter}
            is3dOrbiting={is3dOrbiting}
          />
        )}

        {streetViewVisible && (
          <button
            type="button"
            aria-label="Exit Street View"
            title="Exit Street View"
            onClick={toggleStreetView}
            className="absolute top-3 right-3 z-30 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
          >
            <PersonStanding className="size-4" />
          </button>
        )}

        {!streetViewVisible && (
          <button
            type="button"
            aria-label="Centreaza pe locatia mea"
            title="Centreaza pe locatia mea"
            onClick={() =>
              issueMapAction({
                type: "recenter",
                position: currentLocationPosition,
              })
            }
            className={cn(
              "absolute right-3 bottom-3 z-20 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted",
              shouldReserveMapChrome && "xl:right-[calc(380px_+_1.5rem)]"
            )}
          >
            <LocateFixed className="size-4" />
          </button>
        )}

        {!streetViewVisible && selectedError && (
          <div className="absolute bottom-3 left-3 z-20 max-w-sm rounded-lg border border-destructive/25 bg-background/95 px-3 py-2 text-[12px] text-destructive shadow-sm backdrop-blur">
            {selectedError}
          </div>
        )}

        {!streetViewVisible && selectedLoading && (
          <div className="absolute bottom-3 left-3 z-20 flex max-w-sm items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2 text-[12px] text-muted-foreground shadow-sm backdrop-blur">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            Loading map...
          </div>
        )}

        {!streetViewVisible &&
          isHome &&
          shouldUseBrowserGeolocation &&
          browserGeo.status !== "watching" && (
            <div className="absolute bottom-3 left-3 z-20 flex max-w-sm items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2 text-[12px] text-muted-foreground shadow-sm backdrop-blur">
              {browserGeo.status === "requesting" ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <LocateFixed className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {browserGeo.status === "requesting"
                  ? "Updating current location..."
                  : browserGeo.status === "idle"
                    ? "Current location is waiting..."
                    : browserGeo.message}
              </span>
              {browserGeo.status !== "requesting" &&
                browserGeo.status !== "idle" && (
                  <button
                    type="button"
                    onClick={refreshLocation}
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    Retry
                  </button>
                )}
            </div>
          )}

        {!streetViewVisible &&
          isMobile &&
          sidePanelMode === "map" &&
          renderMapLibraryDrawer(false)}

        {!streetViewVisible && isMobile && renderMapChatPanel(false)}
      </div>

    </div>
  )
}
