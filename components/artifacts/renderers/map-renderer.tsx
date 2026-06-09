"use client"

import * as React from "react"
import { ExternalLink, Maximize2, X } from "lucide-react"
import { useRouter } from "next/navigation"

import { cn } from "@/lib/utils"
import { writeSmartMapOpenHandoff } from "@/lib/maps/smart-map-open-handoff"
import {
  parseMapArtifact,
  type MapArtifact,
  type MapPin as MapPinType,
  type MapRoute,
  type MapCoordinate,
} from "@/lib/maps/schema"
import { MapIframe } from "@/components/artifacts/renderers/map/map-iframe"
import {
  ErrorCard,
  LoadingCard,
} from "@/components/artifacts/renderers/map/state-cards"
import {
  boundsForVisibleFeatures,
  collectOverlayPins,
  collectPins,
  collectPolygons,
  collectRoutes,
  dynamicPlaceKey,
  dynamicPlaceRowFromFallback,
  viewportForRows,
} from "@/components/artifacts/renderers/map/feature-model"
import {
  ChipsRow,
  DayTabs,
  FloatingPlaceSheet,
  RichSidebar,
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
} from "@/components/artifacts/renderers/map/place-ui"
import type {
  ActiveDirections,
  DirectionsApiResponse,
  DirectionsPoint,
  DirectionsRequest,
  DirectionsTravelMode,
  IframeMapArtifact,
  MapActionCommand,
  MapAreaSelection,
  MapIframeApi,
  MapRuntimeSettings,
  MapSearchTarget,
  PinRow,
  PlaceClickFallback,
  PlaceDetailsApiResponse,
} from "@/components/artifacts/renderers/map/types"
export type {
  MapActionCommand,
  MapAreaSelection,
  MapRuntimeBasemap,
  MapRuntimeSettings,
  MapSearchTarget,
} from "@/components/artifacts/renderers/map/types"

const EMPTY_PIN_ROWS: PinRow[] = []

// ---------------------------------------------------------------------------
// Map artifact renderer (rebuild) — Google Maps JavaScript API edition.
//
// The map itself lives inside a sandboxed iframe that loads Google Maps
// JS directly from Google's CDN. This is the same engine that powers
// maps.google.com — imagery quality, smooth animations, and behaviour
// match what users already know.
//
// Architecture:
//   - The iframe is a sandboxed island whose only job is rendering the
//     map and reporting back when a pin is clicked. It owns the markers.
//   - The parent React component owns the place detail sheet/sidebar so
//     the popup can match the app's design system. The two halves
//     communicate via postMessage:
//       parent → iframe: 'init', 'fly-to-pin', 'set-active-day'
//       iframe → parent: 'ready', 'pin-clicked', 'error'
//
// Security:
//   - The Google Maps key is fetched at mount from /api/maps/config and
//     injected into the srcdoc. Keys for Google Maps JS API are
//     designed to be public; security comes from HTTP-referrer
//     restrictions in the GCP Cloud Console (the runbook walks the
//     user through restricting to localhost + production domain).
//   - The iframe sandbox includes allow-same-origin because Google Maps JS
//     reads same-origin frame properties internally and fails inside an opaque
//     srcdoc origin. This is narrower than our generic HTML artifact sandbox:
//     the map iframe runs only this controlled runtime, never model-authored
//     JavaScript. Parent/iframe postMessage traffic is scoped to a per-render
//     channel token so unrelated same-origin frames cannot drive map actions.
// ---------------------------------------------------------------------------

const DRIVING_FINAL_WALK_THRESHOLD_METERS = 80
const DIRECTIONS_CONNECTOR_THRESHOLD_METERS = 18
const SELECTED_POINT_ID_RE = /^selected--?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/

function isSyntheticSelectedPlaceId(placeId: string): boolean {
  return SELECTED_POINT_ID_RE.test(placeId.trim())
}

function selectedPointFallback(position: MapCoordinate): PlaceClickFallback {
  const [lng, lat] = position
  const latText = lat.toFixed(6)
  const lngText = lng.toFixed(6)
  return {
    label: "Selected point",
    address: `${latText}, ${lngText}`,
    description: "Punct selectat pe harta",
  }
}

function firstRouteCoordinate(route: MapRoute): MapCoordinate | null {
  const coord = route.coordinates[0]
  return isMapCoordinate(coord) ? coord : null
}

function pointsAtSamePosition(a: DirectionsPoint, b: DirectionsPoint): boolean {
  if (!a.position || !b.position) return false
  return (
    Math.abs(a.position[0] - b.position[0]) < 1e-6 &&
    Math.abs(a.position[1] - b.position[1]) < 1e-6
  )
}

function buildDirectionsConnectorRoute({
  id,
  from,
  to,
  label,
}: {
  id: string
  from: MapCoordinate
  to: MapCoordinate
  label: string
}): MapRoute | null {
  const distance = distanceMetersBetween(from, to)
  if (distance < DIRECTIONS_CONNECTOR_THRESHOLD_METERS) return null
  return {
    id,
    coordinates: curvedConnectorCoordinates(from, to, distance),
    color: "#64748b",
    width: 4,
    style: "dashed",
    label,
  }
}

