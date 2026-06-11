"use client"

import * as React from "react"

import { VIEW_FADE_MS, VIEW_LEAVE_EVENT } from "@/lib/view-fade"

/**
 * Returns true once a VIEW_LEAVE_EVENT fires, so the view shell that owns the
 * fade can ease itself out ahead of a route swap (instead of hard-cutting to
 * the next route's blank loading boundary). The departing route fades out, the
 * blank boundary bridges the gap, and the arriving view fades in.
 *
 * Auto-clears as a safety net (one fade + 1s) if a navigation never lands, so
 * the view can't get stuck blank.
 */
export function useViewLeaveFade(): boolean {
  const [leaving, setLeaving] = React.useState(false)

  React.useEffect(() => {
    const onLeave = () => setLeaving(true)
    window.addEventListener(VIEW_LEAVE_EVENT, onLeave)
    return () => window.removeEventListener(VIEW_LEAVE_EVENT, onLeave)
  }, [])

  React.useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), VIEW_FADE_MS + 1000)
    return () => window.clearTimeout(timer)
  }, [leaving])

  return leaving
}
