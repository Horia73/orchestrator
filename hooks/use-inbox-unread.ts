"use client"

import * as React from "react"
import { useAppEvent } from "@/hooks/use-app-events"

/**
 * Lightweight unread-count sync for the sidebar Inbox badge. Refetches on app
 * invalidation events and when the tab becomes visible.
 */
export function useInboxUnread(): number {
  const [unread, setUnread] = React.useState(0)

  const fetchUnread = React.useCallback(async () => {
    if (document.visibilityState !== "visible") return
    try {
      const res = await fetch("/api/inbox/unread", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.unread === "number") setUnread(data.unread)
    } catch {
      // transient — keep the last known count
    }
  }, [])

  useAppEvent(["inbox.changed"], () => {
    void fetchUnread()
  })

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
    void fetchUnread()
    const onUpdated = () => {
      void fetchUnread()
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchUnread()
    }
    window.addEventListener("orchestrator:inbox-updated", onUpdated)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      window.removeEventListener("orchestrator:inbox-updated", onUpdated)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [fetchUnread])

  return unread
}