function curvedConnectorCoordinates(
  from: MapCoordinate,
  to: MapCoordinate,
  distanceMeters: number
): MapCoordinate[] {
  const midLat = ((from[1] + to[1]) / 2) * (Math.PI / 180)
  const metersPerLatDegree = 111_320
  const metersPerLngDegree = Math.max(1, Math.cos(midLat) * metersPerLatDegree)
  const x1 = from[0] * metersPerLngDegree
  const y1 = from[1] * metersPerLatDegree
  const x2 = to[0] * metersPerLngDegree
  const y2 = to[1] * metersPerLatDegree
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length <= 0) return [from, to]

  const arcMeters = Math.min(45, Math.max(7, distanceMeters * 0.18))
  const cx = (x1 + x2) / 2 + (-dy / length) * arcMeters
  const cy = (y1 + y2) / 2 + (dx / length) * arcMeters
  const out: MapCoordinate[] = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    const inv = 1 - t
    const x = inv * inv * x1 + 2 * inv * t * cx + t * t * x2
    const y = inv * inv * y1 + 2 * inv * t * cy + t * t * y2
    out.push([x / metersPerLngDegree, y / metersPerLatDegree])
  }
  return out
}

interface MapsConfig {
  configured: boolean
  key?: string
  mapId?: string
  error?: string
}

