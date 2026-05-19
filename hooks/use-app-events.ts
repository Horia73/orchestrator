"use client"

import * as React from "react"
import type { AppEvent, AppEventType } from "@/lib/events"

type Listener = (event: AppEvent) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let reconnectTimer: number | null = null

function isAppEvent(value: unknown): value is AppEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { at?: unknown }).at === "number"
  )
}

function notify(event: AppEvent) {
  for (const listener of listeners) listener(event)
}

function ensureEventSource() {
  if (typeof window === "undefined" || source) return
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  source = new EventSource("/api/events/stream")
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data)
      if (isAppEvent(parsed)) notify(parsed)
    } catch {
      // Ignore malformed frames; the stream stays open.
    }
  }
  source.onerror = () => {
    // EventSource reconnects automatically. Focus/visibility handlers in each
    // consumer provide a cheap reconciliation path after sleep or network loss.
    const current = source
    if (!current || current.readyState !== EventSource.CLOSED) return
    current.close()
    if (source === current) source = null
    if (listeners.size > 0 && reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        ensureEventSource()
      }, 1000)
    }
  }
}

function closeEventSourceIfIdle() {
  if (listeners.size > 0) return
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  source?.close()
  source = null
}

export function useAppEvent(
  eventTypes: readonly AppEventType[],
  handler: (event: AppEvent) => void
) {
  const handlerRef = React.useRef(handler)
  const eventTypesKey = eventTypes.join("|")

  React.useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  React.useEffect(() => {
    const wanted = new Set(eventTypesKey.split("|") as AppEventType[])
    const listener: Listener = (event) => {
      if (wanted.has(event.type)) handlerRef.current(event)
    }

    listeners.add(listener)
    ensureEventSource()

    return () => {
      listeners.delete(listener)
      closeEventSourceIfIdle()
    }
  }, [eventTypesKey])
}
