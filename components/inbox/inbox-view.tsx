"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Archive,
  ArrowLeft,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Inbox as InboxIcon,
  Loader2,
  Mail,
  MailOpen,
  RefreshCw,
  Reply,
  Search,
  Send,
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

type IconComponent = React.ComponentType<{ className?: string }>
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
  if (filter === "scheduled") return true
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
                ? "border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
                : destructive
                  ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.07]"
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

function FolderButton({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: IconComponent
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors",
        active
          ? "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/[0.05] dark:hover:text-white"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 text-[11px] leading-5",
          active
            ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-100"
            : "text-slate-400"
        )}
      >
        {count}
      </span>
    </button>
  )
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-md border px-3 text-[13px] font-medium transition-colors",
        active
          ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.07]"
      )}
    >
      {children}
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
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-b border-slate-200/75 px-4 py-3 text-left transition-colors focus-visible:bg-blue-50 focus-visible:outline-none dark:border-white/10 dark:focus-visible:bg-blue-500/10",
        active
          ? "bg-blue-50/85 dark:bg-blue-500/10"
          : "bg-white hover:bg-slate-50 dark:bg-transparent dark:hover:bg-white/[0.04]"
      )}
    >
      <div className="pt-1.5">
        <span
          className={cn(
            "block size-2 rounded-full",
            unread ? "bg-blue-600" : "bg-transparent"
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
        <div
          className={cn(
            "mt-1 truncate text-[14px]",
            unread
              ? "font-semibold text-slate-950 dark:text-white"
              : "font-medium text-slate-700 dark:text-slate-200"
          )}
        >
          {item.title}
        </div>
        <p className="mt-1 truncate text-[13px] leading-5 text-slate-500 dark:text-slate-400">
          {item.preview || "No preview available."}
        </p>
      </div>
      <div className="flex flex-col items-end gap-2 pt-0.5">
        <span
          className={cn(
            "text-[12px]",
            unread
              ? "font-semibold text-blue-700 dark:text-blue-300"
              : "text-slate-400"
          )}
        >
          {timeAgo(activityAt)}
        </span>
        {active && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] leading-5 font-semibold text-white">
            Open
          </span>
        )}
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
        "rounded-lg border bg-white dark:bg-white/[0.03]",
        newest
          ? "border-slate-300 shadow-sm shadow-slate-200/50 dark:border-white/15 dark:shadow-none"
          : "border-slate-200 dark:border-white/10"
      )}
    >
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-white/10">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
            assistant
              ? "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200"
              : "bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300"
          )}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-slate-900 dark:text-white">
              {sender}
            </span>
            {assistant && (
              <span className="rounded bg-slate-100 px-1.5 text-[11px] leading-5 font-medium text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
                Result
              </span>
            )}
          </div>
          <div className="truncate text-[12px] text-slate-400">
            {fullDate(message.timestamp)}
          </div>
        </div>
      </header>
      <div className="px-4 py-4 text-[14px] leading-7 text-slate-800 dark:text-slate-100">
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
      className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
          assistant
            ? "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200"
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
        <p className="mt-1 truncate text-[13px] text-slate-500 dark:text-slate-400">
          {messagePreview(message.content)}
        </p>
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
    return {
      inbox: items.length,
      unread,
      read,
      scheduled: items.length,
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
    <div className="flex h-full min-h-0 bg-slate-100/70 text-slate-950 dark:bg-background dark:text-slate-50">
      {dialog}
      <div
        className={cn(
          "min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[430px] xl:w-[620px] dark:border-white/10 dark:bg-background",
          selectedId ? "hidden md:flex" : "flex"
        )}
      >
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[188px] shrink-0 flex-col border-r border-slate-200 bg-slate-50/80 px-3 py-4 lg:flex dark:border-white/10 dark:bg-white/[0.03]">
            <div className="mb-4 flex items-center gap-2 px-1">
              <SidebarTrigger className="hidden size-8 text-slate-500 hover:text-slate-950 lg:flex dark:hover:text-white" />
              <div className="flex size-8 items-center justify-center rounded-md bg-blue-600 text-white">
                <Mail className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-slate-900 dark:text-white">
                  Mail
                </div>
                <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  Automations
                </div>
              </div>
            </div>
            <nav className="space-y-1">
              <FolderButton
                icon={InboxIcon}
                label="Inbox"
                count={counts.inbox}
                active={folderFilter === "inbox"}
                onClick={() => setFolderFilter("inbox")}
              />
              <FolderButton
                icon={Mail}
                label="Unread"
                count={counts.unread}
                active={folderFilter === "unread"}
                onClick={() => setFolderFilter("unread")}
              />
              <FolderButton
                icon={MailOpen}
                label="Read"
                count={counts.read}
                active={folderFilter === "read"}
                onClick={() => setFolderFilter("read")}
              />
              <FolderButton
                icon={CalendarClock}
                label="Scheduled"
                count={counts.scheduled}
                active={folderFilter === "scheduled"}
                onClick={() => setFolderFilter("scheduled")}
              />
            </nav>
            <div className="mt-6 border-t border-slate-200 pt-4 dark:border-white/10">
              <div className="mb-2 px-2 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
                Labels
              </div>
              <div className="space-y-1">
                <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-slate-500 dark:text-slate-400">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  Today
                </div>
                <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-slate-500 dark:text-slate-400">
                  <span className="size-2 rounded-full bg-amber-500" />
                  Follow up
                </div>
              </div>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <header className="border-b border-slate-200 bg-white px-4 pt-[calc(0.875rem+env(safe-area-inset-top))] pb-3 md:pt-4 dark:border-white/10 dark:bg-background">
              <div className="flex items-center gap-3">
                <SidebarTrigger className="-ml-1 size-10 shrink-0 text-slate-500 hover:text-slate-950 lg:hidden dark:hover:text-white" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate text-[20px] font-semibold tracking-[-0.01em] text-slate-950 dark:text-white">
                      Inbox
                    </h1>
                    {unread > 0 && (
                      <span className="shrink-0 rounded-full bg-blue-50 px-2 text-[12px] leading-6 font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                        {unread} unread
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                    Scheduled run mail, replies, and handoffs
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onRefresh()}
                  disabled={refreshing}
                  title="Refresh inbox"
                  aria-label="Refresh inbox"
                  className="flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent text-slate-500 transition-colors hover:border-slate-200 hover:bg-slate-50 hover:text-slate-950 disabled:pointer-events-none disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-white/[0.05] dark:hover:text-white"
                >
                  <RefreshCw
                    className={cn("size-4", refreshing && "animate-spin")}
                  />
                </button>
                <InboxPushButton />
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search inbox"
                    className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pr-3 pl-9 text-[14px] text-slate-900 transition-colors outline-none placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:focus:border-blue-500/40 dark:focus:bg-white/[0.06] dark:focus:ring-blue-500/10"
                  />
                </div>
              </div>

              <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5 lg:hidden">
                <FilterChip
                  active={folderFilter === "inbox"}
                  onClick={() => setFolderFilter("inbox")}
                >
                  Inbox
                </FilterChip>
                <FilterChip
                  active={folderFilter === "unread"}
                  onClick={() => setFolderFilter("unread")}
                >
                  Unread
                </FilterChip>
                <FilterChip
                  active={folderFilter === "read"}
                  onClick={() => setFolderFilter("read")}
                >
                  Read
                </FilterChip>
              </div>
            </header>

            {error && (
              <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-[13px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto bg-white dark:bg-background">
              {loading && items.length === 0 ? (
                <div className="divide-y divide-slate-200 dark:divide-white/10">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 size-2 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="h-3 w-32 animate-pulse rounded bg-slate-200 dark:bg-white/10" />
                          <div className="h-4 w-2/3 animate-pulse rounded bg-slate-200 dark:bg-white/10" />
                          <div className="h-3 w-full animate-pulse rounded bg-slate-100 dark:bg-white/[0.06]" />
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
                      <div className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 px-4 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase backdrop-blur dark:border-white/10 dark:bg-background/95">
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
          "min-w-0 flex-1 flex-col bg-slate-50 md:flex dark:bg-background",
          selectedId ? "flex" : "hidden md:flex"
        )}
      >
        {!selectedId ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <div className="mx-auto flex size-14 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400 dark:border-white/10 dark:bg-white/[0.04]">
                <Archive className="size-6" />
              </div>
              <p className="mt-4 text-[15px] font-medium text-slate-700 dark:text-slate-200">
                Select a message to read it.
              </p>
              <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
                Inbox threads open here like a regular email client.
              </p>
            </div>
          </div>
        ) : detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-[14px] text-slate-500">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading message...
          </div>
        ) : detail ? (
          <>
            <header className="border-b border-slate-200 bg-white dark:border-white/10 dark:bg-background">
              <div className="flex h-14 items-center gap-2 px-4 md:px-6">
                <button
                  type="button"
                  onClick={clear}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950 md:hidden dark:hover:bg-white/[0.05] dark:hover:text-white"
                  aria-label="Back to inbox"
                >
                  <ArrowLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void onReply(detail.id)}
                  disabled={replying}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-blue-600 px-3 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-60"
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
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:text-red-200"
                  title="Delete"
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </button>
                <div className="ml-auto flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
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

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[860px] px-4 py-6 md:px-8">
                <div className="mb-5 rounded-lg border border-slate-200 bg-white px-5 py-5 dark:border-white/10 dark:bg-white/[0.03]">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                      <CalendarClock className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-slate-100 px-1.5 text-[11px] leading-5 font-semibold text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                          Scheduled run
                        </span>
                        {selectedItem && isUnread(selectedItem) ? (
                          <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 text-[11px] leading-5 font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                            <Mail className="size-3" />
                            Unread
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 text-[11px] leading-5 font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200">
                            <CheckCircle2 className="size-3" />
                            Read
                          </span>
                        )}
                      </div>
                      <h2 className="mt-3 text-[24px] leading-tight font-semibold tracking-[-0.02em] text-slate-950 dark:text-white">
                        {detail.title}
                      </h2>
                      <div className="mt-3 grid gap-1 text-[13px] text-slate-500 sm:grid-cols-2 dark:text-slate-400">
                        <div>
                          From{" "}
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            Scheduled run
                          </span>
                        </div>
                        <div className="sm:text-right">
                          {fullDate(detail.createdAt)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  {threadMessages.map((message, index) => {
                    const latest = message.id === latestMessageId
                    const expanded =
                      latest || expandedMessageIds.has(message.id)
                    return expanded ? (
                      <DetailMessage
                        key={message.id}
                        message={message}
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
              className="border-t border-slate-200 bg-white px-4 py-3 md:px-8 dark:border-white/10 dark:bg-background"
              onSubmit={(event) => {
                event.preventDefault()
                void onRespond(detail.id, draft)
              }}
            >
              <div className="mx-auto flex w-full max-w-[860px] items-end gap-3">
                <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 focus-within:border-blue-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100 dark:border-white/10 dark:bg-white/[0.04] dark:focus-within:border-blue-500/40 dark:focus-within:bg-white/[0.06] dark:focus-within:ring-blue-500/10">
                  <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-slate-500 dark:text-slate-400">
                    <Reply className="size-3.5" />
                    Reply
                  </div>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={responding}
                    placeholder="Write a reply..."
                    className="max-h-40 min-h-14 w-full resize-none bg-transparent text-[14px] leading-6 text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60 dark:text-white"
                  />
                </div>
                <button
                  type="submit"
                  disabled={responding || !draft.trim()}
                  className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-blue-600 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50"
                >
                  {responding && !busyActionId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Send
                </button>
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
