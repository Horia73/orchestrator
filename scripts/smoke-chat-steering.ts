import assert from "node:assert/strict"

import {
  chatReducer,
  createInitialChatState,
} from "../hooks/chat-store-reducer"
import {
  isOwnedAssistantStreamMessage,
  mergeMessagesById,
  shouldSendAsSteering,
} from "../hooks/chat-store-utils"
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

// A local reader suppresses only its exact sync echo. Assistant snapshots
// from another conversation must still land while that reader is active.
assert.equal(
  isOwnedAssistantStreamMessage({
    ownsStream: true,
    ownedConversationId: "conversation_a",
    ownedMessageId: "assistant_a",
    eventConversationId: "conversation_a",
    eventMessageId: "assistant_a",
  }),
  true
)
assert.equal(
  isOwnedAssistantStreamMessage({
    ownsStream: true,
    ownedConversationId: "conversation_a",
    ownedMessageId: "assistant_a",
    eventConversationId: "conversation_b",
    eventMessageId: "assistant_b",
  }),
  false
)

// Once the DB-backed terminal row has landed, an out-of-order progress page
// cannot roll the UI back to a lone tool summary (the refresh-only bug).
const terminal: Message = {
  id: "assistant_reconciled",
  role: "assistant",
  content: "Final answer",
  status: "ok",
  durationMs: 12_000,
  reasoning: [],
  timestamp: 20_000,
}
const staleProgress: Message = {
  id: terminal.id,
  role: "assistant",
  content: "",
  reasoning: [
    {
      type: "tool_call",
      id: "tool_list",
      phase: 0,
      toolCallId: "tool_list",
      title: "listed dir",
      content: "",
      status: "ok",
    },
  ],
  timestamp: 10_000,
}
assert.deepEqual(mergeMessagesById([terminal], [staleProgress]), [terminal])

const reconciledReducerState = chatReducer(
  {
    ...createInitialChatState(false),
    conversations: [
      {
        id: "reconciled_conversation",
        title: "Reconciled conversation",
        messages: [terminal],
        messageCount: 1,
        createdAt: terminal.timestamp,
      },
    ],
  },
  {
    type: "ADD_ASSISTANT_MESSAGE",
    conversationId: "reconciled_conversation",
    message: staleProgress,
    stopStreaming: false,
  }
)
assert.equal(
  reconciledReducerState.conversations[0]?.messages[0]?.content,
  "Final answer"
)

const historyCursor = "1000:older_message"
const historyPreserved = chatReducer(
  {
    ...createInitialChatState(false),
    conversations: [
      {
        id: "history_conversation",
        title: "History conversation",
        messages: [
          { id: "older_message", role: "user", content: "Old", timestamp: 1 },
          terminal,
        ],
        messageCount: 3,
        createdAt: 1,
      },
    ],
    conversationLoadState: { history_conversation: "loading" },
    conversationMessagePages: {
      history_conversation: {
        total: 3,
        loadedCount: 2,
        hasMore: true,
        nextCursor: historyCursor,
        isLoadingOlder: false,
      },
    },
  },
  {
    type: "LOAD_MESSAGE_PAGE_SUCCESS",
    id: "history_conversation",
    messages: [terminal],
    total: 3,
    hasMore: true,
    nextCursor: "20000:new_tail_cursor",
    mode: "replace",
  }
)
assert.equal(
  historyPreserved.conversationMessagePages.history_conversation?.nextCursor,
  historyCursor
)

const fullHistoryPreserved = chatReducer(
  {
    ...createInitialChatState(false),
    conversations: [
      {
        id: "full_history_conversation",
        title: "Full history conversation",
        messages: [
          { id: "oldest", role: "user", content: "Oldest", timestamp: 1 },
          { id: "middle", role: "assistant", content: "Middle", timestamp: 2 },
          terminal,
        ],
        messageCount: 3,
        createdAt: 1,
      },
    ],
    conversationLoadState: { full_history_conversation: "loading" },
    conversationMessagePages: {
      full_history_conversation: {
        total: 3,
        loadedCount: 3,
        hasMore: false,
        nextCursor: null,
        isLoadingOlder: false,
      },
    },
  },
  {
    type: "LOAD_MESSAGE_PAGE_SUCCESS",
    id: "full_history_conversation",
    messages: [terminal],
    total: 3,
    hasMore: true,
    nextCursor: "20000:tail_cursor",
    mode: "replace",
  }
)
assert.equal(
  fullHistoryPreserved.conversationMessagePages.full_history_conversation
    ?.hasMore,
  false
)
assert.equal(
  fullHistoryPreserved.conversationMessagePages.full_history_conversation
    ?.nextCursor,
  null
)

console.log("chat steering smoke passed")
