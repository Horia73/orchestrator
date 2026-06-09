"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Bare-text "Reconnecting…" that sits in the empty bottom of the chat input as
 * an overlay — no chip, no spinner, no bar, so it never shifts the layout. Just
 * the word with a calm light sweep across the glyphs, fading in/out. Visibility
 * is driven by {@link useServerConnection}, which only flags a real device→
 * server outage of >1s — so this never flickers on stream-recovery churn.
 */
export function ChatConnectionPill({
  reconnecting,
  style,
}: {
  reconnecting: boolean
  style?: React.CSSProperties
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4"
      style={style}
    >
      <div
        className={cn(
          "transition-opacity duration-500 ease-out motion-reduce:transition-none",
          reconnecting ? "opacity-100" : "opacity-0"
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
