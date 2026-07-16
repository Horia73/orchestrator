import assert from "node:assert/strict"

import {
  completedAssistantMessage,
  erroredAssistantMessage,
  stoppedAssistantMessage,
} from "../hooks/chat-stream-messages"
import { deriveUnreadConversationIds } from "../hooks/chat-store-utils"
import type { Conversation } from "../lib/types"

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

console.log("chat stream terminal messages smoke passed")
