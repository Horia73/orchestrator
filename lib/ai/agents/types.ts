import type { ModelFeatureValue, ThinkingLevel } from "@/lib/config"
import type {
  Attachment,
  ContentSegment,
  ContextUsageSnapshot,
  ReasoningEntry,
} from "@/lib/types"

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

export interface ToolParameter {
  type: string
  description?: string
  properties?: Record<string, ToolParameter>
  items?: ToolParameter
  anyOf?: ToolParameter[]
  required?: string[]
  enum?: string[]
}

export interface ToolDef {
  /** Unique tool identifier */
  id: string
  /** Human-readable name (sent to the model) */
  name: string
  description: string
  /** JSON Schema describing the tool's input. Providers map it to their wire format internally. */
  input_schema: ToolParameter
  /** Tags for permission grouping, e.g. ["read", "write", "web"] */
  tags: string[]
}

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
}

export interface ToolStreamDelta {
  stream: "stdout" | "stderr" | "pty" | "message"
  text: string
  timestamp?: number
}

/**
 * Per-call context passed to tool executors. Most tools ignore it; the
 * delegation tool reads it to enforce the depth cap, validate the caller's
 * `canCallAgents` list, and tag sub-agent logs with the parent request id.
 */
export interface ToolExecutionContext {
  /** Agent that emitted this tool call (the orchestrator on depth 0). */
  callerAgentId: string
  /** 0 for the user-facing turn, 1 or 2 for sub-agents. */
  depth: number
  /** Conversation that owns this turn. Sub-agent logs share the conversation. */
  conversationId: string
  /** Persistent parent↔agent thread for this agent run, if this call is inside one. */
  agentThreadId?: string
  /** request_logs.id of the caller — sub-agent rows reference it via parentRequestId. */
  parentRequestId: string
  /** Aborts cascade from the original request. */
  signal?: AbortSignal
  /** Tool-call id that caused this tool execution, when known. */
  currentToolCallId?: string
  /** Parent agent run id for nested-agent UI. */
  parentAgentRunId?: string
  /** Emits agent-run lifecycle/transcript events to the chat route. */
  onAgentEvent?: (event: AgentRunEvent) => void | Promise<void>
  /** Emits live tool output before the final tool result is available. */
  onToolDelta?: (
    toolCallId: string,
    toolName: string,
    delta: ToolStreamDelta
  ) => void | Promise<void>
  /** Origin of the running Orchestrator app, used by sub-agents/runbooks for local API calls. */
  appOrigin?: string
  /** Present when a tool call is made from inside a scheduled task run. */
  scheduledTaskId?: string
  /** Scheduled-run fire time (epoch ms) that woke the current agent. */
  scheduledFiredAt?: number
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/**
 * What kind of work an agent does. The chat route picks a different code path
 * per kind — text streams chunks, image/video/speech run as one-shot generation
 * jobs (video is async-polled, others sync).
 */
export type AgentKind =
  | "text"
  | "image"
  | "video"
  | "speech"
  | "music"
  | "concierge"
  | "phone"
  | "android"
export type AgentStatus = "active" | "planned"

/**
 * Surfacing tier for the settings UI. `primary` agents are the user-facing
 * roster the orchestrator delegates to and that the user reorders; `system`
 * agents are internal/background workers the runtime invokes on its own
 * (titling, audio pre-processing, monitors). Unset means `primary`.
 */
export type AgentTier = "primary" | "system"

/** Native built-ins the underlying provider can run without our custom tool executors. */
export type ProviderBuiltin =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "todo_write"
  | "code_execution"
  | "url_context"
  | "file_search"

export interface AgentConfig {
  /** Unique agent identifier */
  id: string
  /** Display name */
  name: string
  /** Short description — visible to parent agents when deciding who to delegate to */
  description: string
  /** What kind of generation this agent performs */
  kind: AgentKind
  /** Planned agents appear in settings but are not runtime-ready yet. */
  status?: AgentStatus
  /** Settings surfacing tier. Unset means `primary` (user-facing roster). */
  tier?: AgentTier
  /** System prompt builder — receives runtime context, returns the prompt string. Optional for non-text agents. */
  buildPrompt?: (ctx: PromptContext) => string
  /** Provider id. Falls back to runtime/global settings if unset. */
  provider?: string
  /** Model id within that provider. Falls back to global default if unset. */
  model?: string
  /** Tool IDs this agent is allowed to invoke (custom tools) */
  tools: string[]
  /** Native provider built-ins this agent enables (web_search, code_execution, ...) */
  builtins?: ProviderBuiltin[]
  /** Agent IDs this agent can spawn as sub-agents (if depth allows) */
  canCallAgents?: string[]
  /** Override thinking level */
  thinkingLevel?: ThinkingLevel
}

/**
 * Hard cap on how deep an agent call tree can go. Orchestrator is depth 0;
 * agents it calls are depth 1; their sub-agents are depth 2 (last allowed).
 * Set globally so behaviour is predictable; per-agent overrides would
 * complicate planning without clear benefit.
 */
export const MAX_AGENT_DEPTH = 2

export interface PromptContext {
  /** Agent receiving this prompt. Used for scoped runtime context such as child thread lists. */
  agentId?: string
  userName: string
  assistantName: string
  /** List of tool definitions available to this agent */
  availableTools: ToolDef[]
  /** Native provider built-ins enabled for this agent (web_search, file_search, etc.). */
  availableBuiltins?: ProviderBuiltin[]
  /**
   * Prefix the active provider exposes the custom tools above under (see
   * ProviderCapabilities.customToolNamePrefix). When set, the runtime_tools
   * block renders each tool by its real callable name (`<prefix><id>`) and
   * states the bare→prefixed mapping, so a tool the prompt names without the
   * prefix elsewhere (e.g. `set_task_state`) is still called correctly.
   * Undefined for providers that expose custom tools by their bare name.
   */
  customToolNamePrefix?: string
  /** List of agent configs this agent can delegate to */
  availableAgents: AgentConfig[]
  /** Conversation this prompt is built for. Drives per-conversation integration activation. */
  conversationId?: string
  /** Persistent parent↔agent thread for the receiving agent, if any. */
  agentThreadId?: string
  /**
   * The agent's full static tool grant (before runtime integration gating).
   * Used to render the <integrations> scope block; the gated set lives in
   * `availableTools`.
   */
  declaredToolIds?: string[]
  /**
   * The agent's full static tool grant resolved to ToolDefs (before gating).
   * Used to build the gated-capability tool menus in <integrations>/<subsystems>
   * from each tool's own description. Passed by the caller so the prompt layer
   * needn't import the tool registry (avoids a module-init cycle).
   */
  declaredTools?: ToolDef[]
  /** Depth of the agent receiving this prompt. Orchestrator = 0. */
  delegationDepth?: number
  /** Hard delegation depth cap (MAX_AGENT_DEPTH). Surfaced so the agent can plan within budget. */
  maxDelegationDepth?: number
  /**
   * Pending self-update info. Set by the chat route when a newer release is
   * available so the orchestrator prompt can render a <pending_update>
   * runtime block and invite the user to apply it. Filtered to orchestrator
   * only inside buildRuntimeContext.
   */
  pendingUpdate?: {
    currentVersion: string
    targetVersion: string
    targetTag: string
    releaseName?: string | null
    releaseUrl?: string | null
    publishedAt?: string | null
    /** Release notes body. Pre-truncated by the caller — the block clips again as a safety net. */
    notes?: string | null
    /** True if the GitHub lookup failed and we fell back to a tag-only source. */
    fallback?: boolean
  }
  /** Any extra context the caller wants to inject */
  extra?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Message types for agent communication
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: "user" | "agent" | "tool"
  agentId?: string
  content: string
  toolCallId?: string
  toolName?: string
}

export interface AgentStreamEvent {
  type:
    | "thinking"
    | "thinking_done"
    | "content"
    | "tool_call"
    | "tool_delta"
    | "tool_result"
    | "delegate"
    | "done"
    | "error"
  content?: string
  seconds?: number
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
  toolDelta?: { toolCallId: string; toolName: string; delta: ToolStreamDelta }
  toolResult?: ToolResult
  delegateTo?: string
  delegateInput?: string
  usage?: unknown
  messageId?: string
  thinkingDuration?: number
  interactionId?: string
}

export type AgentRunStatus = "running" | "ok" | "error" | "aborted"

export type AgentRunEvent =
  | {
      type: "agent_start"
      runId: string
      parentRunId?: string
      toolCallId?: string
      agentId: string
      agentName: string
      kind: AgentKind
      agentThreadId?: string
      prompt: string
      depth: number
      startedAt: number
    }
  | {
      type: "agent_thinking"
      runId: string
      phase?: number
      content: string
    }
  | {
      type: "agent_thinking_done"
      runId: string
      seconds: number
    }
  | {
      type: "agent_content"
      runId: string
      phase?: number
      content: string
    }
  | {
      type: "agent_tool_call"
      runId: string
      phase?: number
      toolCall: ToolCallInfo & { title?: string }
    }
  | {
      type: "agent_tool_delta"
      runId: string
      toolCallId: string
      toolName: string
      delta: ToolStreamDelta
    }
  | {
      type: "agent_tool_result"
      runId: string
      toolCallId: string
      toolName: string
      result: ToolResult
    }
  | {
      type: "agent_done"
      runId: string
      status: AgentRunStatus
      endedAt: number
      content?: string
      reasoning?: ReasoningEntry[]
      contentSegments?: ContentSegment[]
      attachments?: Attachment[]
      error?: string
      usage?: unknown
      thinkingDuration?: number
    }

// ---------------------------------------------------------------------------
// Provider interface — implemented by google.ts, anthropic.ts, etc.
// ---------------------------------------------------------------------------

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface StreamCallbacks {
  onThinking: (text: string) => void
  onThinkingDone: (seconds: number) => void
  onContent: (text: string) => void
  onToolCall: (toolCall: ToolCallInfo) => void
  onToolDelta?: (
    toolCallId: string,
    toolName: string,
    delta: ToolStreamDelta
  ) => void
  onToolResult: (
    toolCallId: string,
    toolName: string,
    result: ToolResult
  ) => void
  /** Real provider token/context usage when the provider streams or returns it. */
  onUsage?: (usage: ContextUsageSnapshot) => void
  /** Provider reported a context compaction/summarization event. */
  onContextCompaction?: (event: {
    threadId?: string
    turnId?: string
    itemId?: string
    at: number
  }) => void
  /**
   * `usage` is the raw provider payload — Gemini's `Usage` shape today, but
   * other providers will return their own shape. Consumers should pass it
   * through `lib/observability/usage-mapper.ts` before reading fields.
   *
   * `sessionId` is the provider's session identifier for stateful resumption
   * (Gemini interactionId, OpenAI Responses previous_response_id, ...).
   * Anthropic returns nothing here — its mode is always stateless.
   */
  onDone: (meta: {
    sessionId?: string
    usage?: unknown
    thinkingDuration?: number
    attachments?: Attachment[]
  }) => void
  onError: (error: string) => void
}

export interface MessageAttachment {
  /** Absolute local file path */
  filePath: string
  /** MIME type */
  mimeType: string
}

export interface ProviderSendOptions {
  model: string
  messages: Array<{
    role: string
    content: string
    attachments?: MessageAttachment[]
  }>
  systemPrompt?: string
  thinkingLevel?: ThinkingLevel
  modelOptions?: Record<string, ModelFeatureValue>
  tools?: ToolDef[]
  /** Native provider built-ins to enable for this call. */
  builtins?: ProviderBuiltin[]
  /**
   * Previous session info, if any. Provider decides whether to resume based
   * on its own TTL/refresh rules — caller doesn't need to know provider
   * specifics like Gemini's 50-day window or Files API's 48h reupload.
   */
  prevSession?: { id: string; at: number } | null
  /**
   * Context to thread into tool executions (delegation, etc.). Required
   * when the tool list contains delegation tools. Provider passes this to
   * `executeTool` for every tool call it processes.
   */
  toolContext?: ToolExecutionContext
  /** Optional process/thread working directory for CLI-backed providers. */
  cwd?: string
  /** Abort signal from the client */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Image / video / speech generation options.
//
// Image and speech are sync (return result after the model finishes).
// Video is async — start a job, poll for completion. We keep video off the
// critical request path so the chat route doesn't hold a connection open for
// 30+ seconds.
// ---------------------------------------------------------------------------

export interface ImageGenOptions {
  model: string
  prompt: string
  /** Reference images for editing/iteration (e.g. Nano Banana edit mode). */
  referenceImages?: Array<{ mimeType: string; data: Buffer }>
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4"
  /** Number of images to generate. Default 1. */
  n?: number
  modelOptions?: Record<string, ModelFeatureValue>
  signal?: AbortSignal
}

export interface ImageGenResult {
  images: Array<{ mimeType: string; data: Buffer; revisedPrompt?: string }>
  sources?: Array<{ uri: string; title?: string }>
  usage?: unknown
}

export interface VideoGenOptions {
  model: string
  prompt: string
  durationSeconds?: number
  aspectRatio?: "16:9" | "9:16" | "1:1"
  referenceImage?: { mimeType: string; data: Buffer }
  modelOptions?: Record<string, ModelFeatureValue>
  signal?: AbortSignal
}

export interface VideoGenJob {
  id: string
  status: "pending" | "running" | "done" | "failed"
  /** Available when status === 'done'. */
  videoUrl?: string
  /** Available when status === 'done' and the provider returned bytes. */
  video?: { mimeType: string; data: Buffer }
  /** Available when status === 'failed'. */
  error?: string
  /** Available when status === 'done'. */
  usage?: unknown
}

export interface SpeechGenOptions {
  model: string
  text: string
  voice?: string
  format?: "mp3" | "wav" | "opus"
  /** 0.5 .. 2.0; provider may clamp. */
  speed?: number
  modelOptions?: Record<string, ModelFeatureValue>
  signal?: AbortSignal
}

export interface SpeechGenResult {
  mimeType: string
  data: Buffer
  usage?: unknown
}

export interface MusicGenOptions {
  model: string
  prompt: string
  format?: "mp3" | "wav"
  referenceImages?: Array<{ mimeType: string; data: Buffer }>
  modelOptions?: Record<string, ModelFeatureValue>
  signal?: AbortSignal
}

export interface MusicGenResult {
  mimeType: string
  data: Buffer
  text?: string
  usage?: unknown
}

export interface GeneratedMediaAsset {
  attachment: Attachment
  filePath: string
  url: string
}

// ---------------------------------------------------------------------------
// Provider capabilities & interface.
//
// `capabilities` is the source of truth for what a provider can do. Methods
// are present iff the corresponding kind is in `capabilities.kinds`. Callers
// must check capabilities before invoking — methods may also throw at runtime
// for stub providers (Anthropic/OpenAI today) until real implementations land.
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Generation kinds this provider supports. */
  kinds: AgentKind[]
  /** Native built-ins available (no user implementation needed). */
  nativeBuiltins: ProviderBuiltin[]
  /**
   * Whether native built-ins can be sent together with function/tool schemas.
   * Defaults to true. Some providers reject mixed native tools + function
   * calling in one request, so callers must choose one surface.
   */
  nativeBuiltinsCanMixWithFunctionTools?: boolean
  /** Can resume a session by id (Gemini interactionId, OpenAI Responses, ...). */
  statefulMode: boolean
  /** Prompt caching strategy. `auto` = provider handles, `manual` = caller marks blocks. */
  promptCaching: "auto" | "manual" | "none"
  /** How attachments are conveyed to the model. */
  attachmentMode: "files-api" | "inline-base64" | "file-id-or-url" | "none"
  /** Whether the provider exposes thinking-level controls. */
  thinkingSupport: boolean
  /**
   * Whether this provider id needs its own API key from env. False for
   * CLI-backed/local runtimes; they may still depend on another configured
   * provider key internally, such as the browser agent's Gemini vision loop.
   */
  requiresApiKey: boolean
  /**
   * Prefix the provider exposes our custom (non-native) tools under, as the
   * model actually sees and must call them. Claude Code bridges custom tools
   * through a stdio MCP server, so it surfaces them as
   * `mcp__<server>__<tool>` — the model cannot call the bare id. Providers
   * that pass custom tools under their bare names (codex dynamicTools, the
   * API providers' function tools) leave this undefined. The prompt layer
   * renders tool names and the calling convention with this prefix so the
   * advertised name always matches the callable name.
   */
  customToolNamePrefix?: string
}

export interface AIProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapabilities

  /** Streaming text/multimodal chat. Required when capabilities.kinds includes 'text'. */
  stream?(
    options: ProviderSendOptions,
    callbacks: StreamCallbacks
  ): Promise<void>

  /** Image generation. Required when capabilities.kinds includes 'image'. */
  generateImage?(options: ImageGenOptions): Promise<ImageGenResult>

  /** Start a video generation job. Required when capabilities.kinds includes 'video'. */
  generateVideo?(options: VideoGenOptions): Promise<VideoGenJob>
  /** Poll a previously-started video job. Required alongside generateVideo. */
  pollVideoJob?(jobId: string): Promise<VideoGenJob>

  /** Speech (TTS) generation. Required when capabilities.kinds includes 'speech'. */
  generateSpeech?(options: SpeechGenOptions): Promise<SpeechGenResult>

  /** Music generation. Required when capabilities.kinds includes 'music'. */
  generateMusic?(options: MusicGenOptions): Promise<MusicGenResult>
}
