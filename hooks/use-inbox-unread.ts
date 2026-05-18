"use client"

import * as React from "react"

const POLL_MS = 5000

/**
 * Lightweight unread-count poller for the sidebar Inbox badge. Refetches on a
 * timer (visibility-gated) and immediately when something dispatches
 * `orchestrator:inbox-updated` (e.g. after the user reads/deletes an item).
 */
export function useInboxUnread(): number {
  const [unread, setUnread] = React.useState(0)

  React.useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }

    if (unread > 0 && typeof nav.setAppBadge === "function") {
      void nav.setAppBadge(unread).catch(() => {})
    } else if (unread === 0 && typeof nav.clearAppBadge === "function") {
      void nav.clearAppBadge().catch(() => {})
    }
  }, [unread])

  React.useEffect(() => {
    let cancelled = false

    const fetchUnread = async () => {
      if (cancelled || document.visibilityState !== "visible") return
      try {
        const res = await fetch("/api/inbox/unread", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && typeof data.unread === "number")
          setUnread(data.unread)
      } catch {
        // transient — keep the last known count
      }
    }

    void fetchUnread()
    const interval = window.setInterval(fetchUnread, POLL_MS)
    const onUpdated = () => {
      void fetchUnread()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchUnread()
    }
    window.addEventListener("orchestrator:inbox-updated", onUpdated)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener("orchestrator:inbox-updated", onUpdated)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  return unread
}
