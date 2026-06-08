"use client"

export const LOCAL_SUBMIT_ANCHOR_EVENT = "chat-local-submit-anchor"
export const LOCAL_SUBMIT_ANCHOR_PREFIX = "chat:localSubmitAnchor"
export const LOCAL_SUBMIT_ANCHOR_MAX_AGE_MS = 45_000

export interface LocalSubmitAnchor {
  conversationId: string
  messageId: string
  submittedAt: number
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

export function localSubmitAnchorKey(conversationId: string): string {
  return `${LOCAL_SUBMIT_ANCHOR_PREFIX}:${conversationId}`
}

export function isLocalSubmitAnchorDetail(
  value: unknown
): value is LocalSubmitAnchor {
  if (!value || typeof value !== "object") return false
  const detail = value as Partial<LocalSubmitAnchor>
  return (
    typeof detail.conversationId === "string" &&
    detail.conversationId.length > 0 &&
    typeof detail.messageId === "string" &&
    detail.messageId.length > 0 &&
    typeof detail.submittedAt === "number" &&
    Number.isFinite(detail.submittedAt)
  )
}

export function isLocalSubmitAnchorFresh(
  anchor: LocalSubmitAnchor,
  now = Date.now()
): boolean {
  return now - anchor.submittedAt <= LOCAL_SUBMIT_ANCHOR_MAX_AGE_MS
}

export function readLocalSubmitAnchor(
  conversationId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now()
): LocalSubmitAnchor | null {
  if (!storage) return null
  const key = localSubmitAnchorKey(conversationId)
  const raw = storage.getItem(key)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (
      !isLocalSubmitAnchorDetail(parsed) ||
      parsed.conversationId !== conversationId ||
      !isLocalSubmitAnchorFresh(parsed, now)
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

export function writeLocalSubmitAnchor(
  anchor: LocalSubmitAnchor,
  storage: StorageLike | null = defaultStorage()
) {
  if (!storage) return
  try {
    storage.setItem(localSubmitAnchorKey(anchor.conversationId), JSON.stringify(anchor))
  } catch {}
}

export function consumeLocalSubmitAnchor(
  conversationId: string,
  messageId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now()
): LocalSubmitAnchor | null {
  const anchor = readLocalSubmitAnchor(conversationId, storage, now)
  if (!anchor || anchor.messageId !== messageId) return null
  storage?.removeItem(localSubmitAnchorKey(conversationId))
  return anchor
}

export function publishLocalSubmitAnchor(anchor: LocalSubmitAnchor) {
  writeLocalSubmitAnchor(anchor)
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent(LOCAL_SUBMIT_ANCHOR_EVENT, {
      detail: anchor,
    })
  )
}
