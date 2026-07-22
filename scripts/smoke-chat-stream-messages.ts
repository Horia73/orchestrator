import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { MessageChannel } from "node:worker_threads"
import { runInNewContext } from "node:vm"

import {
  completedAssistantMessage,
  erroredAssistantMessage,
  stoppedAssistantMessage,
} from "../hooks/chat-stream-messages"
import {
  deriveUnreadConversationIds,
  isAssistantCompletionUnread,
} from "../hooks/chat-store-utils"
import type { Conversation, Message } from "../lib/types"

const snapshot = {
  messageId: "assistant-1",
  content: "partial",
  contentSegments: [{ phase: 0, content: "partial" }],
  reasoning: [],
  thinking: "thought",
  thinkingDuration: 3,
  attachments: [],
}

const completed = completedAssistantMessage(
  { durationMs: 42, thinkingDuration: 5 },
  snapshot,
  100
)
assert.equal(completed.status, "ok")
assert.equal(completed.durationMs, 42)
assert.equal(completed.thinkingDuration, 5)

const stopped = stoppedAssistantMessage({}, snapshot, 101)
assert.equal(stopped.status, "aborted")
assert.equal(stopped.timestamp, 101)

const failed = erroredAssistantMessage(
  { error: "provider failed" },
  snapshot,
  102
)
assert.equal(failed.error, "provider failed")
assert.equal(failed.message.status, "error")
assert.match(failed.message.content, /partial\n\n\[Error: provider failed\]/)

const persisted = {
  id: "assistant-1",
  role: "assistant" as const,
  content: "server copy",
  timestamp: 99,
}
assert.equal(
  completedAssistantMessage({ message: persisted }, snapshot).content,
  "server copy"
)
assert.notEqual(
  completedAssistantMessage(
    { message: { ...persisted, id: "wrong" } },
    snapshot,
    103
  ).content,
  "server copy"
)

const backgroundCompletion: Conversation = {
  id: "background-completion",
  title: "Background completion",
  messages: [],
  createdAt: 50,
  lastMessageAt: 200,
  readAt: 100,
  messageCount: 2,
}
assert.equal(
  deriveUnreadConversationIds([backgroundCompletion]).has(
    backgroundCompletion.id
  ),
  true,
  "a completion newer than readAt stays unread until an explicit open"
)
assert.equal(
  deriveUnreadConversationIds([
    { ...backgroundCompletion, readAt: backgroundCompletion.lastMessageAt },
  ]).has(backgroundCompletion.id),
  false,
  "opening the conversation clears unread once readAt reaches the completion"
)

const terminalMessage: Message = {
  id: "assistant-terminal",
  role: "assistant",
  content: "done",
  status: "ok",
  timestamp: 300,
}
assert.equal(
  isAssistantCompletionUnread(
    { ...backgroundCompletion, readAt: terminalMessage.timestamp },
    terminalMessage
  ),
  false,
  "a late terminal SSE frame cannot restore unread after another device read it"
)
assert.equal(
  isAssistantCompletionUnread(
    { ...backgroundCompletion, readAt: terminalMessage.timestamp - 1 },
    terminalMessage
  ),
  true,
  "a terminal frame newer than the read watermark remains unread"
)

// Reproduce the installed-macOS PWA case where WindowClient.focused is false
// even though the page itself reports that the exact conversation is focused.
const serviceWorkerHandlers = new Map<
  string,
  (event: {
    data?: { json(): unknown }
    waitUntil?(work: Promise<unknown>): void
  }) => void
>()
const shownNotifications: Array<{ title: string; options: unknown }> = []
let pagePresence = { active: true, visible: true, focused: true }
const pageClient = {
  url: "https://orchestrator.example/",
  focused: false,
  postMessage(
    message: { type?: unknown; chatId?: unknown; requestId?: unknown },
    ports: Array<{ postMessage(value: unknown): void; close(): void }>
  ) {
    const port = ports[0]
    if (!port || message.type !== "orchestrator:chat-presence-probe") return
    port.postMessage({
      type: "orchestrator:chat-presence-state",
      requestId: message.requestId,
      chatId: message.chatId,
      ...pagePresence,
    })
    port.close()
  },
}
const serviceWorkerSelf = {
  location: { origin: "https://orchestrator.example" },
  clients: {
    matchAll: async () => [pageClient],
    claim: async () => undefined,
  },
  registration: {
    showNotification: async (title: string, options: unknown) => {
      shownNotifications.push({ title, options })
    },
  },
  addEventListener(
    type: string,
    handler: (event: {
      data?: { json(): unknown }
      waitUntil?(work: Promise<unknown>): void
    }) => void
  ) {
    serviceWorkerHandlers.set(type, handler)
  },
  skipWaiting: async () => undefined,
  setTimeout,
  clearTimeout,
}
runInNewContext(readFileSync("public/sw.js", "utf8"), {
  self: serviceWorkerSelf,
  URL,
  MessageChannel,
  Uint8Array,
  Promise,
  Date,
  Math,
})

const pushHandler = serviceWorkerHandlers.get("push")
assert.ok(pushHandler, "service worker push handler should be registered")

async function dispatchChatPush(chatId: string) {
  let work: Promise<unknown> | null = null
  pushHandler!({
    data: {
      json: () => ({
        type: "chat",
        chatId,
        title: "Chat finished",
        body: "Done",
        url: `/?chat=${chatId}`,
      }),
    },
    waitUntil: (next) => {
      work = next
    },
  })
  assert.ok(work, "push handler should register async work")
  await work
}

await dispatchChatPush("conversation-open-on-mac")
assert.equal(
  shownNotifications.length,
  0,
  "the exact focused conversation suppresses its redundant completion push"
)

pagePresence = { active: false, visible: true, focused: true }
await dispatchChatPush("different-conversation")
assert.equal(
  shownNotifications.length,
  1,
  "a completion for a conversation that is not open still shows a push"
)

console.log("chat stream terminal messages smoke passed")
