"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Archive,
  ArrowUp,
  ArrowLeft,
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Loader2,
  Mail,
  MailOpen,
  RefreshCw,
  Reply,
  Search,
  Trash2,
} from "lucide-react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { useChatStore } from "@/hooks/use-chat-store"
import { useInboxPushNotifications } from "@/hooks/use-inbox-push-notifications"
import { cn } from "@/lib/utils"
import type { InboxReplyAction, ReasoningEntry } from "@/lib/types"
import type { InboxListItem } from "./use-inbox"
import { InboxProvider, useInbox } from "./use-inbox"

type FolderFilter = "inbox" | "unread" | "read" | "scheduled"

type DetailMessageData = {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: number
  reasoning?: ReasoningEntry[]
  replyActions?: InboxReplyAction[]
}

function activityTime(item: InboxListItem): number {
  return item.lastMessageAt ?? item.updatedAt ?? item.createdAt
}

function isUnread(item: InboxListItem): boolean {
  const lastActivity = activityTime(item)
  return item.readAt == null || item.readAt < lastActivity
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(ms))
}

function fullDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))
}

function groupLabel(ms: number): string {
  const then = new Date(ms)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(then, today)) return "Today"
  if (sameDay(then, yesterday)) return "Yesterday"
  return "Earlier"
}

function senderForItem(item: InboxListItem): string {
  return item.scheduledTaskId ? "Scheduled run" : "Inbox"
}

function itemMatchesFilter(item: InboxListItem, filter: FolderFilter): boolean {
  if (filter === "unread") return isUnread(item)
  if (filter === "read") return !isUnread(item)
  if (filter === "scheduled") return Boolean(item.scheduledTaskId)
  return true
}

function senderForMessage(message: DetailMessageData, index: number): string {
  if (message.role === "assistant") return "Scheduled run"
  return index === 0 ? "Trigger" : "You"
}

function initialsForMessage(message: DetailMessageData, index: number): string {
  if (message.role === "assistant") return "SR"
  return index === 0 ? "TR" : "ME"
}

function messagePreview(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim()
  if (singleLine.length <= 140) return singleLine
  return `${singleLine.slice(0, 139).trimEnd()}...`
}

function inferQuickReplyActions(message: DetailMessageData): InboxReplyAction[] {
  if (message.role !== "assistant" || message.replyActions?.length) return []

  const content = message.content.toLowerCase()
  const mentionsGmail = /\bgmail\b/.test(content)
  const hasArchiveCandidate =
    /candidate(?:le|lor)?\s+(?:bun(?:e|i)?\s+)?de\s+arhivat/.test(content) ||
    /candida(?:t|te|ti|ți).{0,80}arhiv/.test(content) ||
    /archive candidate/.test(content)
  const looksNonUrgentDigest =
    /(toate|all).{0,80}non-urgent/.test(content) ||
    /non-urgent.{0,80}(arhiv|archive)/.test(content)

  if (!mentionsGmail || (!hasArchiveCandidate && !looksNonUrgentDigest)) {
    return []
  }

  return [
    {
      id: "archive_gmail_candidates",
      label: "Arhivează candidatele",
      value:
        "Arhivează mesajele Gmail marcate explicit ca non-urgente sau candidate de arhivat în acest rezumat. Confirm această acțiune pentru itemele enumerate aici; dacă un mesaj nu poate fi identificat fără ambiguitate, sari peste el și spune-mi.",
      style: "primary",
    },
    {
      id: "keep_gmail_candidates",
      label: "Păstrează tot",
      value:
        "Nu arhiva niciun mesaj Gmail din acest rezumat. Păstrează-le în Inbox și ține cont că aceste tipuri pot fi tratate ca rutină pe viitor.",
      style: "secondary",
    },
    {
      id: "review_gmail_candidates",
      label: "Revizuiește întâi",
      value:
        "Arată-mi detaliile mesajelor Gmail candidate de arhivat din acest rezumat înainte de orice acțiune.",
      style: "secondary",
    },
  ]
}

