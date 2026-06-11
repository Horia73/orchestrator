"use client"

import * as React from "react"
import type { Attachment, Message } from "@/lib/types"
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
  refresh: () => Promise<void>
  open: (id: string) => Promise<void>
  clear: () => void
  remove: (id: string) => Promise<void>
  reply: (id: string) => Promise<string | null>
  respond: (
    id: string,
    content: string,
    attachments?: Attachment[],
  ) => Promise<boolean>
  triggerDirectAction: (
    id: string,
    messageId: string,
    actionId: string,
  ) => Promise<boolean>
}

const InboxContext = React.createContext<InboxApi | null>(null)

// Last fetched list, kept at module scope. The provider is remounted per
// route visit; seeding from here lets revisits fade in already populated while
// a silent refresh runs, instead of waiting on the list fetch again.
let cachedInbox: { items: InboxListItem[]; unread: number } | null = null

export function InboxProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<InboxListItem[]>(
    () => cachedInbox?.items ?? []
  )
  const [unread, setUnread] = React.useState(() => cachedInbox?.unread ?? 0)
  const [loading, setLoading] = React.useState(cachedInbox === null)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<InboxDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const selectedIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const refreshList = React.useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load inbox (${res.status})`)
      const data = await res.json()
      const nextItems = Array.isArray(data.items) ? data.items : []
      const nextUnread = typeof data.unread === "number" ? data.unread : 0
      cachedInbox = { items: nextItems, unread: nextUnread }
      setItems(nextItems)
      setUnread(nextUnread)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox")
    }
  }, [])

  const loadDetail = React.useCallback(async (id: string) => {
    const res = await fetch(`/api/inbox/${id}`, { cache: "no-store" })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Failed to open item (${res.status})`)
    const data = await res.json()
    const item = data.item as InboxDetail
    if (selectedIdRef.current === id) setDetail(item)
    return item
  }, [])

  const refresh = React.useCallback(async () => {
    const currentSelectedId = selectedIdRef.current
    let detailError: unknown = null

    if (currentSelectedId) {
      try {
        const item = await loadDetail(currentSelectedId)
        if (!item && selectedIdRef.current === currentSelectedId) {
          selectedIdRef.current = null
          setSelectedId(null)
          setDetail(null)
        }
      } catch (err) {
        detailError = err
      }
    }

    await refreshList()

    if (detailError) {
      setError(
        detailError instanceof Error
          ? detailError.message
          : "Failed to refresh item"
      )
    }
  }, [loadDetail, refreshList])

  useAppEvent(["inbox.changed"], (event) => {
    if (event.type !== "inbox.changed") return
    if (document.visibilityState !== "visible") return
    const eventConversationId = event.conversationId
    const currentSelectedId = selectedIdRef.current
    if (!eventConversationId || eventConversationId !== currentSelectedId) {
      void refreshList()
      return
    }
    if (event.action === "deleted") {
      selectedIdRef.current = null
      setSelectedId(null)
      setDetail(null)
      void refreshList()
      return
    }
    if (event.action === "changed") {
      void (async () => {
        try {
          await refresh()
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Failed to refresh item"
          )
        }
      })()
      return
    }
    void refreshList()
  })

  React.useEffect(() => {
    let cancelled = false
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const onTick = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onTick)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pageshow", onFocus)
    window.addEventListener("orchestrator:inbox-updated", onTick)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onTick)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pageshow", onFocus)
      window.removeEventListener("orchestrator:inbox-updated", onTick)
    }
  }, [refresh])

  const open = React.useCallback(
    async (id: string) => {
      selectedIdRef.current = id
      setSelectedId(id)
      setDetailLoading(true)
      try {
        const item = await loadDetail(id)
        if (!item) {
          if (selectedIdRef.current === id) {
            selectedIdRef.current = null
            setSelectedId(null)
            setDetail(null)
          }
          throw new Error("Inbox item not found")
        }
        await refreshList()
        window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open item")
      } finally {
        setDetailLoading(false)
      }
    },
    [loadDetail, refreshList]
  )

  const remove = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/inbox/${id}`, { method: "DELETE" })
      if (res.ok) {
        if (selectedIdRef.current === id) {
          selectedIdRef.current = null
          setSelectedId(null)
          setDetail(null)
        }
        await refreshList()
        window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      }
    },
    [refreshList]
  )

  const reply = React.useCallback(
    async (id: string): Promise<string | null> => {
      const res = await fetch(`/api/inbox/${id}/reply`, { method: "POST" })
      if (!res.ok) return null
      const data = await res.json()
      await refreshList()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return typeof data.conversationId === "string"
        ? data.conversationId
        : null
    },
    [refreshList]
  )

  const respond = React.useCallback(
    async (
      id: string,
      content: string,
      attachments?: Attachment[],
    ): Promise<boolean> => {
      const text = content.trim()
      if (!text && !attachments?.length) return false
      const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticMessage: Message = {
        id: optimisticId,
        role: "user",
        content: text,
        timestamp: Date.now(),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      }
      setDetail((current) =>
        current?.id === id
          ? { ...current, messages: [...current.messages, optimisticMessage] }
          : current
      )
      const res = await fetch(`/api/inbox/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
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
      await refreshList()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return true
    },
    [refreshList]
  )

  const triggerDirectAction = React.useCallback(
    async (
      id: string,
      messageId: string,
      actionId: string,
    ): Promise<boolean> => {
      const res = await fetch(`/api/inbox/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, actionId }),
      })
      if (!res.ok) {
        let detailMessage: string | null = null
        try {
          const body = (await res.json()) as { error?: unknown }
          if (typeof body.error === "string") detailMessage = body.error
        } catch {
          /* non-json error body */
        }
        setError(detailMessage ?? `Failed to run quick action (${res.status})`)
        return false
      }
      const data = (await res.json()) as {
        item?: InboxDetail
        action?: { success?: boolean; error?: string | null }
      }
      if (data.item) setDetail(data.item)
      if (data.action && data.action.success === false) {
        setError(data.action.error ?? "Quick action failed")
      } else {
        setError(null)
      }
      await refreshList()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return data.action?.success !== false
    },
    [refreshList]
  )

  const clear = React.useCallback(() => {
    selectedIdRef.current = null
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
      refresh,
      open,
      clear,
      remove,
      reply,
      respond,
      triggerDirectAction,
    }),
    [
      items,
      unread,
      loading,
      error,
      selectedId,
      detail,
      detailLoading,
      refresh,
      open,
      clear,
      remove,
      reply,
      respond,
      triggerDirectAction,
    ]
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxApi {
  const ctx = React.useContext(InboxContext)
  if (!ctx) throw new Error("useInbox must be used within an InboxProvider")
  return ctx
}
