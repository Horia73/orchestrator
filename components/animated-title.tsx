"use client"

import * as React from "react"

// Per-character cadence for the delete → type reveal. Deleting reads faster
// than typing, so the old text clears quickly before the new one writes in.
const DELETE_MS = 32
const TYPE_MS = 52

/**
 * Renders a conversation title and animates changes: it backspaces the current
 * text down to the common prefix with the new title, then types the rest in.
 * Used in the sidebar so an auto-generated name reveals smoothly over the
 * instant placeholder.
 *
 * Robust to rapid prop changes: a single animation loop always chases the
 * latest target (`targetRef`) starting from whatever is currently on screen
 * (`displayRef`), so if the title is retargeted mid-flight it adapts smoothly
 * instead of restarting or jumping — no flicker even if the store briefly
 * oscillates the value.
 *
 * - First mount (or remount) shows the title immediately, no animation.
 * - Honors `prefers-reduced-motion` with an instant swap.
 * - The timer is cleared on unmount.
 */
export function AnimatedTitle({
  title,
  className,
}: {
  title: string
  className?: string
}) {
  const [display, setDisplay] = React.useState(title)
  const displayRef = React.useRef(title)
  const targetRef = React.useRef(title)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = React.useRef(false)

  const show = React.useCallback((value: string) => {
    displayRef.current = value
    setDisplay(value)
  }, [])

  React.useEffect(() => {
    // First paint for this instance: adopt the title with no animation.
    if (!mountedRef.current) {
      mountedRef.current = true
      targetRef.current = title
      show(title)
      return
    }

    // Already animating toward this exact title — let the running loop finish.
    if (title === targetRef.current) return
    targetRef.current = title

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    if (prefersReducedMotion) {
      show(title)
      return
    }

    // Cancel any pending frame; the loop below restarts from the live display.
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const tick = () => {
      const to = targetRef.current
      const current = displayRef.current
      // Shared prefix of what's shown and the latest target — only the
      // differing tail is rewritten.
      let common = 0
      while (
        common < current.length &&
        common < to.length &&
        current[common] === to[common]
      ) {
        common++
      }

      if (current.length > common) {
        show(current.slice(0, -1))
        timerRef.current = setTimeout(tick, DELETE_MS)
      } else if (current.length < to.length) {
        show(to.slice(0, current.length + 1))
        timerRef.current = setTimeout(tick, TYPE_MS)
      } else {
        timerRef.current = null
      }
    }
    tick()
  }, [title, show])

  React.useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  // Non-breaking space keeps the line height stable at the empty midpoint.
  return <span className={className}>{display || " "}</span>
}
