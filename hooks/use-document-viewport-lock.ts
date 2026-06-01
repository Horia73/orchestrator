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
        if (window.scrollX !== 0 || window.scrollY !== 0) {
          window.scrollTo(0, 0)
        }
      })
    }

    keepWindowPinned()

    const visualViewport = window.visualViewport
    window.addEventListener("scroll", keepWindowPinned, { passive: true })
    visualViewport?.addEventListener("resize", keepWindowPinned)
    visualViewport?.addEventListener("scroll", keepWindowPinned)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener("scroll", keepWindowPinned)
      visualViewport?.removeEventListener("resize", keepWindowPinned)
      visualViewport?.removeEventListener("scroll", keepWindowPinned)

      if (previous === undefined) delete root.dataset.orchViewportLock
      else root.dataset.orchViewportLock = previous
    }
  }, [active])
}