export function MapRenderer({
  source,
  title,
  mode = "inline",
  artifactId,
  mapPage = false,
  hideSidebar = false,
  frameless = false,
  className,
  mapSettings,
  searchTarget,
  overlayPins,
  actionCommand,
  cameraResetKey,
  sidePanelOverride,
  sidePanelOverrideOpen = false,
  sidePanelInFlow = true,
  assistantOpen = false,
  sidebarCollapsed = false,
  onOpenAssistant,
  onOpenMapLibrary,
  onSidebarCollapsedChange,
  onAreaSelected,
  onAreaDrawingCancelled,
  onStreetViewVisibleChange,
  onEarth3DUnavailable,
  onOrbitStateChange,
}: {
  source: string
  title: string
  mode?: "inline" | "panel"
  artifactId?: string
  mapPage?: boolean
  hideSidebar?: boolean
  frameless?: boolean
  className?: string
  mapSettings?: MapRuntimeSettings
  searchTarget?: MapSearchTarget | null
  overlayPins?: MapPinType[]
  actionCommand?: MapActionCommand | null
  cameraResetKey?: string
  sidePanelOverride?: React.ReactNode
  sidePanelOverrideOpen?: boolean
  sidePanelInFlow?: boolean
  assistantOpen?: boolean
  sidebarCollapsed?: boolean
  onOpenAssistant?: () => void
  onOpenMapLibrary?: () => void
  onSidebarCollapsedChange?: (collapsed: boolean) => void
  onAreaSelected?: (selection: MapAreaSelection) => void
  onAreaDrawingCancelled?: (clearSelection: boolean) => void
  onStreetViewVisibleChange?: (visible: boolean) => void
  onEarth3DUnavailable?: () => void
  onOrbitStateChange?: (active: boolean) => void
}) {
  const parsed = React.useMemo(() => parseMapArtifact(source), [source])

  // Maps config is fetched once per mount. The endpoint returns the
  // (referrer-restricted) API key + mapId, or 503 with an actionable
  // error string. We render the right state for each branch.
  const [config, setConfig] = React.useState<MapsConfig | null>(null)
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch("/api/maps/config")
        const body = (await resp.json().catch(() => ({}))) as MapsConfig
        if (!cancelled) setConfig(body)
      } catch {
        if (!cancelled) {
          setConfig({
            configured: false,
            error: "Failed to reach /api/maps/config.",
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!parsed.ok) {
    return (
      <ErrorCard
        className={className}
        title="Map artifact failed to parse"
        detail={parsed.error}
        frameless={frameless}
      />
    )
  }

  if (config === null) {
    return (
      <LoadingCard
        className={className}
        title={title}
        mode={mode}
        frameless={frameless}
      />
    )
  }

  if (!config.configured || !config.key) {
    return (
      <ErrorCard
        className={className}
        title="Maps backend is not configured"
        detail={
          config.error ??
          "Set GOOGLE_MAPS_API_KEY in your environment and restart the server."
        }
        frameless={frameless}
      />
    )
  }

  return (
    <MapArtifactShell
      artifact={parsed.value}
      title={title}
      apiKey={config.key}
      mapId={config.mapId ?? "DEMO_MAP_ID"}
      mode={mode}
      artifactId={artifactId}
      mapPage={mapPage}
      hideSidebar={hideSidebar}
      frameless={frameless}
      className={className}
      mapSettings={mapSettings}
      searchTarget={searchTarget}
      overlayPins={overlayPins}
      actionCommand={actionCommand}
      cameraResetKey={cameraResetKey}
      sidePanelOverride={sidePanelOverride}
      sidePanelOverrideOpen={sidePanelOverrideOpen}
      sidePanelInFlow={sidePanelInFlow}
      assistantOpen={assistantOpen}
      sidebarCollapsed={sidebarCollapsed}
      onOpenAssistant={onOpenAssistant}
      onOpenMapLibrary={onOpenMapLibrary}
      onSidebarCollapsedChange={onSidebarCollapsedChange}
      onAreaSelected={onAreaSelected}
      onAreaDrawingCancelled={onAreaDrawingCancelled}
      onStreetViewVisibleChange={onStreetViewVisibleChange}
      onEarth3DUnavailable={onEarth3DUnavailable}
      onOrbitStateChange={onOrbitStateChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Parent shell — owns layout, day-tab + sidebar state, and the postMessage
// bridge to the iframe. Sidebar + day tabs are rendered with the app's
// Tailwind / shadcn vocabulary so they match the surrounding chat UI.
// ---------------------------------------------------------------------------

function MapArtifactShell({
  artifact,
  title,
  apiKey,
  mapId,
  mode,
  artifactId,
  mapPage,
  hideSidebar,
  frameless,
  className,
  mapSettings,
  searchTarget,
  overlayPins,
  actionCommand,
  cameraResetKey,
  sidePanelOverride,
  sidePanelOverrideOpen,
  sidePanelInFlow,
  assistantOpen,
  sidebarCollapsed,
  onOpenAssistant,
  onOpenMapLibrary,
  onSidebarCollapsedChange,
  onAreaSelected,
  onAreaDrawingCancelled,
  onStreetViewVisibleChange,
  onEarth3DUnavailable,
  onOrbitStateChange,
}: {
  artifact: MapArtifact
  title: string
  apiKey: string
  mapId: string
  mode: "inline" | "panel"
  artifactId?: string
  mapPage: boolean
  hideSidebar: boolean
  frameless: boolean
  className?: string
  mapSettings?: MapRuntimeSettings
  searchTarget?: MapSearchTarget | null
  overlayPins?: MapPinType[]
  actionCommand?: MapActionCommand | null
  cameraResetKey?: string
  sidePanelOverride?: React.ReactNode
  sidePanelOverrideOpen: boolean
  sidePanelInFlow: boolean
  assistantOpen: boolean
  sidebarCollapsed: boolean
  onOpenAssistant?: () => void
  onOpenMapLibrary?: () => void
  onSidebarCollapsedChange?: (collapsed: boolean) => void
  onAreaSelected?: (selection: MapAreaSelection) => void
  onAreaDrawingCancelled?: (clearSelection: boolean) => void
  onStreetViewVisibleChange?: (visible: boolean) => void
  onEarth3DUnavailable?: () => void
  onOrbitStateChange?: (active: boolean) => void
}) {
  const router = useRouter()
  const [fullscreen, setFullscreen] = React.useState(false)
  const openMapPage = React.useCallback(() => {
    if (!artifactId) return false
    writeSmartMapOpenHandoff({
      id: artifactId,
      title,
      content: JSON.stringify(artifact),
      createdAt: Date.now(),
    })
    router.push(`/maps/${encodeURIComponent(artifactId)}`)
    return true
  }, [artifact, artifactId, router, title])

  const handleFullscreenToggle = React.useCallback(() => {
    if (!mapPage && openMapPage()) return
    setFullscreen(true)
  }, [mapPage, openMapPage])

  // Close fullscreen on Esc.
  React.useEffect(() => {
    if (!fullscreen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  return (
    <>
      <ShellBody
        artifact={artifact}
        title={title}
        apiKey={apiKey}
        mapId={mapId}
        mode={mode}
        className={className}
        fullscreen={false}
        mapPage={mapPage}
        hideSidebar={hideSidebar}
        frameless={frameless}
        fullscreenActionLabel={
          artifactId && !mapPage ? "Open map page" : "Open map in fullscreen"
        }
        onFullscreenToggle={handleFullscreenToggle}
        mapSettings={mapSettings}
        searchTarget={searchTarget}
        overlayPins={overlayPins}
        actionCommand={actionCommand}
        cameraResetKey={cameraResetKey}
        sidePanelOverride={sidePanelOverride}
        sidePanelOverrideOpen={sidePanelOverrideOpen}
        sidePanelInFlow={sidePanelInFlow}
        assistantOpen={assistantOpen}
        sidebarCollapsed={sidebarCollapsed}
        onOpenAssistant={onOpenAssistant}
        onOpenMapLibrary={onOpenMapLibrary}
        onSidebarCollapsedChange={onSidebarCollapsedChange}
        onAreaSelected={onAreaSelected}
        onAreaDrawingCancelled={onAreaDrawingCancelled}
        onStreetViewVisibleChange={onStreetViewVisibleChange}
        onEarth3DUnavailable={onEarth3DUnavailable}
        onOrbitStateChange={onOrbitStateChange}
      />
      {fullscreen && (
        <FullscreenOverlay onClose={() => setFullscreen(false)}>
          <ShellBody
            artifact={artifact}
            title={title}
            apiKey={apiKey}
            mapId={mapId}
            mode="panel"
            fullscreen
            mapPage={mapPage}
            hideSidebar={hideSidebar}
            frameless={false}
            onFullscreenToggle={() => setFullscreen(false)}
            mapSettings={mapSettings}
            searchTarget={searchTarget}
            overlayPins={overlayPins}
            actionCommand={actionCommand}
            cameraResetKey={cameraResetKey}
            sidePanelOverride={sidePanelOverride}
            sidePanelOverrideOpen={sidePanelOverrideOpen}
            sidePanelInFlow={sidePanelInFlow}
            assistantOpen={assistantOpen}
            sidebarCollapsed={sidebarCollapsed}
            onOpenAssistant={onOpenAssistant}
            onOpenMapLibrary={onOpenMapLibrary}
            onSidebarCollapsedChange={onSidebarCollapsedChange}
            onAreaSelected={onAreaSelected}
            onAreaDrawingCancelled={onAreaDrawingCancelled}
            onStreetViewVisibleChange={onStreetViewVisibleChange}
            onEarth3DUnavailable={onEarth3DUnavailable}
            onOrbitStateChange={onOrbitStateChange}
          />
        </FullscreenOverlay>
      )}
    </>
  )
}

function FullscreenOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Map fullscreen"
    >
      {/* Floating close button — sits over the map's top-right
                corner. Same visual idiom as the fullscreen-open button
                that lives in inline mode, just inverted. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close fullscreen"
        className="fixed top-5 right-5 z-[60] flex size-10 items-center justify-center rounded-full bg-background text-foreground shadow-lg ring-1 ring-border/60 backdrop-blur transition-colors hover:bg-muted"
      >
        <X className="size-5" />
      </button>
      <div className="flex h-full min-h-0 w-full">{children}</div>
    </div>
  )
}

/**
 * The actual shell content — wraps the iframe + (when in panel/fullscreen
 * mode) the rich sidebar. Inline mode is intentionally minimal: numbered
 * markers on the map, wrapping number chips below for quick navigation,
 * and a fullscreen button to escape to the panel view for more detail.
 */
function ShellBody({
  artifact,
  title,
  apiKey,
  mapId,
  mode,
  className,
  fullscreen,
  mapPage,
  hideSidebar,
  frameless,
  fullscreenActionLabel = "Open map in fullscreen",
  onFullscreenToggle,
  mapSettings,
  searchTarget,
  overlayPins,
  actionCommand,
  cameraResetKey,
  sidePanelOverride,
  sidePanelOverrideOpen,
  sidePanelInFlow,
  assistantOpen,
  sidebarCollapsed,
  onOpenAssistant,
  onOpenMapLibrary,
  onSidebarCollapsedChange,
  onAreaSelected,
  onAreaDrawingCancelled,
  onStreetViewVisibleChange,
  onEarth3DUnavailable,
  onOrbitStateChange,
}: {
  artifact: MapArtifact
  title: string
  apiKey: string
  mapId: string
  mode: "inline" | "panel"
  className?: string
  fullscreen: boolean
  mapPage: boolean
  hideSidebar: boolean
  frameless: boolean
  fullscreenActionLabel?: string
  onFullscreenToggle: () => void
  mapSettings?: MapRuntimeSettings
  searchTarget?: MapSearchTarget | null
  overlayPins?: MapPinType[]
  actionCommand?: MapActionCommand | null
  cameraResetKey?: string
  sidePanelOverride?: React.ReactNode
  sidePanelOverrideOpen: boolean
  sidePanelInFlow: boolean
  assistantOpen: boolean
  sidebarCollapsed: boolean
  onOpenAssistant?: () => void
  onOpenMapLibrary?: () => void
  onSidebarCollapsedChange?: (collapsed: boolean) => void
  onAreaSelected?: (selection: MapAreaSelection) => void
  onAreaDrawingCancelled?: (clearSelection: boolean) => void
  onStreetViewVisibleChange?: (visible: boolean) => void
  onEarth3DUnavailable?: () => void
  onOrbitStateChange?: (active: boolean) => void
}) {
  const days = artifact.days ?? []
  const hasDays = days.length > 0

  const [activeDay, setActiveDay] = React.useState(-1)
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const [dynamicPlaceRow, setDynamicPlaceRow] = React.useState<PinRow | null>(
    null
  )
  const [activeDirections, setActiveDirections] =
    React.useState<ActiveDirections | null>(null)
  const [directionsLoadingKey, setDirectionsLoadingKey] = React.useState<
    string | null
  >(null)
  const [directionsError, setDirectionsError] = React.useState<string | null>(
    null
  )
  const [streetViewAvailabilityByKey, setStreetViewAvailabilityByKey] =
    React.useState<Record<string, boolean>>({})
  const placeDetailsRequestRef = React.useRef(0)

  const visibleRows = React.useMemo(
    () => collectPins(artifact, activeDay),
    [artifact, activeDay]
  )
  const overlayRows = React.useMemo(
    () => collectOverlayPins(overlayPins, visibleRows.length),
    [overlayPins, visibleRows.length]
  )
  const dynamicDirectionRows = React.useMemo(() => {
    if (!dynamicPlaceRow) return EMPTY_PIN_ROWS
    if (activeDirections?.destinationKey !== dynamicPlaceRow.key)
      return EMPTY_PIN_ROWS
    if (
      visibleRows.some((row) => row.key === dynamicPlaceRow.key) ||
      overlayRows.some((row) => row.key === dynamicPlaceRow.key)
    ) {
      return EMPTY_PIN_ROWS
    }
    return [dynamicPlaceRow]
  }, [
    activeDirections?.destinationKey,
    dynamicPlaceRow,
    overlayRows,
    visibleRows,
  ])
  const iframeRows = React.useMemo(
    () => [...visibleRows, ...overlayRows, ...dynamicDirectionRows],
    [dynamicDirectionRows, overlayRows, visibleRows]
  )
  const visibleRoutes = React.useMemo(
    () => collectRoutes(artifact, activeDay),
    [artifact, activeDay]
  )
  const visiblePolygons = React.useMemo(
    () => collectPolygons(artifact),
    [artifact]
  )
  const activeFitBounds =
    hasDays && activeDay >= 0 ? days[activeDay]?.fitBounds : undefined
  const activeRouteFitBounds = activeDirections?.fitBounds ?? activeFitBounds
  const rowsForFraming = overlayRows.length > 0 ? iframeRows : visibleRows
  const iframeFitBounds =
    overlayRows.length > 0
      ? (activeRouteFitBounds ??
        boundsForVisibleFeatures(
          rowsForFraming,
          visibleRoutes,
          visiblePolygons
        ))
      : activeRouteFitBounds

  const iframeArtifact = React.useMemo<IframeMapArtifact>(
    () => ({
      ...artifact,
      pins: iframeRows.map((row) => ({ ...row.pin, id: row.key })),
      routes: activeDirections
        ? [...visibleRoutes, ...activeDirections.routes]
        : visibleRoutes,
      polygons: visiblePolygons,
      days: undefined,
      fitBounds: iframeFitBounds,
      viewport: viewportForRows(
        rowsForFraming,
        artifact.viewport,
        iframeFitBounds
      ),
    }),
    [
      activeDirections,
      artifact,
      iframeFitBounds,
      iframeRows,
      rowsForFraming,
      visiblePolygons,
      visibleRoutes,
    ]
  )

  const iframeApi = React.useRef<MapIframeApi>(null)
  const activeRow = React.useMemo(
    () =>
      visibleRows.find((row) => row.key === activeKey) ??
      overlayRows.find((row) => row.key === activeKey) ??
      (dynamicPlaceRow?.key === activeKey ? dynamicPlaceRow : null),
    [activeKey, dynamicPlaceRow, overlayRows, visibleRows]
  )
  const iframeCameraResetKey = React.useMemo(
    () =>
      [
        cameraResetKey ?? title,
        activeDay,
        activeDirections?.destinationKey ?? "none",
      ].join(":"),
    [activeDay, activeDirections?.destinationKey, cameraResetKey, title]
  )
  const activeStreetViewKey = activeRow?.key ?? null
  const activeStreetViewLng = activeRow?.pin.position[0]
  const activeStreetViewLat = activeRow?.pin.position[1]
  const activeStreetViewAvailable =
    activeStreetViewKey !== null &&
    streetViewAvailabilityByKey[activeStreetViewKey] === true

  React.useEffect(() => {
    setStreetViewAvailabilityByKey({})
  }, [activeDay, cameraResetKey])

  React.useEffect(() => {
    if (
      !activeStreetViewKey ||
      typeof activeStreetViewLng !== "number" ||
      typeof activeStreetViewLat !== "number"
    )
      return
    iframeApi.current?.checkStreetView(activeStreetViewKey, [
      activeStreetViewLng,
      activeStreetViewLat,
    ])
  }, [activeStreetViewKey, activeStreetViewLat, activeStreetViewLng])

  const handleStreetViewAvailability = React.useCallback(
    (key: string, available: boolean) => {
      setStreetViewAvailabilityByKey((current) => {
        if (current[key] === available) return current
        return { ...current, [key]: available }
      })
    },
    []
  )

  const openStreetViewForRow = React.useCallback((row: PinRow) => {
    iframeApi.current?.openStreetView(row.pin.position)
  }, [])

  const changeDay = React.useCallback((idx: number) => {
    setActiveDay(idx)
    setActiveKey(null)
    setDynamicPlaceRow(null)
    setDirectionsError(null)
    setActiveDirections(null)
  }, [])

  const loadDynamicPlaceDetails = React.useCallback(
    async (key: string, placeId: string) => {
      const requestId = placeDetailsRequestRef.current + 1
      placeDetailsRequestRef.current = requestId
      try {
        const params = new URLSearchParams()
        if (typeof navigator !== "undefined" && navigator.language) {
          params.set("language", navigator.language)
        }
        const query = params.toString()
        const suffix = query ? `?${query}` : ""
        const response = await fetch(
          `/api/maps/place/${encodeURIComponent(placeId)}${suffix}`,
          { cache: "no-store" }
        )
        const body = (await response
          .json()
          .catch(() => ({}))) as PlaceDetailsApiResponse
        if (!response.ok || !body.place) {
          throw new Error(
            body.error ?? `Place details failed (${response.status})`
          )
        }
        if (requestId !== placeDetailsRequestRef.current) return

        const place = body.place
        setDynamicPlaceRow((current) => {
          if (!current || current.key !== key) return current
          return {
            ...current,
            loading: false,
            pin: {
              ...current.pin,
              id: `place-${place.id}`,
              label: place.title,
              address: place.address ?? current.pin.address,
              position: isMapCoordinate(place.position)
                ? place.position
                : current.pin.position,
              rating: place.rating ?? current.pin.rating,
              userRatingCount:
                place.userRatingCount ?? current.pin.userRatingCount,
              photoUrl: place.photoUrl ?? current.pin.photoUrl,
              placeId: place.id,
              googleMapsUri: place.googleMapsUri ?? current.pin.googleMapsUri,
              websiteUri: place.websiteUri ?? current.pin.websiteUri,
              businessStatus:
                place.businessStatus ?? current.pin.businessStatus,
              openNow:
                typeof place.openNow === "boolean"
                  ? place.openNow
                  : current.pin.openNow,
              openingHours:
                place.openingHours && place.openingHours.length > 0
                  ? place.openingHours
                  : current.pin.openingHours,
              phoneNumber: place.phoneNumber ?? current.pin.phoneNumber,
              priceLevel: place.priceLevel ?? current.pin.priceLevel,
              editorialSummary:
                place.editorialSummary ?? current.pin.editorialSummary,
            },
          }
        })
      } catch {
        // Keep the fallback row visible, but clear the loading state so
        // the UI stops showing skeletons and falls back to whatever data
        // we already have.
        setDynamicPlaceRow((current) => {
          if (!current || current.key !== key) return current
          if (!current.loading) return current
          return { ...current, loading: false }
        })
      }
    },
    []
  )

  const showDynamicPlace = React.useCallback(
    (
      placeId: string,
      position: MapCoordinate,
      fallback?: PlaceClickFallback | null
    ) => {
      const key = dynamicPlaceKey(placeId)
      const row = dynamicPlaceRowFromFallback({
        key,
        placeId,
        position,
        fallback,
      })
      const shouldLoadDetails =
        (!fallback && !isSyntheticSelectedPlaceId(placeId)) ||
        fallback?.provider === "google-places"
      setDynamicPlaceRow(shouldLoadDetails ? { ...row, loading: true } : row)
      setActiveKey(key)
      setDirectionsError(null)

      if (shouldLoadDetails) {
        void loadDynamicPlaceDetails(key, placeId)
      }
    },
    [loadDynamicPlaceDetails]
  )

  React.useEffect(() => {
    if (!searchTarget) return
    const placeId = searchTarget.placeId ?? searchTarget.id
    showDynamicPlace(placeId, searchTarget.position, {
      label: searchTarget.label,
      address: searchTarget.address,
      rating: searchTarget.rating,
      photoUrl: searchTarget.photoUrl,
      googleMapsUri: searchTarget.googleMapsUri,
      websiteUri: searchTarget.websiteUri,
      sourceUrl: searchTarget.sourceUrl,
      savedPlaceId: searchTarget.savedPlaceId,
      description: searchTarget.description,
      notes: searchTarget.notes,
      userRatingCount: searchTarget.userRatingCount,
      openNow: searchTarget.openNow,
      phoneNumber: searchTarget.phoneNumber,
      provider: searchTarget.provider,
    })
  }, [searchTarget, showDynamicPlace])

  const flyToPin = React.useCallback((row: PinRow) => {
    setActiveKey(row.key)
    setDynamicPlaceRow(null)
    setDirectionsError(null)
    iframeApi.current?.flyToPin(row.key, row.pin.position)
  }, [])

  const handlePinClicked = React.useCallback((key: string) => {
    setActiveKey(key)
    setDynamicPlaceRow(null)
    setDirectionsError(null)
  }, [])

  const clearActivePin = React.useCallback(() => {
    setActiveKey(null)
    setDynamicPlaceRow(null)
    setDirectionsError(null)
    setActiveDirections(null)
    iframeApi.current?.clearActive()
  }, [])

  const handlePlaceClicked = React.useCallback(
    (
      placeId: string,
      position?: MapCoordinate,
      fallback?: PlaceClickFallback | null
    ) => {
      const safePlaceId = placeId.trim()
      const safePosition =
        position && isMapCoordinate(position)
          ? position
          : dynamicPlaceRow?.pin.position
      if (!safePlaceId || !safePosition) return
      showDynamicPlace(
        safePlaceId,
        safePosition,
        fallback ??
          (isSyntheticSelectedPlaceId(safePlaceId)
            ? selectedPointFallback(safePosition)
            : null)
      )
    },
    [dynamicPlaceRow?.pin.position, showDynamicPlace]
  )

  const runDirections = React.useCallback(
    async (
      destinationKey: string,
      originPoint: DirectionsPoint,
      destinationPoint: DirectionsPoint,
      stopPoints: DirectionsPoint[],
      travelMode: DirectionsTravelMode
    ) => {
      setDirectionsError(null)
      setDirectionsLoadingKey(destinationKey)
      try {
        const [origin, destination, ...stops] = await Promise.all([
          resolveDirectionsPoint(originPoint),
          resolveDirectionsPoint(destinationPoint),
          ...stopPoints.map((point) => resolveDirectionsPoint(point)),
        ])
        if (
          stops.length === 0 &&
          distanceMetersBetween(origin.position, destination.position) <= 50
        ) {
          setDirectionsError("Originea și destinația sunt prea aproape.")
          return
        }

        let body: DirectionsApiResponse | null = null
        let actualTravelMode: DirectionsTravelMode = travelMode
        let lastError: Error | null = null
        for (const candidateMode of fallbackTravelModes(travelMode)) {
          try {
            body = await fetchDirectionsRoute({
              origin,
              destination,
              stops,
              travelMode: candidateMode,
            })
            actualTravelMode = candidateMode
            break
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error("Directions failed.")
            if (isTerminalDirectionsError(lastError)) break
          }
        }

        if (!body?.route) {
          throw lastError ?? new Error("Directions failed.")
        }

        const primarySummary = [
          body.durationText,
          formatRouteDistance(body.distanceMeters ?? null),
        ]
          .filter(Boolean)
          .join(" / ")
        const primaryRoute: MapRoute = {
          ...body.route,
          id: `directions-${destinationKey}`,
          color: actualTravelMode === "driving" ? "#2563eb" : "#0891b2",
          width: 7,
          style: "solid",
          label:
            `${travelModeLabel(actualTravelMode)}${primarySummary ? ` ${primarySummary}` : ""}` ||
            body.route.label,
        }
        const routeStart = firstRouteCoordinate(primaryRoute)
        const originConnector = routeStart
          ? buildDirectionsConnectorRoute({
              id: `directions-${destinationKey}-origin-connector`,
              from: origin.position,
              to: routeStart,
              label: "Conector până la începutul rutei",
            })
          : null
        const directionRoutes: MapRoute[] = originConnector
          ? [originConnector, primaryRoute]
          : [primaryRoute]
        let accessDistanceMeters: number | null = null
        let accessDurationText: string | null = null
        let notice =
          actualTravelMode === travelMode
            ? null
            : `${travelModeLabel(travelMode)} indisponibil; afișez ruta ${travelModeLabel(actualTravelMode).toLowerCase()}.`

        const drivingEndpoint = lastRouteCoordinate(primaryRoute)
        if (actualTravelMode === "driving" && drivingEndpoint) {
          const finalGapMeters = distanceMetersBetween(
            drivingEndpoint,
            destination.position
          )
          if (finalGapMeters > DRIVING_FINAL_WALK_THRESHOLD_METERS) {
            accessDistanceMeters = finalGapMeters
            try {
              const walkingBody = await fetchDirectionsRoute({
                origin: { position: drivingEndpoint },
                destination,
                travelMode: "walking",
              })
              const walkingSummary = [
                walkingBody.durationText,
                formatRouteDistance(
                  walkingBody.distanceMeters ?? finalGapMeters
                ),
              ]
                .filter(Boolean)
                .join(" / ")
              accessDistanceMeters =
                walkingBody.distanceMeters ?? finalGapMeters
              accessDurationText = walkingBody.durationText ?? null
              const walkingRoute: MapRoute = {
                ...(walkingBody.route ?? {
                  id: `directions-${destinationKey}-walk`,
                  coordinates: [drivingEndpoint, destination.position],
                }),
                id: `directions-${destinationKey}-walk`,
                color: "#f59e0b",
                width: 5,
                style: "dashed",
                label: `Ultima porțiune pe jos${walkingSummary ? ` ${walkingSummary}` : ""}`,
              }
              directionRoutes.push(walkingRoute)
              const walkingEndpoint = lastRouteCoordinate(walkingRoute)
              const walkingConnector =
                walkingEndpoint &&
                buildDirectionsConnectorRoute({
                  id: `directions-${destinationKey}-destination-connector`,
                  from: walkingEndpoint,
                  to: destination.position,
                  label: "Conector până la destinație",
                })
              if (walkingConnector) directionRoutes.push(walkingConnector)
              notice = appendDirectionsNotice(
                notice,
                `Mașina ajunge la ${formatRouteDistance(finalGapMeters) ?? `${Math.round(finalGapMeters)} m`} de pin; am adăugat ultima porțiune pe jos.`
              )
            } catch {
              directionRoutes.push({
                id: `directions-${destinationKey}-walk`,
                coordinates: [drivingEndpoint, destination.position],
                color: "#f59e0b",
                width: 5,
                style: "dashed",
                label: `Ultima porțiune pe jos aprox. ${formatRouteDistance(finalGapMeters) ?? `${Math.round(finalGapMeters)} m`}`,
              })
              notice = appendDirectionsNotice(
                notice,
                `Ruta auto se oprește la ${formatRouteDistance(finalGapMeters) ?? `${Math.round(finalGapMeters)} m`} de pin; marchez ultima porțiune pe jos aproximativ.`
              )
            }
          } else {
            const destinationConnector = buildDirectionsConnectorRoute({
              id: `directions-${destinationKey}-destination-connector`,
              from: drivingEndpoint,
              to: destination.position,
              label: "Conector până la destinație",
            })
            if (destinationConnector) directionRoutes.push(destinationConnector)
          }
        }
        if (actualTravelMode !== "driving" && drivingEndpoint) {
          const destinationConnector = buildDirectionsConnectorRoute({
            id: `directions-${destinationKey}-destination-connector`,
            from: drivingEndpoint,
            to: destination.position,
            label: "Conector până la destinație",
          })
          if (destinationConnector) directionRoutes.push(destinationConnector)
        }
        const routeFitBounds =
          boundsForVisibleFeatures([], directionRoutes, []) ??
          body.fitBounds ??
          null
        setActiveDirections({
          destinationKey,
          route: primaryRoute,
          routes: directionRoutes,
          fitBounds: routeFitBounds,
          distanceMeters: body.distanceMeters ?? null,
          durationText: body.durationText ?? null,
          accessDistanceMeters,
          accessDurationText,
          originLabel: originPoint.label,
          destinationLabel: destinationPoint.label,
          originPoint,
          destinationPoint,
          stops: stopPoints,
          requestedTravelMode: travelMode,
          travelMode: actualTravelMode,
          navigationUrl: googleDirectionsUrl({
            originPoint,
            origin,
            destinationPoint,
            destination,
            stopPoints,
            stops,
            travelMode: actualTravelMode,
          }),
          notice,
        })
      } catch (error) {
        setDirectionsError(
          error instanceof Error ? error.message : "Directions failed."
        )
      } finally {
        setDirectionsLoadingKey((current) =>
          current === destinationKey ? null : current
        )
      }
    },
    []
  )

  const handleDirections = React.useCallback(
    async (row: PinRow, request?: DirectionsRequest) => {
      setActiveKey(row.key)
      const destinationKey = request?.destinationKey ?? row.key
      const originPoint = request?.origin ?? currentDirectionsPoint()
      const destinationPoint =
        request?.destination ?? directionsPointFromRow(row)
      const stopPoints = request?.waypoints ?? []
      const travelMode = request?.travelMode ?? "driving"
      await runDirections(
        destinationKey,
        originPoint,
        destinationPoint,
        stopPoints,
        travelMode
      )
    },
    [runDirections]
  )

  const handleAddStop = React.useCallback(
    async (row: PinRow) => {
      const current = activeDirections
      if (!current) return
      const stopPoint = directionsPointFromRow(row)
      if (
        current.stops.some((existing) =>
          existing.placeId && stopPoint.placeId
            ? existing.placeId === stopPoint.placeId
            : pointsAtSamePosition(existing, stopPoint)
        )
      ) {
        return
      }
      if (pointsAtSamePosition(current.destinationPoint, stopPoint)) return
      if (pointsAtSamePosition(current.originPoint, stopPoint)) return
      await runDirections(
        current.destinationKey,
        current.originPoint,
        current.destinationPoint,
        [...current.stops, stopPoint],
        current.requestedTravelMode
      )
    },
    [activeDirections, runDirections]
  )

  const handleRemoveStop = React.useCallback(
    async (stopIndex: number) => {
      const current = activeDirections
      if (!current) return
      if (stopIndex < 0 || stopIndex >= current.stops.length) return
      const nextStops = current.stops.filter((_, idx) => idx !== stopIndex)
      await runDirections(
        current.destinationKey,
        current.originPoint,
        current.destinationPoint,
        nextStops,
        current.requestedTravelMode
      )
    },
    [activeDirections, runDirections]
  )

  const handleReorderStops = React.useCallback(
    async (nextStops: DirectionsPoint[]) => {
      const current = activeDirections
      if (!current) return
      await runDirections(
        current.destinationKey,
        current.originPoint,
        current.destinationPoint,
        nextStops,
        current.requestedTravelMode
      )
    },
    [activeDirections, runDirections]
  )

  const isInline = mode === "inline"
  const shouldShowSidebar =
    !hideSidebar &&
    !sidebarCollapsed &&
    !isInline &&
    (visibleRows.length >= 1 || Boolean(activeRow))
  const shouldRenderRichSidebar =
    !hideSidebar && !isInline && (visibleRows.length >= 1 || Boolean(activeRow))
  const sidePanelOverrideActive =
    !hideSidebar && !isInline && Boolean(sidePanelOverride)
  const shouldRenderSidePanelSlot = Boolean(
    sidePanelOverrideActive || shouldRenderRichSidebar
  )
  const sidePanelSlotOpen = Boolean(
    sidePanelOverrideActive ? sidePanelOverrideOpen : shouldShowSidebar
  )

  const containerCls = isInline
    ? "flex w-full flex-col gap-2"
    : "relative flex h-full min-h-0 w-full flex-col gap-0 xl:flex-row"

  return (
    <div className={cn(containerCls, className)}>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2",
          !isInline && "min-h-0 flex-1"
        )}
      >
        {hasDays && (
          <DayTabs
            days={days}
            activeDay={activeDay}
            offsetForMapChrome={mapPage}
            onChange={changeDay}
          />
        )}
        <div className={cn("relative", !isInline && "min-h-0 flex-1")}>
          <MapIframe
            ref={iframeApi}
            artifact={iframeArtifact}
            cameraResetKey={iframeCameraResetKey}
            title={title}
            apiKey={apiKey}
            mapId={mapId}
            mode={mode}
            frameless={frameless}
            onPinClicked={handlePinClicked}
            onPinCleared={() => {
              setActiveKey(null)
              setDynamicPlaceRow(null)
            }}
            onPlaceClicked={handlePlaceClicked}
            onAreaSelected={onAreaSelected}
            onAreaDrawingCancelled={onAreaDrawingCancelled}
            onStreetViewVisibleChange={onStreetViewVisibleChange}
            onStreetViewAvailability={handleStreetViewAvailability}
            onEarth3DUnavailable={onEarth3DUnavailable}
            onOrbitStateChange={onOrbitStateChange}
            mapSettings={mapSettings}
            searchTarget={searchTarget}
            actionCommand={actionCommand}
          />
          {activeRow && (isInline || hideSidebar || sidebarCollapsed) && (
            <FloatingPlaceSheet
              row={activeRow}
              roomy={!isInline}
              directions={
                activeDirections?.destinationKey === activeRow.key
                  ? activeDirections
                  : null
              }
              directionsLoading={
                directionsLoadingKey === activeRow.key ||
                directionsLoadingKey === activeDirections?.destinationKey
              }
              directionsError={directionsError}
              onDirections={handleDirections}
              activeDirections={activeDirections}
              onAddStop={handleAddStop}
              onRemoveStop={handleRemoveStop}
              onReorderStops={handleReorderStops}
              streetViewAvailable={activeStreetViewAvailable}
              onStreetView={openStreetViewForRow}
              onClose={clearActivePin}
            />
          )}
          {!fullscreen && !mapPage && (
            <button
              type="button"
              onClick={onFullscreenToggle}
              aria-label={fullscreenActionLabel}
              className="absolute top-3 right-3 z-10 flex size-9 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
            >
              {fullscreenActionLabel === "Open map page" ? (
                <ExternalLink className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </button>
          )}
        </div>
        {isInline && visibleRows.length >= 2 && (
          <ChipsRow
            rows={visibleRows}
            activeKey={activeKey}
            onSelect={flyToPin}
          />
        )}
      </div>
      {shouldRenderSidePanelSlot && (
        <div
          aria-hidden={!sidePanelSlotOpen}
          className={cn(
            "pointer-events-none absolute top-0 right-0 bottom-0 z-[70] flex justify-end overflow-hidden transition-[width,opacity,transform] will-change-[width,transform,opacity]",
            sidePanelInFlow &&
              "xl:relative xl:inset-auto xl:z-[70] xl:h-full xl:shrink-0",
            "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            sidePanelSlotOpen
              ? "w-[380px] translate-x-0 opacity-100"
              : "w-0 translate-x-4 opacity-0"
          )}
        >
          <div className="pointer-events-auto h-full w-[380px] max-w-[100vw] shrink-0 overflow-hidden">
            {sidePanelOverrideActive ? (
              sidePanelOverride
            ) : (
              <RichSidebar
                framed
                open={sidePanelSlotOpen}
                title={
                  hasDays && activeDay >= 0
                    ? (days[activeDay]?.label ?? "Locations")
                    : title
                }
                rows={visibleRows}
                activeKey={activeKey}
                activeRow={activeRow}
                onSelect={flyToPin}
                onCloseActive={clearActivePin}
                activeDirections={activeDirections}
                directionsLoadingKey={directionsLoadingKey}
                directionsError={directionsError}
                tripDays={hasDays ? days : []}
                activeDay={activeDay}
                onDayChange={changeDay}
                onDirections={handleDirections}
                onAddStop={handleAddStop}
                onRemoveStop={handleRemoveStop}
                onReorderStops={handleReorderStops}
                streetViewAvailable={activeStreetViewAvailable}
                onStreetView={openStreetViewForRow}
                assistantOpen={assistantOpen}
                onOpenAssistant={onOpenAssistant}
                onOpenMapLibrary={onOpenMapLibrary}
                onCollapse={
                  onSidebarCollapsedChange
                    ? () => onSidebarCollapsedChange(true)
                    : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
