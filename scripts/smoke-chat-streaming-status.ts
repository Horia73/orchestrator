import assert from "node:assert/strict"

import { chatReducer, type ChatState } from "../hooks/chat-store-reducer"
import {
  agentCallEntryFromStartEvent,
  stoppedStreamState,
} from "../hooks/chat-store-utils"
import { agentFullLabel } from "../lib/agent-label"
import type { Message } from "../lib/types"

const baseState: ChatState = {
  conversations: [],
  isLoading: false,
  activeChatStreams: {},
  pendingFollowUps: {},
  conversationLoadState: {},
  conversationLoadErrors: {},
  conversationMessagePages: {},
  activeConversationId: "conversation_a",
  ...stoppedStreamState,
}

const connecting = chatReducer(baseState, {
  type: "SET_STREAMING",
  isStreaming: true,
  conversationId: "conversation_a",
  messageId: "assistant_1",
  status: "connecting",
})

assert.equal(connecting.isStreaming, true)
assert.equal(connecting.streamingConversationId, "conversation_a")
assert.equal(connecting.streamingMessageId, "assistant_1")
assert.equal(connecting.streamingStatus, "connecting")

const recovering = chatReducer(connecting, {
  type: "SET_STREAMING",
  isStreaming: true,
  conversationId: "conversation_a",
  messageId: "assistant_1",
  status: "recovering",
})

assert.equal(recovering.streamingStatus, "recovering")

const withContent = chatReducer(recovering, {
  type: "APPEND_STREAMING_CONTENT",
  chunk: "Hello",
  phase: 0,
})

assert.equal(withContent.streamingStatus, null)
assert.equal(withContent.streamingMode, "content")
assert.equal(withContent.streamingContent, "Hello")

const snapshot: Message = {
  id: "assistant_1",
  role: "assistant",
  content: "Recovered",
  contentSegments: [{ phase: 0, content: "Recovered" }],
  timestamp: 2_000,
}

const withSnapshot = chatReducer(recovering, {
  type: "SET_STREAMING",
  isStreaming: true,
  conversationId: "conversation_a",
  messageId: "assistant_1",
  snapshot,
  status: "recovering",
})

assert.equal(withSnapshot.streamingStatus, null)
assert.equal(withSnapshot.streamingContent, "Recovered")
assert.equal(withSnapshot.streamingMode, "content")

const stopped = chatReducer(withSnapshot, {
  type: "SET_STREAMING",
  isStreaming: false,
})

assert.equal(stopped.streamingStatus, null)
assert.equal(stopped.isStreaming, false)

const liveAgentStart = agentCallEntryFromStartEvent(
  {
    type: "agent_start",
    runId: "run_lena",
    agentId: "researcher",
    agentName: "Researcher",
    assignedName: "Lena",
    taskLabel: "Romania B2B cold email legality",
    kind: "text",
    prompt: "Check Romanian B2B cold email rules.",
    async: true,
    startedAt: 3_000,
  },
  1
)

assert.ok(liveAgentStart)
assert.equal(liveAgentStart.assignedName, "Lena")
assert.equal(liveAgentStart.taskLabel, "Romania B2B cold email legality")
assert.equal(liveAgentStart.async, true)
assert.equal(
  agentFullLabel(liveAgentStart),
  "Researcher Lena (Romania B2B cold email legality)"
)

console.log("chat streaming status smoke passed")
