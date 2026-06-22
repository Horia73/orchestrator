"use client"

import * as React from "react"

interface ScreenWakeLockSentinel extends EventTarget {
  readonly released?: boolean
  release: () => Promise<void>
}

interface ScreenWakeLock {
  request: (type: "screen") => Promise<ScreenWakeLockSentinel>
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: ScreenWakeLock
}

export function useScreenWakeLock(active = true) {
  React.useEffect(() => {
    if (!active) return
    if (typeof window === "undefined" || typeof document === "undefined") return

    const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock
    if (!wakeLock || typeof wakeLock.request !== "function") return

    let disposed = false
    let requestInFlight: Promise<void> | null = null
    let sentinel: ScreenWakeLockSentinel | null = null
    let detachReleaseListener: (() => void) | null = null

    const clearSentinel = () => {
      detachReleaseListener?.()
      detachReleaseListener = null
      sentinel = null
    }

    const release = async () => {
      const current = sentinel
      clearSentinel()
      if (!current || current.released) return
      try {
        await current.release()
      } catch {
        // Best-effort API; nothing user-actionable when the browser refuses.
      }
    }

    const request = async () => {
      if (disposed || document.visibilityState !== "visible") return
      if (sentinel && !sentinel.released) return
      if (requestInFlight) return requestInFlight

      requestInFlight = wakeLock
        .request("screen")
        .then((nextSentinel) => {
          if (disposed || document.visibilityState !== "visible") {
            void nextSentinel.release().catch(() => undefined)
            return
          }

          sentinel = nextSentinel
          const onRelease = () => {
            if (sentinel === nextSentinel) clearSentinel()
            if (!disposed && document.visibilityState === "visible") {
              window.setTimeout(() => void request(), 0)
            }
          }
          nextSentinel.addEventListener("release", onRelease)
          detachReleaseListener = () => nextSentinel.removeEventListener("release", onRelease)
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = null
        })

      return requestInFlight
    }

    const syncToVisibility = () => {
      if (document.visibilityState === "visible") void request()
      else void release()
    }

    void request()
    document.addEventListener("visibilitychange", syncToVisibility)
    window.addEventListener("focus", syncToVisibility)
    window.addEventListener("pageshow", syncToVisibility)

    return () => {
      disposed = true
      document.removeEventListener("visibilitychange", syncToVisibility)
      window.removeEventListener("focus", syncToVisibility)
      window.removeEventListener("pageshow", syncToVisibility)
      void release()
    }
  }, [active])
}