function MarkdownPreviewLine({ content }: { content: string }) {
  const components = React.useMemo(
    () => ({
      p: ({ children }: { children?: React.ReactNode }) => (
        <span>{children}</span>
      ),
      strong: ({ children }: { children?: React.ReactNode }) => (
        <strong className="font-semibold text-slate-700 dark:text-slate-200">
          {children}
        </strong>
      ),
      em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
      ul: ({ children }: { children?: React.ReactNode }) => (
        <span>{children}</span>
      ),
      ol: ({ children }: { children?: React.ReactNode }) => (
        <span>{children}</span>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <span> - {children}</span>
      ),
      code: ({ children }: { children?: React.ReactNode }) => (
        <code className="rounded bg-slate-100 px-1 text-[12px] dark:bg-white/10">
          {children}
        </code>
      ),
      a: ({ children }: { children?: React.ReactNode }) => (
        <span className="text-[#b76440]">{children}</span>
      ),
      h1: ({ children }: { children?: React.ReactNode }) => (
        <span className="font-semibold">{children}</span>
      ),
      h2: ({ children }: { children?: React.ReactNode }) => (
        <span className="font-semibold">{children}</span>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <span className="font-semibold">{children}</span>
      ),
      br: () => <span> </span>,
    }),
    []
  )

  return (
    <div className="mt-0.5 line-clamp-2 min-w-0 text-[13px] leading-5 text-slate-500 dark:text-slate-400 [&_*]:inline">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content || "No preview available."}
      </ReactMarkdown>
    </div>
  )
}

