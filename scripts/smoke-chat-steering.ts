import assert from "node:assert/strict"

import {
  chatReducer,
  createInitialChatState,
} from "../hooks/chat-store-reducer"
import { shouldSendAsSteering } from "../hooks/chat-store-utils"
import { findActiveInProgressAssistantMessage } from "../components/chat/chat-view-helpers"
import { clearChatStream, registerChatStream } from "../lib/chat-streams"
import type { Conversation, Message } from "../lib/types"

const conversationId = "steering_smoke_conversation"
const assistant: Message = {
  id: "assistant_active",
  role: "assistant",
  content: "Partial output",
  contentSegments: [{ phase: 0, content: "Partial output" }],
  timestamp: 1_000,
}
const followUp: Message = {
  id: "followup_user",
  role: "user",
  content: "Please adjust the direction",
  timestamp: 2_000,
}
const conversation: Conversation = {
  id: conversationId,
  title: "Steering smoke",
  messages: [assistant, followUp],
  createdAt: 1_000,
}

const initial = {
  ...createInitialChatState(false),
  conversations: [conversation],
  activeConversationId: conversationId,
}

const submitting = chatReducer(initial, {
  type: "UPSERT_PENDING_FOLLOWUP",
  conversationId,
  followUp: {
    followUpId: followUp.id,
    userMessageId: followUp.id,
    source: "user",
    queuedAt: followUp.timestamp,
    status: "submitting",
  },
})

const afterServerEcho = chatReducer(submitting, {
  type: "ADD_USER_MESSAGE",
  conversationId,
  message: { ...followUp },
})
assert.equal(afterServerEcho.pendingFollowUps[conversationId]?.length, 1)
assert.equal(
  afterServerEcho.pendingFollowUps[conversationId]?.[0]?.status,
  "submitting"
)

const queued = chatReducer(afterServerEcho, {
  type: "SYNC_PENDING_FOLLOWUPS",
  conversationId,
  followUps: [
    {
      followUpId: followUp.id,
      userMessageId: followUp.id,
      source: "user",
      queuedAt: 2_100,
    },
  ],
})
assert.equal(queued.pendingFollowUps[conversationId]?.[0]?.status, "queued")

const claimed = chatReducer(queued, {
  type: "SET_PENDING_FOLLOWUP_STATUS",
  conversationId,
  userMessageId: followUp.id,
  status: "claimed",
})
assert.equal(claimed.pendingFollowUps[conversationId]?.[0]?.status, "claimed")

const afterStaleSnapshot = chatReducer(claimed, {
  type: "SYNC_PENDING_FOLLOWUPS",
  conversationId,
  followUps: [
    {
      followUpId: followUp.id,
      userMessageId: followUp.id,
      source: "user",
      queuedAt: 2_100,
    },
  ],
})
assert.equal(
  afterStaleSnapshot.pendingFollowUps[conversationId]?.[0]?.status,
  "claimed"
)

const settled = chatReducer(afterStaleSnapshot, {
  type: "SETTLE_FIRST_CLAIMED_FOLLOWUP",
  conversationId,
})
assert.equal(settled.pendingFollowUps[conversationId], undefined)

// A pending user row after the assistant must not make the live assistant
// undiscoverable (the old last-message lookup rendered it twice).
assert.equal(
  findActiveInProgressAssistantMessage(conversation.messages, assistant.id)?.id,
  assistant.id
)

// An observed/recovered server stream is steering even without a local reader.
assert.equal(
  shouldSendAsSteering({
    targetConversationId: conversationId,
    hasInternalFollowUp: false,
    ownsStream: false,
    ownedConversationId: null,
    isStreaming: true,
    streamingConversationId: conversationId,
    activeChatStreams: {
      [conversationId]: {
        conversationId,
        messageId: assistant.id,
        startedAt: 1_000,
      },
    },
  }),
  true
)

// A concurrent start must be rejected without aborting the active controller.
const streamConversationId = `${conversationId}_${Date.now()}`
const firstController = new AbortController()
const secondController = new AbortController()
assert.equal(
  registerChatStream(streamConversationId, "assistant_first", firstController, {
    announce: false,
  }),
  true
)
assert.equal(
  registerChatStream(
    streamConversationId,
    "assistant_second",
    secondController,
    { announce: false }
  ),
  false
)
assert.equal(firstController.signal.aborted, false)
clearChatStream(streamConversationId, "assistant_first")

console.log("chat steering smoke passed")
