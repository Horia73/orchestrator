"use client"

import * as React from "react"

export function useRevealOnScroll(timeoutMs = 900) {
  const [active, setActive] = React.useState(false)
  const activeRef = React.useRef(false)
  const fadeTimeoutRef = React.useRef<number | null>(null)

  const reveal = React.useCallback(() => {
    if (!activeRef.current) {
      activeRef.current = true
      setActive(true)
    }
    if (fadeTimeoutRef.current !== null) {
      window.clearTimeout(fadeTimeoutRef.current)
    }
    fadeTimeoutRef.current = window.setTimeout(() => {
      activeRef.current = false
      fadeTimeoutRef.current = null
      setActive(false)
    }, timeoutMs)
  }, [timeoutMs])

  React.useEffect(
    () => () => {
      if (fadeTimeoutRef.current !== null) {
        window.clearTimeout(fadeTimeoutRef.current)
      }
    },
    []
  )

  return { active, reveal }
}