function TraceSummary({ reasoning }: { reasoning: ReasoningEntry[] }) {
  const steps = reasoning.filter(
    (r): r is Extract<ReasoningEntry, { type: "tool_call" | "agent_call" }> =>
      r.type === "tool_call" || r.type === "agent_call"
  )
  if (steps.length === 0) return null
  return (
    <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
      <summary className="cursor-pointer font-medium text-slate-600 select-none dark:text-slate-300">
        {steps.length} step{steps.length > 1 ? "s" : ""}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                s.status === "error"
                  ? "bg-red-600"
                  : s.status === "ok"
                    ? "bg-emerald-500"
                    : "bg-slate-400"
              )}
            />
            <span className="truncate">
              {s.type === "agent_call" ? `agent · ${s.agentName}` : s.title}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function QuickReplyActions({
  actions,
  disabled,
  busyActionId,
  onSelect,
}: {
  actions?: InboxReplyAction[]
  disabled: boolean
  busyActionId: string | null
  onSelect: (action: InboxReplyAction) => void
}) {
  if (!actions?.length) return null
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {actions.map((action) => {
        const destructive = action.style === "destructive"
        const primary = action.style === "primary"
        const busy = busyActionId === action.id
        return (
          <button
            key={action.id}
            type="button"
            onClick={() => onSelect(action)}
            disabled={disabled}
            className={cn(
              "inline-flex min-h-8 max-w-full items-center rounded-md border px-3 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
              primary
                ? "border-[#b76440] bg-[#b76440] text-white hover:bg-[#a55837]"
                : destructive
                  ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
                  : "border-border/70 bg-background text-foreground/70 hover:bg-[#f0ede6] hover:text-foreground dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
            )}
            title={action.value}
          >
            <span className="block truncate">
              {busy ? "Sending..." : action.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function InboxPushButton() {
  const { status, busy, error, enable } = useInboxPushNotifications()
  if (status === "unsupported") return null

  const enabled = status === "enabled"
  const blocked = status === "blocked"
  const checking = status === "checking"
  const title =
    error ??
    (enabled
      ? "Inbox notifications enabled"
      : blocked
        ? "Notifications blocked by browser settings"
        : "Enable Inbox notifications")

  return (
    <button
      type="button"
      onClick={() => {
        if (!enabled && !blocked && !checking) void enable()
      }}
      disabled={busy || blocked || checking}
      title={title}
      aria-label={title}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent text-slate-500 transition-colors hover:border-slate-200 hover:bg-white hover:text-slate-900 disabled:pointer-events-none disabled:opacity-45 dark:hover:border-white/10 dark:hover:bg-white/[0.05] dark:hover:text-white",
        enabled && "text-emerald-600 dark:text-emerald-400"
      )}
    >
      {busy || checking ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Bell className="size-4" />
      )}
    </button>
  )
}

function FilterChip({
  active,
  count,
  children,
  onClick,
}: {
  active: boolean
  count?: number
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors",
        active
          ? "border-border bg-[#f0ede6] text-foreground dark:bg-muted"
          : "border-border/70 bg-background text-foreground/70 hover:bg-[#f0ede6]/65 hover:text-foreground dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
      )}
    >
      <span>{children}</span>
      {typeof count === "number" && (
        <span
          className={cn(
            "ml-1.5 inline-flex min-w-4 justify-center rounded-full px-1 text-[11px] leading-5",
            active ? "bg-[#e7e5dd] dark:bg-white/10" : "text-foreground/50"
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function EmptyList({ query, filter }: { query: string; filter: FolderFilter }) {
  const label = query
    ? "No matching messages"
    : filter === "unread"
      ? "No unread mail"
      : "No inbox items yet"

  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center px-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400 dark:border-white/10 dark:bg-white/[0.04]">
        <MailOpen className="size-5" />
      </div>
      <p className="mt-4 text-[14px] font-medium text-slate-700 dark:text-slate-200">
        {label}
      </p>
      <p className="mt-1 max-w-[260px] text-[13px] leading-5 text-slate-500 dark:text-slate-400">
        {query
          ? "Try a different subject, preview, or source."
          : "Scheduled run results will appear here as mail-style threads."}
      </p>
    </div>
  )
}

function MessageRow({
  item,
  active,
  onOpen,
}: {
  item: InboxListItem
  active: boolean
  onOpen: () => void
}) {
  const activityAt = activityTime(item)
  const unread = isUnread(item)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-b border-border/60 px-4 py-2.5 text-left transition-colors focus-visible:bg-[#f0ede6] focus-visible:outline-none dark:border-white/10 dark:focus-visible:bg-muted",
        active
          ? "bg-[#f0ede6] dark:bg-muted"
          : "bg-background hover:bg-[#f0ede6]/60 dark:bg-transparent dark:hover:bg-white/[0.04]"
      )}
    >
      <div className="pt-1.5">
        <span
          className={cn(
            "block size-2 rounded-full",
            unread ? "bg-[#b76440]" : "bg-transparent"
          )}
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-[13px]",
              unread
                ? "font-semibold text-slate-950 dark:text-white"
                : "font-medium text-slate-700 dark:text-slate-200"
            )}
          >
            {senderForItem(item)}
          </span>
          <span className="hidden h-1 w-1 shrink-0 rounded-full bg-slate-300 sm:block" />
          <span className="hidden shrink-0 text-[12px] text-slate-400 sm:inline">
            {item.messageCount} msg{item.messageCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-[14px]",
              unread
                ? "font-semibold text-slate-950 dark:text-white"
                : "font-medium text-slate-800 dark:text-slate-200"
            )}
          >
            {item.title}
          </span>
        </div>
        <MarkdownPreviewLine content={item.preview} />
      </div>
      <div className="flex flex-col items-end gap-2 pt-0.5">
        <span
          className={cn(
            "text-[12px]",
            unread
              ? "font-semibold text-[#b76440] dark:text-[#d78a66]"
              : "text-muted-foreground"
          )}
        >
          {timeAgo(activityAt)}
        </span>
      </div>
    </button>
  )
}

function DetailMessage({
  message,
  index,
  total,
  responding,
  busyActionId,
  onQuickReply,
}: {
  message: DetailMessageData
  index: number
  total: number
  responding: boolean
  busyActionId: string | null
  onQuickReply: (action: InboxReplyAction) => void
}) {
  const assistant = message.role === "assistant"
  const sender = senderForMessage(message, index)
  const initials = initialsForMessage(message, index)
  const newest = index === total - 1

  return (
    <article
      className={cn(
        "border-b border-border/60 bg-background dark:border-white/10",
        newest && "bg-background"
      )}
    >
      <header className="flex items-start gap-3 px-4 py-3 md:px-6">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
            assistant
              ? "bg-[#f0ede6] text-[#b76440] dark:bg-white/[0.08] dark:text-[#d78a66]"
              : "bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300"
          )}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <span className="truncate text-[14px] font-semibold text-slate-900 dark:text-white">
                {sender}
              </span>
              {assistant && (
                <span className="ml-2 rounded bg-slate-100 px-1.5 text-[11px] leading-5 font-medium text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
                  Result
                </span>
              )}
              <div className="truncate text-[12px] text-slate-500 dark:text-slate-400">
                to me
              </div>
            </div>
            <span className="shrink-0 text-[12px] text-slate-500 dark:text-slate-400">
              {fullDate(message.timestamp)}
            </span>
          </div>
        </div>
      </header>
      <div className="px-4 pb-5 text-[14px] leading-7 text-slate-800 md:px-6 md:pl-[72px] dark:text-slate-100">
        <MarkdownRenderer content={message.content} />
        {assistant && (
          <QuickReplyActions
            actions={message.replyActions}
            disabled={responding}
            busyActionId={busyActionId}
            onSelect={onQuickReply}
          />
        )}
        {message.reasoning && message.reasoning.length > 0 && (
          <TraceSummary reasoning={message.reasoning} />
        )}
      </div>
    </article>
  )
}

