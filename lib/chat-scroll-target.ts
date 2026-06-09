"use client"

// A "jump to this message" request, published when a deep-link
// (`/?chat=<id>&msg=<messageId>`, e.g. Library → "View in chat") wants the
// chat view to scroll to and highlight a specific message once it has opened
// the conversation. Mirrors lib/chat-local-submit-anchor.ts: the request is
// both dispatched as a CustomEvent (for an already-mounted ChatView) AND
// persisted to sessionStorage (so it survives the /library → / navigation and
// the fresh ChatView mount that follows).

export const CHAT_SCROLL_TARGET_EVENT = "chat-scroll-target"
export const CHAT_SCROLL_TARGET_PREFIX = "chat:scrollTarget"
export const CHAT_SCROLL_TARGET_MAX_AGE_MS = 60_000

export interface ChatScrollTarget {
  conversationId: string
  messageId: string
  requestedAt: number
}

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function chatScrollTargetKey(conversationId: string): string {
  return `${CHAT_SCROLL_TARGET_PREFIX}:${conversationId}`
}

export function isChatScrollTargetDetail(
  value: unknown
): value is ChatScrollTarget {
  if (!value || typeof value !== "object") return false
  const detail = value as Partial<ChatScrollTarget>
  return (
    typeof detail.conversationId === "string" &&
    detail.conversationId.length > 0 &&
    typeof detail.messageId === "string" &&
    detail.messageId.length > 0 &&
    typeof detail.requestedAt === "number" &&
    Number.isFinite(detail.requestedAt)
  )
}

export function isChatScrollTargetFresh(
  target: ChatScrollTarget,
  now = Date.now()
): boolean {
  return now - target.requestedAt <= CHAT_SCROLL_TARGET_MAX_AGE_MS
}

export function readChatScrollTarget(
  conversationId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now()
): ChatScrollTarget | null {
  if (!storage) return null
  const key = chatScrollTargetKey(conversationId)
  const raw = storage.getItem(key)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (
      !isChatScrollTargetDetail(parsed) ||
      parsed.conversationId !== conversationId ||
      !isChatScrollTargetFresh(parsed, now)
    ) {
      storage.removeItem(key)
      return null
    }
    return parsed
  } catch {
    storage.removeItem(key)
    return null
  }
}

export function writeChatScrollTarget(
  target: ChatScrollTarget,
  storage: StorageLike | null = defaultStorage()
) {
  if (!storage) return
  try {
    storage.setItem(
      chatScrollTargetKey(target.conversationId),
      JSON.stringify(target)
    )
  } catch {}
}

export function consumeChatScrollTarget(
  conversationId: string,
  messageId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now()
): ChatScrollTarget | null {
  const target = readChatScrollTarget(conversationId, storage, now)
  if (!target || target.messageId !== messageId) return null
  storage?.removeItem(chatScrollTargetKey(conversationId))
  return target
}

export function clearChatScrollTarget(
  conversationId: string,
  storage: StorageLike | null = defaultStorage()
) {
  storage?.removeItem(chatScrollTargetKey(conversationId))
}

export function publishChatScrollTarget(target: ChatScrollTarget) {
  writeChatScrollTarget(target)
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent(CHAT_SCROLL_TARGET_EVENT, {
      detail: target,
    })
  )
}
