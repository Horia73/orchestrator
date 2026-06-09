"use client"

import * as React from "react"

import { appApiPath } from "@/lib/app-path"

const PING_PATH = "/api/ping"
// Probe cadence while a response is streaming. Each ping is a tiny 204, so a
// short interval is cheap and keeps detection responsive.
const PING_INTERVAL_MS = 1500
// A ping slower than this counts as a failure (dead/hung connection).
const PING_TIMEOUT_MS = 3000
// Only flag "reconnecting" after the connection has been continuously
// unreachable for longer than this. A momentary blip on a good network never
// shows — this is what kills the old appear/disappear flicker.
const DISCONNECT_GRACE_MS = 1000

/**
 * Tracks whether the device can actually reach the server *right now*, decoupled
 * from the AI/stream state machine. While `active` (a response is streaming), it
 * pings the server on a short interval and watches `online`/`offline`. It
 * reports `true` only once the connection has been down continuously for more
 * than {@link DISCONNECT_GRACE_MS}, and clears the instant a ping succeeds — so
 * the chat "Reconnecting…" hint reflects real connectivity, not stream-recovery
 * churn.
 */
export function useServerConnection(active: boolean): boolean {
  const [reconnecting, setReconnecting] = React.useState(false)
  const downSinceRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (!active) {
      downSinceRef.current = null
      setReconnecting(false)
      return
    }

    let cancelled = false
    let inFlight = false

    const evaluate = (ok: boolean) => {
      if (cancelled) return
      if (ok) {
        downSinceRef.current = null
        setReconnecting(false)
        return
      }
      const now = Date.now()
      if (downSinceRef.current === null) downSinceRef.current = now
      if (now - downSinceRef.current >= DISCONNECT_GRACE_MS) {
        setReconnecting(true)
      }
    }

    const ping = async () => {
      if (cancelled || inFlight) return
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        evaluate(false)
        return
      }
      inFlight = true
      const controller = new AbortController()
      const timer = window.setTimeout(
        () => controller.abort(),
        PING_TIMEOUT_MS
      )
      try {
        const res = await fetch(`${appApiPath(PING_PATH)}?t=${Date.now()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        })
        evaluate(res.ok)
      } catch {
        evaluate(false)
      } finally {
        window.clearTimeout(timer)
        inFlight = false
      }
    }

    void ping()
    const interval = window.setInterval(() => void ping(), PING_INTERVAL_MS)
    const onOffline = () => evaluate(false)
    const onOnline = () => void ping()
    const onVisible = () => {
      if (document.visibilityState === "visible") void ping()
    }
    window.addEventListener("offline", onOffline)
    window.addEventListener("online", onOnline)
    window.addEventListener("focus", onOnline)
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener("offline", onOffline)
      window.removeEventListener("online", onOnline)
      window.removeEventListener("focus", onOnline)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [active])

  return reconnecting
}
