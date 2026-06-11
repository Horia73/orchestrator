"use client"

import * as React from "react"

import { useViewLeaveFade } from "@/hooks/use-view-leave-fade"
import { cn } from "@/lib/utils"

/**
 * Enter/leave fade for top-level views.
 *
 * `ready` gates the enter: the view holds at opacity-0 (blending into the
 * blank route bridge) until its initial data resolved, then eases in fully
 * formed — one reveal, no sections popping in one by one. A safety cap
 * force-enters after `capMs` so a slow or hung fetch degrades to showing the
 * view's own in-page loading state instead of holding a blank screen.
 *
 * Pairs with VIEW_LEAVE_EVENT (fired by the sidebar): the view eases out
 * before the route swaps, the blank loading boundary bridges the gap, and the
 * arriving view eases in here.
 */
export function useViewEnterFade(ready: boolean, capMs = 700): boolean {
  const [entered, setEntered] = React.useState(false)
  const leaving = useViewLeaveFade()

  React.useEffect(() => {
    if (entered) return
    if (ready) {
      const frame = window.requestAnimationFrame(() => setEntered(true))
      return () => window.cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(() => setEntered(true), capMs)
    return () => window.clearTimeout(timer)
  }, [ready, entered, capMs])

  return entered && !leaving
}

/**
 * Fade shell for views that own their initial data load. Renders the view's
 * root element; pass the root layout classes via `className` and the initial
 * "data is ready" signal via `ready`.
 */
export function ViewFade({
  ready = true,
  capMs,
  children,
  className,
}: {
  ready?: boolean
  capMs?: number
  children: React.ReactNode
  className?: string
}) {
  const visible = useViewEnterFade(ready, capMs)

  return (
    <div
      className={cn(
        "transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * Fade shell for route content whose chrome is ready immediately (static
 * headers/tabs; any data loads are in-page concerns of the children). Views
 * that should reveal only once their data resolved use ViewFade with `ready`
 * instead.
 */
export function RouteFade({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <ViewFade
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden",
        className
      )}
    >
      {children}
    </ViewFade>
  )
}
