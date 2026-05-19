import type { AgentKind, AgentRunStatus } from "@/lib/ai/agents/types"

export interface Attachment {
  /** Unique ID (same as the filename on disk, e.g. "abc123.pdf") */
  id: string
  /** Original file name */
  filename: string
  /** MIME type */
  mimeType: string
  /** File size in bytes */
  size: number
  /** Category for display/routing */
  type: "image" | "pdf" | "document" | "audio" | "video" | "other"
}

export interface TokenUsageBreakdown {
  totalTokens?: number | null
  inputTokens?: number | null
  cachedInputTokens?: number | null
  outputTokens?: number | null
  reasoningOutputTokens?: number | null
}

export interface ContextUsageSnapshot {
  provider: string
  model: string
  source: "provider-live" | "provider-final" | "estimated"
  accuracy: "live" | "actual" | "estimated"
  updatedAt: number
  requestId?: string
  interactionId?: string
  threadId?: string
  turnId?: string
  contextWindow?: number | null
  contextTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  thinkingTokens?: number | null
  cachedTokens?: number | null
  totalTokens?: number | null
  threadTokens?: number | null
  last?: TokenUsageBreakdown | null
  total?: TokenUsageBreakdown | null
  lastCompactedAt?: number | null
  compactedCount?: number
}

export interface ThoughtReasoningEntry {
  type: "thought"
  /** Stable item id (used as React key and persistence merge key). */
  id: string
  /** Reasoning phase index; increments when model starts emitting content. */
  phase: number
  content: string
}

export interface ContextCompactionReasoningEntry {
  type: "context_compaction"
  /** Stable item id (used as React key and persistence merge key). */
  id: string
  /** Reasoning phase index; increments when model starts emitting content. */
  phase: number
  title: string
  at: number
}

export interface ToolStreamDelta {
  stream: "stdout" | "stderr" | "pty" | "message"
  text: string
  timestamp?: number
}

export interface ToolCallReasoningEntry {
  type: "tool_call"
  /** Stable item id (used as React key and persistence merge key). */
  id: string
  /** Reasoning phase index; increments when model starts emitting content. */
  phase: number
  toolCallId: string
  /** Display title (e.g. "Read lib/foo.ts"). */
  title: string
  /** Stringified result data (or "Error: ..." on failure). */
  content: string
  /** Machine tool name emitted by the provider (e.g. "read_file"). Used for routing previews. */
  toolName?: string
  /** Tool arguments — used by the preview panel for re-rendering. */
  args?: Record<string, unknown>
  /** Whether the tool call returned successfully. */
  success?: boolean
  status?: "running" | "ok" | "error"
  startedAt?: number
  endedAt?: number
  deltas?: ToolStreamDelta[]
}

export interface ContentSegment {
  /** Content phase index aligned with reasoning phase order. */
  phase: number
  content: string
}

export type MessageStatus = "ok" | "error" | "aborted"

export interface AgentCallReasoningEntry {
  type: "agent_call"
  /** Stable item id (used as React key and persistence merge key). */
  id: string
  /** Reasoning phase index aligned with the parent message. */
  phase: number
  /** Provider tool-call id that launched this agent, when there is one. */
  toolCallId?: string
  /** Agent run id emitted by the runner. */
  runId: string
  /** Persistent parent↔agent thread id, when this run continues one. */
  agentThreadId?: string
  /** Parent agent run id when this is a nested sub-agent. */
  parentRunId?: string
  agentId: string
  agentName: string
  kind: AgentKind
  title: string
  prompt: string
  status: AgentRunStatus
  startedAt: number
  endedAt?: number
  content: string
  contentSegments?: ContentSegment[]
  reasoning?: ReasoningEntry[]
  attachments?: Attachment[]
  error?: string
  thinkingDuration?: number
}

export type ReasoningEntry =
  | ThoughtReasoningEntry
  | ToolCallReasoningEntry
  | AgentCallReasoningEntry
  | ContextCompactionReasoningEntry

export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  /** Terminal status for assistant messages; absent while progress is still streaming. */
  status?: MessageStatus
  contentSegments?: ContentSegment[]
  reasoning?: ReasoningEntry[]
  thinking?: string
  thinkingDuration?: number
  toolCalls?: { text: string; content: string }[]
  attachments?: Attachment[]
  timestamp: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  contextUsage?: ContextUsageSnapshot
  updatedAt?: number
  messageCount?: number
  lastMessagePreview?: string
  lastMessageAt?: number
  searchMatchPreview?: string
}
