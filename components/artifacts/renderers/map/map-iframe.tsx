"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import type { MapBBox, MapCoordinate } from "@/lib/maps/schema"

import { INLINE_HEIGHT_PX } from "./constants"
import { buildIframeHtml } from "./iframe-html"
import type {
  IframeMapArtifact,
  MapActionCommand,
  MapAreaSelection,
  MapIframeApi,
  MapRuntimeSettings,
  MapSearchTarget,
  PlaceClickFallback,
} from "./types"

interface MapIframeProps {
  artifact: IframeMapArtifact
  cameraResetKey: string
  title: string
  apiKey: string
  mapId: string
  mode: "inline" | "panel"
  frameless?: boolean
  className?: string
  onPinClicked?: (key: string) => void
  onPinCleared?: () => void
  onPlaceClicked?: (
    placeId: string,
    position?: MapCoordinate,
    fallback?: PlaceClickFallback | null
  ) => void
  onAreaSelected?: (selection: MapAreaSelection) => void
  onAreaDrawingCancelled?: (clearSelection: boolean) => void
  onStreetViewVisibleChange?: (visible: boolean) => void
  onStreetViewAvailability?: (key: string, available: boolean) => void
  onEarth3DUnavailable?: () => void
  onOrbitStateChange?: (active: boolean) => void
  mapSettings?: MapRuntimeSettings
  searchTarget?: MapSearchTarget | null
  actionCommand?: MapActionCommand | null
}

function isMapCoordinate(value: unknown): value is MapCoordinate {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lng, lat] = value
  return (
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  )
}

function isMapBBox(value: unknown): value is MapBBox {
  if (!Array.isArray(value) || value.length !== 4) return false
  const [west, south, east, north] = value
  return (
    typeof west === "number" &&
    typeof south === "number" &&
    typeof east === "number" &&
    typeof north === "number" &&
    Number.isFinite(west) &&
    Number.isFinite(south) &&
    Number.isFinite(east) &&
    Number.isFinite(north) &&
    Math.abs(west) <= 180 &&
    Math.abs(east) <= 180 &&
    Math.abs(south) <= 90 &&
    Math.abs(north) <= 90
  )
}

function parseMapAreaSelection(value: unknown): MapAreaSelection | null {
  if (!value || typeof value !== "object") return null
  const area = value as {
    ring?: unknown
    bbox?: unknown
    center?: unknown
    areaSqKm?: unknown
  }
  if (
    !Array.isArray(area.ring) ||
    area.ring.length < 3 ||
    !area.ring.every(isMapCoordinate) ||
    !isMapBBox(area.bbox) ||
    !isMapCoordinate(area.center)
  ) {
    return null
  }
  return {
    ring: area.ring,
    bbox: area.bbox,
    center: area.center,
    areaSqKm:
      typeof area.areaSqKm === "number" && Number.isFinite(area.areaSqKm)
        ? area.areaSqKm
        : null,
  }
}

function createMapChannelToken(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  return `orch-map:${random}`
}