function CollapsedDetailMessage({
  message,
  index,
  onExpand,
}: {
  message: DetailMessageData
  index: number
  onExpand: () => void
}) {
  const assistant = message.role === "assistant"
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex w-full min-w-0 items-center gap-3 border-b border-border/60 bg-background px-4 py-3 text-left transition-colors hover:bg-[#f0ede6]/60 dark:border-white/10 dark:hover:bg-white/[0.06]"
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
          assistant
            ? "bg-[#f0ede6] text-[#b76440] dark:bg-white/[0.08] dark:text-[#d78a66]"
            : "bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300"
        )}
      >
        {initialsForMessage(message, index)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-slate-900 dark:text-white">
            {senderForMessage(message, index)}
          </span>
          {assistant && (
            <span className="rounded bg-slate-100 px-1.5 text-[11px] leading-5 font-medium text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
              Result
            </span>
          )}
          <span className="ml-auto shrink-0 text-[12px] text-slate-400">
            {timeAgo(message.timestamp)}
          </span>
        </div>
        <MarkdownPreviewLine content={messagePreview(message.content)} />
      </div>
      <ChevronRight className="size-4 shrink-0 text-slate-400" />
    </button>
  )
}

function InboxViewInner() {
  const {
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
  } = useInbox()
  const { selectConversation } = useChatStore()
  const router = useRouter()
  const { isMobile } = useSidebar()
  const searchParams = useSearchParams()
  const { confirm, dialog } = useConfirm()
  const [replying, setReplying] = React.useState(false)
  const [responding, setResponding] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [busyActionId, setBusyActionId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [folderFilter, setFolderFilter] = React.useState<FolderFilter>("inbox")
  const [expandedMessageIds, setExpandedMessageIds] = React.useState<
    Set<string>
  >(new Set())

  React.useEffect(() => {
    const id = searchParams.get("item")
    if (id && id !== selectedId) void open(id)
  }, [open, searchParams, selectedId])

  const counts = React.useMemo(() => {
    const read = items.filter((item) => !isUnread(item)).length
    const scheduled = items.filter((item) => item.scheduledTaskId).length
    return {
      inbox: items.length,
      unread,
      read,
      scheduled,
    }
  }, [items, unread])

  const sortedItems = React.useMemo(
    () =>
      [...items].sort((a, b) => {
        const activityDelta = activityTime(b) - activityTime(a)
        if (activityDelta !== 0) return activityDelta
        return b.createdAt - a.createdAt
      }),
    [items]
  )

  const filteredItems = React.useMemo(() => {
    const q = normalize(query.trim())
    return sortedItems.filter((item) => {
      if (!itemMatchesFilter(item, folderFilter)) return false
      if (!q) return true
      return (
        normalize(item.title).includes(q) ||
        normalize(item.preview || "").includes(q) ||
        normalize(senderForItem(item)).includes(q)
      )
    })
  }, [folderFilter, query, sortedItems])

  const groupedItems = React.useMemo(() => {
    const groups: Array<{ label: string; items: InboxListItem[] }> = []
    for (const item of filteredItems) {
      const label = groupLabel(activityTime(item))
      const group = groups.find((entry) => entry.label === label)
      if (group) group.items.push(item)
      else groups.push({ label, items: [item] })
    }
    return groups
  }, [filteredItems])

  const selectedItem = React.useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  )

  const threadMessages = React.useMemo(
    () =>
      [...(detail?.messages ?? [])].sort((a, b) => a.timestamp - b.timestamp),
    [detail?.messages]
  )
  const latestMessageId = threadMessages.at(-1)?.id ?? null

  React.useEffect(() => {
    setExpandedMessageIds(
      latestMessageId ? new Set([latestMessageId]) : new Set()
    )
  }, [detail?.id, latestMessageId])

  const toggleMessageExpanded = React.useCallback(
    (messageId: string) => {
      setExpandedMessageIds((current) => {
        const next = new Set(current)
        if (next.has(messageId)) {
          if (messageId !== latestMessageId) next.delete(messageId)
        } else {
          next.add(messageId)
        }
        return next
      })
    },
    [latestMessageId]
  )

  const onReply = async (id: string) => {
    setReplying(true)
    let conversationId: string | null = null
    try {
      conversationId = await reply(id)
    } finally {
      setReplying(false)
    }
    if (conversationId) {
      selectConversation(conversationId)
      if (isMobile) router.replace("/")
      else router.push("/")
    }
  }

  const onRespond = async (id: string, content: string, actionId?: string) => {
    const text = content.trim()
    if (!text || responding) return
    setResponding(true)
    setBusyActionId(actionId ?? null)
    if (!actionId) setDraft("")
    let ok = false
    try {
      ok = await respond(id, text)
    } finally {
      setResponding(false)
      setBusyActionId(null)
    }
    if (!ok && !actionId) setDraft(content)
  }

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  React.useEffect(() => {
    setDraft("")
    setBusyActionId(null)
    setResponding(false)
  }, [selectedId])

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {dialog}
      <div
        className={cn(
          "min-h-0 w-full shrink-0 flex-col border-r border-border/60 bg-background md:flex md:w-[430px] xl:w-[520px] dark:border-white/10",
          selectedId ? "hidden md:flex" : "flex"
        )}
      >
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <header className="border-b border-border/60 bg-background px-4 pt-[calc(0.875rem+env(safe-area-inset-top))] pb-3 md:pt-4 dark:border-white/10">
              <div className="flex items-center gap-3">
                <SidebarTrigger className="-ml-1 size-10 shrink-0 text-foreground/55 hover:text-foreground md:hidden" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate text-[20px] font-semibold tracking-[-0.01em] text-foreground">
                      Inbox
                    </h1>
                    {unread > 0 && (
                      <span className="shrink-0 rounded-full bg-[#b76440]/10 px-2 text-[12px] leading-6 font-semibold text-[#8b4a32] dark:text-[#d78a66]">
                        {unread} unread
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-foreground/55">
                    Scheduled run mail, replies, and handoffs
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onRefresh()}
                  disabled={refreshing}
                  title="Refresh inbox"
                  aria-label="Refresh inbox"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full border border-transparent text-foreground/55 transition-colors hover:bg-[#f0ede6] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/[0.05]"
                >
                  <RefreshCw
                    className={cn("size-4", refreshing && "animate-spin")}
                  />
                </button>
                <InboxPushButton />
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground/40" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search inbox"
                    className="h-10 w-full rounded-lg border border-transparent bg-[#f0ede6]/70 pr-3 pl-9 text-[14px] text-foreground transition-shadow outline-none placeholder:text-foreground/50 focus:bg-white focus:shadow-[0_0_0_0.5px_rgba(93,72,57,0.52)] dark:border-white/10 dark:bg-white/[0.04] dark:focus:bg-white/[0.06]"
                  />
                </div>
              </div>

              <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
                <FilterChip
                  active={folderFilter === "inbox"}
                  count={counts.inbox}
                  onClick={() => setFolderFilter("inbox")}
                >
                  Inbox
                </FilterChip>
                <FilterChip
                  active={folderFilter === "unread"}
                  count={counts.unread}
                  onClick={() => setFolderFilter("unread")}
                >
                  Unread
                </FilterChip>
                <FilterChip
                  active={folderFilter === "read"}
                  count={counts.read}
                  onClick={() => setFolderFilter("read")}
                >
                  Read
                </FilterChip>
                <FilterChip
                  active={folderFilter === "scheduled"}
                  count={counts.scheduled}
                  onClick={() => setFolderFilter("scheduled")}
                >
                  Scheduled
                </FilterChip>
              </div>
            </header>

            {error && (
              <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-[13px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto bg-background">
              {loading && items.length === 0 ? (
                <div className="divide-y divide-border/60 dark:divide-white/10">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 size-2 animate-pulse rounded-full bg-[#e6e1db] dark:bg-white/10" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="h-3 w-32 animate-pulse rounded bg-[#e6e1db] dark:bg-white/10" />
                          <div className="h-4 w-2/3 animate-pulse rounded bg-[#e6e1db] dark:bg-white/10" />
                          <div className="h-3 w-full animate-pulse rounded bg-[#f0ede6] dark:bg-white/[0.06]" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredItems.length === 0 ? (
                <EmptyList query={query} filter={folderFilter} />
              ) : (
                <div>
                  {groupedItems.map((group) => (
                    <section key={group.label}>
                      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 px-4 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-foreground/45 uppercase backdrop-blur dark:border-white/10">
                        {group.label}
                      </div>
                      <div>
                        {group.items.map((item) => (
                          <MessageRow
                            key={item.id}
                            item={item}
                            active={selectedId === item.id}
                            onOpen={() => void open(item.id)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 flex-col bg-background md:flex",
          selectedId ? "flex" : "hidden md:flex"
        )}
      >
        {!selectedId ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-border/60 bg-background text-foreground/40 dark:border-white/10 dark:bg-white/[0.04]">
                <Archive className="size-6" />
              </div>
              <p className="mt-4 text-[15px] font-medium text-foreground/75">
                Select a message to read it.
              </p>
              <p className="mt-1 text-[13px] text-foreground/55">
                Inbox threads open here like a regular email client.
              </p>
            </div>
          </div>
        ) : detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-[14px] text-foreground/55">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading message...
          </div>
        ) : detail ? (
          <>
            <header className="border-b border-border/60 bg-background dark:border-white/10">
              <div className="flex h-14 items-center gap-1 px-3 md:px-5">
                <button
                  type="button"
                  onClick={clear}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-[#f0ede6] hover:text-foreground md:hidden dark:hover:bg-white/[0.05]"
                  aria-label="Back to inbox"
                >
                  <ArrowLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void onReply(detail.id)}
                  disabled={replying}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-foreground/75 transition-colors hover:bg-[#f0ede6] hover:text-foreground disabled:pointer-events-none disabled:opacity-60 dark:hover:bg-white/[0.05]"
                >
                  {replying ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Reply className="size-4" />
                  )}
                  {replying ? "Opening..." : "Open in chat"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Delete this inbox item?",
                        destructive: true,
                        confirmLabel: "Delete",
                      })
                    ) {
                      void remove(detail.id)
                    }
                  }}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-white/[0.05]"
                  title="Delete"
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </button>
                <div className="ml-auto flex items-center gap-2 text-[12px] text-foreground/55">
                  <Clock3 className="size-4" />
                  <span className="hidden sm:inline">
                    {fullDate(
                      selectedItem
                        ? activityTime(selectedItem)
                        : detail.createdAt
                    )}
                  </span>
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto bg-background">
              <div className="mx-auto w-full max-w-[920px]">
                <div className="border-b border-border/60 bg-background px-4 py-4 md:px-6 dark:border-white/10">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-[#f0ede6] px-1.5 text-[11px] leading-5 font-medium text-foreground/70 dark:bg-white/[0.06]">
                      Scheduled run
                    </span>
                    {selectedItem && isUnread(selectedItem) ? (
                      <span className="inline-flex items-center gap-1 rounded bg-[#b76440]/10 px-1.5 text-[11px] leading-5 font-medium text-[#8b4a32] dark:text-[#d78a66]">
                        <Mail className="size-3" />
                        Unread
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 text-[11px] leading-5 font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200">
                        <CheckCircle2 className="size-3" />
                        Read
                      </span>
                    )}
                  </div>
                  <h2 className="text-[22px] leading-snug font-normal tracking-[-0.01em] text-foreground md:text-[24px]">
                    {detail.title}
                  </h2>
                </div>

                <div>
                  {threadMessages.map((message, index) => {
                    const latest = message.id === latestMessageId
                    const expanded =
                      latest || expandedMessageIds.has(message.id)
                    return expanded ? (
                      <DetailMessage
                        key={message.id}
                        message={{
                          ...message,
                          replyActions:
                            message.replyActions?.length
                              ? message.replyActions
                              : inferQuickReplyActions(message),
                        }}
                        index={index}
                        total={threadMessages.length}
                        responding={responding}
                        busyActionId={busyActionId}
                        onQuickReply={(action) =>
                          void onRespond(detail.id, action.value, action.id)
                        }
                      />
                    ) : (
                      <CollapsedDetailMessage
                        key={message.id}
                        message={message}
                        index={index}
                        onExpand={() => toggleMessageExpanded(message.id)}
                      />
                    )
                  })}
                </div>
              </div>
            </div>

            <form
              className="border-t border-border/60 bg-background px-3 py-3 md:px-6 dark:border-white/10"
              onSubmit={(event) => {
                event.preventDefault()
                void onRespond(detail.id, draft)
              }}
            >
              <div className="mx-auto w-full max-w-[920px]">
                <div className="relative w-full rounded-2xl border border-transparent bg-white shadow-[0_0_0_0.5px_rgba(93,72,57,0.42)] transition-shadow duration-200 ease-out focus-within:shadow-[0_0_0_0.5px_rgba(93,72,57,0.52)] dark:bg-card dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.22)] dark:focus-within:shadow-[0_0_0_0.5px_rgba(255,255,255,0.3)]">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={responding}
                    placeholder="Write a reply..."
                    rows={1}
                    className="max-h-40 min-h-[46px] w-full resize-none bg-transparent px-5 pt-3.5 pr-14 pb-2 text-[15px] leading-6 text-foreground outline-none placeholder:font-medium placeholder:text-foreground/55 disabled:opacity-60"
                  />
                  <div className="flex items-center justify-between px-3 pb-3">
                    <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-foreground/55">
                      <Reply className="size-3.5 shrink-0" />
                      <span className="truncate">Reply</span>
                    </div>
                    <button
                      type="submit"
                      disabled={responding || !draft.trim()}
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837]",
                        (responding || !draft.trim()) &&
                          "cursor-not-allowed opacity-50 hover:bg-[#b76440]"
                      )}
                      aria-label="Send reply"
                    >
                      {responding && !busyActionId ? (
                        <Loader2 className="size-[15px] animate-spin" />
                      ) : (
                        <ArrowUp className="size-[17px] stroke-[2.5]" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[14px] text-slate-500">
            Could not load this item.
          </div>
        )}
      </div>
    </div>
  )
}

export function InboxView() {
  return (
    <InboxProvider>
      <InboxViewInner />
    </InboxProvider>
  )
}
