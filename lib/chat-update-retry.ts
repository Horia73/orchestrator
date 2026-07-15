"use client"

import type { Message } from "@/lib/types"

const PENDING_CHAT_UPDATE_TURN_PREFIX = "chat:pending-update-turn:v2"
export const PENDING_CHAT_UPDATE_TURN_MAX_AGE_MS = 2 * 60 * 60_000

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">

export interface PendingChatUpdateTurn {
  version: 2
  profileId: string
  conversationId: string
  assistantMessageId: string
  messages: Message[]
  promptContext?: string
  promptContextSource?: string
  activateIntegrations?: string[]
  preferredFallbackIndex?: number
  queuedAt: number
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function pendingTurnKey(profileId: string): string {
  return `${PENDING_CHAT_UPDATE_TURN_PREFIX}:${encodeURIComponent(profileId)}`
}

export function isPendingChatUpdateStorageKey(key: string | null): boolean {
  return Boolean(key?.startsWith(`${PENDING_CHAT_UPDATE_TURN_PREFIX}:`))
}

export async function fetchCurrentChatProfileId(): Promise<string | null> {
  try {
    const response = await fetch("/api/profiles/current", { cache: "no-store" })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => ({}))) as {
      profile?: { id?: unknown }
    }
    return typeof payload.profile?.id === "string" ? payload.profile.id : null
  } catch {
    return null
  }
}

function retryMessage(message: Message): Message {
  return {
    id: message.id,
    role: "user",
    content: message.content,
    attachments: message.attachments,
    timestamp: message.timestamp,
  }
}

/** Keep only the unanswered user suffix. Persisted conversation history is
 *  merged back in by /api/chat, so a refresh marker stays small. */
export function pendingChatUpdateMessages(messages: Message[]): Message[] {
  let lastAssistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index
      break
    }
  }
  const suffix = messages
    .slice(lastAssistantIndex + 1)
    .filter((message) => message.role === "user")
    .map(retryMessage)
  if (suffix.length > 0) return suffix

  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user")
  return latestUser ? [retryMessage(latestUser)] : []
}

function isPendingChatUpdateTurn(
  value: unknown
): value is PendingChatUpdateTurn {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<PendingChatUpdateTurn>
  return (
    candidate.version === 2 &&
    typeof candidate.profileId === "string" &&
    candidate.profileId.length > 0 &&
    typeof candidate.conversationId === "string" &&
    candidate.conversationId.length > 0 &&
    typeof candidate.assistantMessageId === "string" &&
    candidate.assistantMessageId.length > 0 &&
    typeof candidate.queuedAt === "number" &&
    Number.isFinite(candidate.queuedAt) &&
    Array.isArray(candidate.messages) &&
    candidate.messages.length > 0 &&
    candidate.messages.every(
      (message) =>
        Boolean(message) &&
        message.role === "user" &&
        typeof message.id === "string" &&
        message.id.length > 0 &&
        typeof message.content === "string" &&
        typeof message.timestamp === "number" &&
        Number.isFinite(message.timestamp)
    )
  )
}

export function writePendingChatUpdateTurn(
  turn: Omit<PendingChatUpdateTurn, "version" | "messages" | "queuedAt"> & {
    messages: Message[]
    queuedAt?: number
  },
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false
  const messages = pendingChatUpdateMessages(turn.messages)
  if (messages.length === 0) return false
  const pending: PendingChatUpdateTurn = {
    ...turn,
    version: 2,
    messages,
    queuedAt: turn.queuedAt ?? Date.now(),
  }
  try {
    storage.setItem(pendingTurnKey(pending.profileId), JSON.stringify(pending))
    return true
  } catch {
    return false
  }
}

export function readPendingChatUpdateTurn(
  profileId: string,
  storage: StorageLike | null = defaultStorage(),
  now = Date.now()
): PendingChatUpdateTurn | null {
  if (!storage) return null
  const key = pendingTurnKey(profileId)
  const raw = storage.getItem(key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isPendingChatUpdateTurn(parsed) ||
      parsed.profileId !== profileId ||
      now - parsed.queuedAt > PENDING_CHAT_UPDATE_TURN_MAX_AGE_MS
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

export function clearPendingChatUpdateTurn(
  profileId: string,
  expected?: {
    conversationId?: string | null
    assistantMessageId?: string | null
  },
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false
  if (expected?.conversationId || expected?.assistantMessageId) {
    const pending = readPendingChatUpdateTurn(profileId, storage)
    if (!pending) return false
    if (
      expected.conversationId &&
      pending.conversationId !== expected.conversationId
    ) {
      return false
    }
    if (
      expected.assistantMessageId &&
      pending.assistantMessageId !== expected.assistantMessageId
    ) {
      return false
    }
  }
  try {
    storage.removeItem(pendingTurnKey(profileId))
    return true
  } catch {
    return false
  }
}