export const MapIframe = React.forwardRef<MapIframeApi, MapIframeProps>(
  function MapIframe(
    {
      artifact,
      cameraResetKey,
      title,
      apiKey,
      mapId,
      mode,
      frameless = false,
      className,
      onPinClicked,
      onPinCleared,
      onPlaceClicked,
      onAreaSelected,
      onAreaDrawingCancelled,
      onStreetViewVisibleChange,
      onStreetViewAvailability,
      onEarth3DUnavailable,
      onOrbitStateChange,
      mapSettings,
      searchTarget,
      actionCommand,
    },
    ref
  ) {
    const iframeRef = React.useRef<HTMLIFrameElement>(null)
    const [ready, setReady] = React.useState(false)
    const [rendered, setRendered] = React.useState(false)
    const [channelToken] = React.useState(createMapChannelToken)

    const srcDoc = React.useMemo(
      () => buildIframeHtml({ apiKey, mapId, mode, channelToken }),
      [apiKey, mapId, mode, channelToken]
    )

    React.useEffect(() => {
      setReady(false)
      setRendered(false)
    }, [srcDoc])

    const postToIframe = React.useCallback(
      (message: Record<string, unknown>) => {
        if (!ready) return
        const w = iframeRef.current?.contentWindow
        if (!w) return
        w.postMessage({ ...message, __orchMapToken: channelToken }, "*")
      },
      [channelToken, ready]
    )

    React.useEffect(() => {
      const w = iframeRef.current?.contentWindow
      if (!w) return
      postToIframe({
        __orchMap: "init",
        payload: { artifact, cameraResetKey },
      })
    }, [postToIframe, artifact, cameraResetKey])

    React.useEffect(() => {
      if (!ready || !mapSettings) return
      postToIframe({ __orchMap: "set-settings", payload: mapSettings })
    }, [ready, mapSettings, postToIframe])

    React.useEffect(() => {
      if (!ready || !searchTarget) return
      postToIframe({
        __orchMap: "show-search-target",
        payload: searchTarget,
      })
    }, [ready, searchTarget, postToIframe])

    React.useEffect(() => {
      if (!ready || !actionCommand) return
      postToIframe({ __orchMap: "run-action", payload: actionCommand })
    }, [ready, actionCommand, postToIframe])

    React.useEffect(() => {
      function onMessage(e: MessageEvent) {
        if (e.source !== iframeRef.current?.contentWindow) return
        const data = e.data as
          | {
              __orchMap?: string
              __orchMapToken?: string
              key?: string
              message?: string
              placeId?: string
              position?: unknown
              fallback?: PlaceClickFallback | null
              area?: unknown
              visible?: boolean
              available?: boolean
              clearSelection?: boolean
              active?: boolean
            }
          | undefined
        if (!data || !data.__orchMap) return
        if (data.__orchMapToken !== channelToken) return
        if (data.__orchMap === "ready") {
          setReady(true)
        } else if (data.__orchMap === "rendered") {
          setRendered(true)
        } else if (data.__orchMap === "pin-clicked" && data.key) {
          onPinClicked?.(data.key)
        } else if (data.__orchMap === "pin-cleared") {
          onPinCleared?.()
        } else if (data.__orchMap === "place-clicked" && data.placeId) {
          onPlaceClicked?.(
            data.placeId,
            isMapCoordinate(data.position) ? data.position : undefined,
            data.fallback ?? null
          )
        } else if (data.__orchMap === "area-selected") {
          const selection = parseMapAreaSelection(data.area)
          if (selection) onAreaSelected?.(selection)
        } else if (data.__orchMap === "area-draw-cancelled") {
          onAreaDrawingCancelled?.(data.clearSelection === true)
        } else if (data.__orchMap === "street-view-visible") {
          onStreetViewVisibleChange?.(data.visible === true)
        } else if (data.__orchMap === "street-view-availability" && data.key) {
          onStreetViewAvailability?.(data.key, data.available === true)
        } else if (data.__orchMap === "earth3d-unavailable") {
          onEarth3DUnavailable?.()
        } else if (data.__orchMap === "orbit-state") {
          onOrbitStateChange?.(data.active === true)
        } else if (data.__orchMap === "error") {
          setRendered(true)
          console.warn("[map iframe]", data.message)
        }
      }
      window.addEventListener("message", onMessage)
      return () => window.removeEventListener("message", onMessage)
    }, [
      onPinClicked,
      onPinCleared,
      onPlaceClicked,
      onAreaSelected,
      onAreaDrawingCancelled,
      onStreetViewVisibleChange,
      onStreetViewAvailability,
      onEarth3DUnavailable,
      onOrbitStateChange,
      channelToken,
    ])

    React.useImperativeHandle(
      ref,
      () => ({
        flyToPin: (key, position) => {
          postToIframe({ __orchMap: "fly-to-pin", key, position })
        },
        checkStreetView: (key, position) => {
          postToIframe({ __orchMap: "check-street-view", key, position })
        },
        openStreetView: (position) => {
          const payload: MapActionCommand = {
            type: "open-street-view",
            nonce: Date.now(),
            position,
          }
          postToIframe({ __orchMap: "run-action", payload })
        },
        clearActive: () => {
          postToIframe({ __orchMap: "clear-active" })
        },
      }),
      [postToIframe]
    )

    const containerStyle: React.CSSProperties =
      mode === "panel"
        ? { width: "100%", height: "100%", minHeight: 480 }
        : { width: "100%", height: INLINE_HEIGHT_PX }

    return (
      <div
        className={cn(
          "relative overflow-hidden bg-muted/30",
          frameless
            ? "rounded-none border-0"
            : "rounded-xl border border-border/60",
          className
        )}
        style={containerStyle}
      >
        <iframe
          ref={iframeRef}
          title={title}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          className={cn(
            "block h-full w-full border-0 transition-opacity duration-300 transform-gpu [backface-visibility:hidden]",
            rendered ? "opacity-100" : "opacity-0"
          )}
        />
        {!rendered && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-muted/40"
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading map…
            </div>
          </div>
        )}
      </div>
    )
  }
)
