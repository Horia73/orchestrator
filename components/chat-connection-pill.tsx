"use client"

import * as React from "react"

import type { StreamingStatus } from "@/hooks/chat-store-utils"
import { cn } from "@/lib/utils"

const MIN_VISIBLE_MS = 1000

/**
 * Latches a streaming status so a brief reconnect still shows the indicator for
 * a minimum dwell time. The live `status` can flip back to null in well under a
 * second, which reads as a buggy flash — the latch keeps it up for at least
 * `minVisibleMs` once it appears.
 */
export function useStickyConnectionStatus(
  status: StreamingStatus,
  minVisibleMs = MIN_VISIBLE_MS
): StreamingStatus {
  const [shown, setShown] = React.useState<StreamingStatus>(null)
  const shownAtRef = React.useRef(0)

  React.useEffect(() => {
    if (status) {
      if (!shown) shownAtRef.current = Date.now()
      setShown(status)
      return
    }
    if (!shown) return
    const remaining = Math.max(
      0,
      minVisibleMs - (Date.now() - shownAtRef.current)
    )
    const timer = window.setTimeout(() => setShown(null), remaining)
    return () => window.clearTimeout(timer)
  }, [status, shown, minVisibleMs])

  return shown
}

/**
 * Bare-text "Reconnecting…" that sits in the empty bottom of the chat input as
 * an overlay — no chip, no spinner, no bar, so it never shifts the layout. Just
 * the word with a calm light sweep across the glyphs. The outer layer fades
 * in/out; the inner span owns the sweep so the fade and the animation don't
 * fight over opacity.
 */
export function ChatConnectionPill({
  status,
  style,
}: {
  status: StreamingStatus
  style?: React.CSSProperties
}) {
  const visible = useStickyConnectionStatus(status) !== null

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4"
      style={style}
    >
      <div
        className={cn(
          "transition-opacity duration-500 ease-out motion-reduce:transition-none",
          visible ? "opacity-100" : "opacity-0"
        )}
      >
        <span
          role="status"
          aria-live="polite"
          className="connection-status-text text-sm font-medium tracking-[-0.01em]"
        >
          Reconnecting…
        </span>
      </div>
    </div>
  )
}
