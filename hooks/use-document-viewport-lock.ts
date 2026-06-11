"use client"

import * as React from "react"

export function useDocumentViewportLock(active = true) {
  React.useLayoutEffect(() => {
    if (!active) return

    const root = document.documentElement
    const previous = root.dataset.orchViewportLock
    root.dataset.orchViewportLock = "true"

    let frame: number | null = null
    const keepWindowPinned = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        // A pinch-zoomed visual viewport pans legitimately — only fight the
        // pan when the page is at 1:1 scale (the keyboard-reveal case).
        const scale = window.visualViewport?.scale ?? 1
        if (scale > 1.02) return
        if (window.scrollX !== 0 || window.scrollY !== 0) {
          window.scrollTo(0, 0)
        }
      })
    }

    keepWindowPinned()

    // iOS Safari "reveals" a focused field by panning the page even when the
    // body is position:fixed. That pan moves the whole layout (header
    // included) and often doesn't fire a window scroll event — only the
    // visualViewport ones. Pin on those too so each surface's own keyboard
    // inset is the single thing that moves, and the pan is cancelled the
    // moment it happens.
    const visualViewport = window.visualViewport
    window.addEventListener("scroll", keepWindowPinned, { passive: true })
    visualViewport?.addEventListener("scroll", keepWindowPinned)
    visualViewport?.addEventListener("resize", keepWindowPinned)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener("scroll", keepWindowPinned)
      visualViewport?.removeEventListener("scroll", keepWindowPinned)
      visualViewport?.removeEventListener("resize", keepWindowPinned)

      if (previous === undefined) delete root.dataset.orchViewportLock
      else root.dataset.orchViewportLock = previous
    }
  }, [active])
}
