"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  Bell,
  Inbox as InboxIcon,
  Loader2,
  Reply,
  Send,
  Trash2,
} from "lucide-react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { useChatStore } from "@/hooks/use-chat-store"
import { useInboxPushNotifications } from "@/hooks/use-inbox-push-notifications"
import { cn } from "@/lib/utils"
import type { InboxReplyAction, ReasoningEntry } from "@/lib/types"
import { InboxProvider, useInbox } from "./use-inbox"

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ms).toLocaleDateString()
}

function TraceSummary({ reasoning }: { reasoning: ReasoningEntry[] }) {
  const steps = reasoning.filter(
    (r): r is Extract<ReasoningEntry, { type: "tool_call" | "agent_call" }> =>
      r.type === "tool_call" || r.type === "agent_call"
  )
  if (steps.length === 0) return null
  return (
    <details className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-[12px] text-foreground/55">
      <summary className="cursor-pointer select-none">
        {steps.length} step{steps.length > 1 ? "s" : ""}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 rounded-full",
                s.status === "error"
                  ? "bg-[#802020]"
                  : s.status === "ok"
                    ? "bg-emerald-500"
                    : "bg-foreground/30"
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
    <div className="mt-3 flex flex-wrap gap-2">
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
              "min-h-8 max-w-full rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
              primary
                ? "bg-foreground text-background hover:opacity-90"
                : destructive
                  ? "border border-red-200 bg-red-50 text-[#802020] hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
                  : "border border-border/70 bg-muted/35 text-foreground/75 hover:bg-muted"
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
        "flex size-9 shrink-0 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-[#f0ede6] hover:text-foreground disabled:pointer-events-none disabled:opacity-45 dark:hover:bg-muted",
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

function InboxViewInner() {
  const {
    items,
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
  } = useInbox()
  const { selectConversation } = useChatStore()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { confirm, dialog } = useConfirm()
  const [replying, setReplying] = React.useState(false)
  const [responding, setResponding] = React.useState(false)
  const [busyActionId, setBusyActionId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState("")

  React.useEffect(() => {
    const id = searchParams.get("item")
    if (id && id !== selectedId) void open(id)
  }, [open, searchParams, selectedId])

  const onReply = async (id: string) => {
    setReplying(true)
    const conversationId = await reply(id)
    setReplying(false)
    if (conversationId) {
      selectConversation(conversationId)
      router.push("/")
    }
  }

  const onRespond = async (
    id: string,
    content: string,
    actionId?: string
  ) => {
    if (!content.trim() || responding) return
    setResponding(true)
    setBusyActionId(actionId ?? null)
    const ok = await respond(id, content)
    setResponding(false)
    setBusyActionId(null)
    if (ok && !actionId) setDraft("")
  }

  React.useEffect(() => {
    setDraft("")
    setBusyActionId(null)
    setResponding(false)
  }, [selectedId])

  return (
    <div className="flex h-full min-h-0">
      {dialog}
      {/* List */}
      <div
        className={cn(
          "min-h-0 w-full shrink-0 flex-col border-r border-border/60 md:flex md:w-[320px]",
          selectedId ? "hidden md:flex" : "flex"
        )}
      >
        <header className="flex items-start justify-between gap-2 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-4 md:px-5 md:pt-4">
          <div className="flex min-w-0 items-start gap-2">
            <SidebarTrigger className="-ml-1 size-10 shrink-0 text-foreground/55 hover:text-foreground md:hidden" />
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-[18px] font-semibold">
                <InboxIcon className="size-5 text-foreground/60" /> Inbox
              </h1>
              <p className="mt-0.5 text-[12px] text-foreground/50">
                Scheduled run results · reply inline
              </p>
            </div>
          </div>
          <InboxPushButton />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {error && (
            <div className="mx-2 rounded-md bg-red-50 px-3 py-2 text-[12px] text-[#802020]">
              {error}
            </div>
          )}
          {loading && items.length === 0 ? (
            <div className="space-y-2 px-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-16 animate-pulse rounded-lg bg-muted/50"
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-foreground/45">
              No scheduled results yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((it) => {
                const isUnread = it.readAt == null
                return (
                  <li key={it.id}>
                    <button
                      onClick={() => void open(it.id)}
                      className={cn(
                        "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                        selectedId === it.id
                          ? "bg-[#f0ede6] dark:bg-muted"
                          : "hover:bg-[#f0ede6]/60 dark:hover:bg-muted/60"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {isUnread && (
                          <span className="size-2 shrink-0 rounded-full bg-[#802020]" />
                        )}
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[14px]",
                            isUnread ? "font-semibold" : "text-foreground/75"
                          )}
                        >
                          {it.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-foreground/40">
                          {timeAgo(it.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-foreground/45">
                        {it.preview || "—"}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Detail */}
      <div
        className={cn(
          "min-w-0 flex-1 flex-col md:flex",
          selectedId ? "flex" : "hidden md:flex"
        )}
      >
        {!selectedId ? (
          <div className="flex h-full items-center justify-center text-[14px] text-foreground/40">
            Select an item to read it.
          </div>
        ) : detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-[14px] text-foreground/40">
            Loading…
          </div>
        ) : detail ? (
          <>
            <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
              <button
                onClick={clear}
                className="rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
              >
                <ArrowLeft className="size-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-semibold">
                  {detail.title}
                </div>
                <div className="text-[12px] text-foreground/45">
                  {new Date(detail.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => void onReply(detail.id)}
                  disabled={replying}
                  className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[13px] text-background hover:opacity-90 disabled:opacity-60"
                >
                  <Reply className="size-3.5" />{" "}
                  {replying ? "Opening…" : "Open in chat"}
                </button>
                <button
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
                  className="rounded-md p-2 text-[#802020] hover:bg-red-50"
                  title="Delete"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="mx-auto max-w-2xl space-y-5">
                {detail.messages.map((m) => (
                  <div key={m.id}>
                    <div className="mb-1 text-[11px] font-medium tracking-wide text-foreground/40 uppercase">
                      {m.role === "user" ? "Trigger" : "Result"}
                    </div>
                    <div className="rounded-xl border border-border/50 bg-background px-4 py-3 text-[14px] leading-relaxed">
                      <MarkdownRenderer content={m.content} />
                      {m.role === "assistant" && (
                        <QuickReplyActions
                          actions={m.replyActions}
                          disabled={responding}
                          busyActionId={busyActionId}
                          onSelect={(action) =>
                            void onRespond(detail.id, action.value, action.id)
                          }
                        />
                      )}
                      {m.reasoning && m.reasoning.length > 0 && (
                        <TraceSummary reasoning={m.reasoning} />
                      )}
                    </div>
                  </div>
                ))}
                <form
                  className="rounded-xl border border-border/60 bg-muted/20 p-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void onRespond(detail.id, draft)
                  }}
                >
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={responding}
                    placeholder="Reply in this inbox item..."
                    className="min-h-20 w-full resize-none rounded-md border border-border/60 bg-background px-3 py-2 text-[14px] leading-relaxed outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-60"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="min-w-0 text-[12px] text-foreground/45">
                      Replies stay in this Inbox thread.
                    </p>
                    <button
                      type="submit"
                      disabled={responding || !draft.trim()}
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
                    >
                      {responding && !busyActionId ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Send className="size-3.5" />
                      )}
                      Send
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[14px] text-foreground/40">
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
