"use client"

import * as React from "react"

const SCROLLBAR_VISIBLE_ATTR = "data-orch-scrollbar-visible"
const SCROLLBAR_IDLE_MS = 850

export function TransientScrollbarController() {
  React.useEffect(() => {
    const activeTimers = new Map<Element, number>()

    const hide = (element: Element) => {
      element.removeAttribute(SCROLLBAR_VISIBLE_ATTR)
      activeTimers.delete(element)
    }

    const reveal = (element: Element) => {
      element.setAttribute(SCROLLBAR_VISIBLE_ATTR, "true")

      const activeTimer = activeTimers.get(element)
      if (activeTimer !== undefined) {
        window.clearTimeout(activeTimer)
      }

      activeTimers.set(
        element,
        window.setTimeout(() => hide(element), SCROLLBAR_IDLE_MS)
      )
    }

    const handleScroll = (event: Event) => {
      const scrollElement = getScrollElement(event.target)
      if (!scrollElement) return
      reveal(scrollElement)
    }

    const listenerOptions = { capture: true, passive: true } as const
    document.addEventListener("scroll", handleScroll, listenerOptions)

    return () => {
      document.removeEventListener("scroll", handleScroll, listenerOptions)
      for (const [element, timer] of activeTimers) {
        window.clearTimeout(timer)
        element.removeAttribute(SCROLLBAR_VISIBLE_ATTR)
      }
      activeTimers.clear()
    }
  }, [])

  return null
}

function getScrollElement(target: EventTarget | null): Element | null {
  if (target instanceof Document) {
    return target.scrollingElement ?? target.documentElement
  }
  if (target instanceof Element) return target
  return document.scrollingElement ?? document.documentElement
}
