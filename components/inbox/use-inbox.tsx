"use client"

import * as React from "react"
import type { Message } from "@/lib/types"
import { useAppEvent } from "@/hooks/use-app-events"

export interface InboxListItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  readAt: number | null
  scheduledTaskId: string | null
  preview: string
  messageCount: number
}

export interface InboxDetail {
  id: string
  title: string
  createdAt: number
  readAt: number | null
  scheduledTaskId: string | null
  messages: Message[]
}

interface InboxApi {
  items: InboxListItem[]
  unread: number
  loading: boolean
  error: string | null
  selectedId: string | null
  detail: InboxDetail | null
  detailLoading: boolean
  open: (id: string) => Promise<void>
  clear: () => void
  remove: (id: string) => Promise<void>
  reply: (id: string) => Promise<string | null>
  respond: (id: string, content: string) => Promise<boolean>
}

const InboxContext = React.createContext<InboxApi | null>(null)

export function InboxProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<InboxListItem[]>([])
  const [unread, setUnread] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<InboxDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load inbox (${res.status})`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
      setUnread(typeof data.unread === "number" ? data.unread : 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox")
    }
  }, [])

  const loadDetail = React.useCallback(async (id: string) => {
    const res = await fetch(`/api/inbox/${id}`, { cache: "no-store" })
    if (!res.ok) throw new Error(`Failed to open item (${res.status})`)
    const data = await res.json()
    setDetail(data.item as InboxDetail)
  }, [])

  useAppEvent(["inbox.changed"], (event) => {
    if (event.type !== "inbox.changed") return
    if (document.visibilityState !== "visible") return
    const eventConversationId = event.conversationId
    if (!eventConversationId || eventConversationId !== selectedId) {
      void refresh()
      return
    }
    if (event.action === "deleted") {
      setSelectedId(null)
      setDetail(null)
      void refresh()
      return
    }
    if (event.action === "changed") {
      void (async () => {
        try {
          await loadDetail(eventConversationId)
          await refresh()
          window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Failed to refresh item"
          )
        }
      })()
      return
    }
    void refresh()
  })

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const onTick = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onTick)
    window.addEventListener("orchestrator:inbox-updated", onTick)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onTick)
      window.removeEventListener("orchestrator:inbox-updated", onTick)
    }
  }, [refresh])

  const open = React.useCallback(
    async (id: string) => {
      setSelectedId(id)
      setDetailLoading(true)
      try {
        await loadDetail(id)
        await refresh()
        window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open item")
      } finally {
        setDetailLoading(false)
      }
    },
    [loadDetail, refresh]
  )

  const remove = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/inbox/${id}`, { method: "DELETE" })
      if (res.ok) {
        if (selectedId === id) {
          setSelectedId(null)
          setDetail(null)
        }
        await refresh()
        window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      }
    },
    [refresh, selectedId]
  )

  const reply = React.useCallback(
    async (id: string): Promise<string | null> => {
      const res = await fetch(`/api/inbox/${id}/reply`, { method: "POST" })
      if (!res.ok) return null
      const data = await res.json()
      await refresh()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return typeof data.conversationId === "string"
        ? data.conversationId
        : null
    },
    [refresh]
  )

  const respond = React.useCallback(
    async (id: string, content: string): Promise<boolean> => {
      const text = content.trim()
      if (!text) return false
      const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticMessage: Message = {
        id: optimisticId,
        role: "user",
        content: text,
        timestamp: Date.now(),
      }
      setDetail((current) =>
        current?.id === id
          ? { ...current, messages: [...current.messages, optimisticMessage] }
          : current
      )
      const res = await fetch(`/api/inbox/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      })
      if (!res.ok) {
        setDetail((current) =>
          current?.id === id
            ? {
                ...current,
                messages: current.messages.filter((m) => m.id !== optimisticId),
              }
            : current
        )
        setError(`Failed to send reply (${res.status})`)
        return false
      }
      const data = await res.json()
      if (data.item) setDetail(data.item as InboxDetail)
      setError(null)
      await refresh()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return true
    },
    [refresh]
  )

  const clear = React.useCallback(() => {
    setSelectedId(null)
    setDetail(null)
  }, [])

  const value = React.useMemo<InboxApi>(
    () => ({
      items,
      unread,
      loading,
      error,
      selectedId,
      detail,
      detailLoading,
      open,
      clear,
      remove,
      reply,
      respond,
    }),
    [
      items,
      unread,
      loading,
      error,
      selectedId,
      detail,
      detailLoading,
      open,
      clear,
      remove,
      reply,
      respond,
    ]
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxApi {
  const ctx = React.useContext(InboxContext)
  if (!ctx) throw new Error("useInbox must be used within an InboxProvider")
  return ctx
}
