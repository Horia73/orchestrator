import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type {
  Conversation,
  ContextUsageSnapshot,
  Message,
  Attachment,
} from "@/lib/types"
import { sanitizeMessageForPersistence } from "@/lib/ai/reasoning-limits"
import { emitChatEvent } from "./events"
import { ARTIFACTS_DIR, ORCHESTRATOR_STATE_DIR, UPLOADS_DIR } from "./config"

const DB_DIR = ORCHESTRATOR_STATE_DIR
const isProductionBuild =
  process.env.ORCHESTRATOR_BUILD === "1" ||
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.npm_lifecycle_event === "build"
const DB_PATH = isProductionBuild
  ? path.join(os.tmpdir(), `orchestrator-build-${process.pid}.db`)
  : path.join(DB_DIR, "data.db")

// Ensure the directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

// Initialize the database
const db = new Database(DB_PATH, { timeout: 10_000 })
db.pragma("foreign_keys = ON") // Enforce FK cascades on this connection.
db.pragma("busy_timeout = 10000")
db.pragma("journal_mode = WAL") // Enable Write-Ahead Logging for better concurrent performance

// Initialize tables
db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        lastInteractionProvider TEXT,
        lastInteractionModel TEXT,
        lastInteractionId TEXT,
        lastInteractionAt INTEGER,
        contextUsage TEXT,
        messageCount INTEGER NOT NULL DEFAULT 0,
        lastMessagePreview TEXT,
        lastMessageAt INTEGER,
        archivedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT,
        contentSegments TEXT,
        reasoning TEXT,
        thinking TEXT,
        thinkingDuration INTEGER,
        toolCalls TEXT,
        replyActions TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp ON messages(conversationId, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp_id ON messages(conversationId, timestamp DESC, id DESC);

    CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        agentThreadId TEXT,
        parentRequestId TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thinkingLevel TEXT NOT NULL,
        status TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        durationMs INTEGER,
        thinkingMs INTEGER,
        inputTokens INTEGER,
        outputTokens INTEGER,
        thinkingTokens INTEGER,
        cachedTokens INTEGER,
        toolUseTokens INTEGER,
        totalTokens INTEGER,
        modalityBreakdown TEXT,
        billingBreakdown TEXT,
        toolCallCount INTEGER NOT NULL DEFAULT 0,
        interactionId TEXT,
        statefulMode INTEGER NOT NULL DEFAULT 0,
        errorMessage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_started ON request_logs(startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
    CREATE INDEX IF NOT EXISTS idx_request_logs_agent ON request_logs(agentId);
    CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(provider, model);

    CREATE TABLE IF NOT EXISTS tool_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requestId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        success INTEGER NOT NULL,
        startedAt INTEGER NOT NULL,
        durationMs INTEGER,
        errorMessage TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        createdByAgentId TEXT NOT NULL,
        parentAgentThreadId TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        provider TEXT,
        model TEXT,
        lastInteractionProvider TEXT,
        lastInteractionModel TEXT,
        lastInteractionId TEXT,
        lastInteractionAt INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES conversations (id) ON DELETE CASCADE,
        FOREIGN KEY (parentAgentThreadId) REFERENCES agent_threads (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_threads_conversation ON agent_threads(conversationId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_threads_parent ON agent_threads(parentAgentThreadId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_threads_owner ON agent_threads(conversationId, createdByAgentId, parentAgentThreadId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_threads_agent ON agent_threads(agentId, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS agent_thread_messages (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        requestId TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (threadId) REFERENCES agent_threads (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread ON agent_thread_messages(threadId, timestamp ASC);

    CREATE TABLE IF NOT EXISTS artifacts (
        -- Compound PK: same identifier across a conversation = version chain.
        -- (conversationId, identifier, version) lets us look up "v3 of this
        -- artifact" instantly; (id) gives a stable handle for individual rows.
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        identifier TEXT NOT NULL,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT,
        display TEXT,
        filePath TEXT,
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        UNIQUE(conversationId, identifier, version),
        FOREIGN KEY (conversationId) REFERENCES conversations (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversationId, identifier, version DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_msg ON artifacts(messageId);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_request ON tool_logs(requestId);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_started ON tool_logs(startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_name ON tool_logs(toolName);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        action TEXT NOT NULL,        -- JSON ScheduledAction
        schedule TEXT NOT NULL,      -- JSON ScheduleSpec
        nextRunAt INTEGER,
        lastRunAt INTEGER,
        lastRunStatus TEXT,
        lastRunError TEXT,
        lastConversationId TEXT,
        runCount INTEGER NOT NULL DEFAULT 0,
        consecutiveFailures INTEGER NOT NULL DEFAULT 0,
        createdBy TEXT NOT NULL DEFAULT 'user',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(status, nextRunAt);

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER NOT NULL,
        status TEXT NOT NULL,            -- 'ok' | 'error'
        trigger TEXT NOT NULL,           -- 'schedule' | 'manual'
        surfaced INTEGER NOT NULL DEFAULT 0,
        conversationId TEXT,             -- inbox conversation when surfaced
        summary TEXT NOT NULL,           -- full run output (audit, even when silent)
        contentSegments TEXT,            -- JSON Message.contentSegments for rich Past runs rendering
        reasoning TEXT,                  -- JSON Message.reasoning for rich Past runs rendering
        attachments TEXT,                -- JSON Message.attachments for rich Past runs rendering
        error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(taskId, startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_started_id ON scheduled_task_runs(taskId, startedAt DESC, id DESC);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        subscription TEXT NOT NULL,
        userAgent TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated ON push_subscriptions(updatedAt DESC);
`)

// Migration: add interaction tracking columns if missing
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastInteractionId TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastInteractionProvider TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastInteractionModel TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastInteractionAt INTEGER`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE agent_threads ADD COLUMN lastInteractionModel TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN contextUsage TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(
    `ALTER TABLE conversations ADD COLUMN messageCount INTEGER NOT NULL DEFAULT 0`
  )
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastMessagePreview TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN lastMessageAt INTEGER`)
} catch {
  /* column already exists */
}
try {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp_id ON messages(conversationId, timestamp DESC, id DESC)`
  )
} catch {
  /* index already exists */
}
// Migration: Inbox / scheduled-run conversation tagging.
// origin: 'user' (or NULL = legacy user chat) vs 'inbox' (a scheduled run).
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN origin TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN scheduledTaskId TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN readAt INTEGER`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN archivedAt INTEGER`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN forkedFromConversationId TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_origin ON conversations(origin, createdAt DESC)`
  )
} catch {
  /* index already exists */
}
// Migration: per-task private state (monitor watermark / baseline / last-seen).
try {
  db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN state TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE scheduled_task_runs ADD COLUMN contentSegments TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE scheduled_task_runs ADD COLUMN reasoning TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE scheduled_task_runs ADD COLUMN attachments TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN thinkingDuration INTEGER`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN status TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN reasoning TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN contentSegments TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN replyActions TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`
    UPDATE scheduled_task_runs
    SET
      contentSegments = COALESCE(contentSegments, (
        SELECT m.contentSegments
        FROM messages m
        WHERE m.conversationId = scheduled_task_runs.conversationId
          AND m.role = 'assistant'
        ORDER BY m.timestamp ASC, m.id ASC
        LIMIT 1
      )),
      reasoning = COALESCE(reasoning, (
        SELECT m.reasoning
        FROM messages m
        WHERE m.conversationId = scheduled_task_runs.conversationId
          AND m.role = 'assistant'
        ORDER BY m.timestamp ASC, m.id ASC
        LIMIT 1
      )),
      attachments = COALESCE(attachments, (
        SELECT m.attachments
        FROM messages m
        WHERE m.conversationId = scheduled_task_runs.conversationId
          AND m.role = 'assistant'
        ORDER BY m.timestamp ASC, m.id ASC
        LIMIT 1
      ))
    WHERE conversationId IS NOT NULL
      AND (contentSegments IS NULL OR reasoning IS NULL OR attachments IS NULL)
  `)
} catch {
  /* best-effort scheduled run transcript backfill */
}
try {
  db.exec(`ALTER TABLE artifacts ADD COLUMN filePath TEXT`)
} catch {
  /* column already exists */
}

// Migrations: sub-agent delegation columns on request_logs.
try {
  db.exec(`ALTER TABLE request_logs ADD COLUMN parentRequestId TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(
    `ALTER TABLE request_logs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`
  )
} catch {
  /* column already exists */
}
try {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_request_logs_parent ON request_logs(parentRequestId)`
  )
} catch {
  /* index already exists */
}

try {
  db.exec(`
    UPDATE conversations
    SET
      messageCount = (
        SELECT COUNT(*)
        FROM messages
        WHERE messages.conversationId = conversations.id
      ),
      lastMessagePreview = (
        SELECT content
        FROM messages
        WHERE messages.conversationId = conversations.id
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
      ),
      lastMessageAt = (
        SELECT timestamp
        FROM messages
        WHERE messages.conversationId = conversations.id
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
      )
    WHERE lastMessageAt IS NULL
      OR messageCount = 0
  `)
} catch {
  /* best-effort summary backfill */
}

try {
  db.exec(`
    UPDATE conversations
    SET readAt = lastMessageAt
    WHERE (origin IS NULL OR origin = 'user')
      AND readAt IS NULL
      AND lastMessageAt IS NOT NULL
  `)
} catch {
  /* best-effort read-state backfill */
}

// Migrations: input/output text for log detail panel.
try {
  db.exec(`ALTER TABLE request_logs ADD COLUMN inputText TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE request_logs ADD COLUMN outputText TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE request_logs ADD COLUMN agentThreadId TEXT`)
} catch {
  /* column already exists */
}
try {
  db.exec(`ALTER TABLE request_logs ADD COLUMN billingBreakdown TEXT`)
} catch {
  /* column already exists */
}

// Cleanup: v1.0.6-v1.0.7 model research could create Codex app-server logs
// by passing an unsupported MCP override. Remove those noisy, non-user logs
// once the fixed build starts.
try {
  db.exec(`
    DELETE FROM tool_logs
    WHERE requestId IN (
      SELECT id FROM request_logs
      WHERE conversationId LIKE 'model_research_%'
        AND agentId = 'researcher'
        AND provider = 'codex'
        AND (
          errorMessage LIKE '%mcp_servers.playwright%'
          OR errorMessage = 'codex app-server exited with code 1'
        )
    );

    DELETE FROM request_logs
    WHERE conversationId LIKE 'model_research_%'
      AND agentId = 'researcher'
      AND provider = 'codex'
      AND (
        errorMessage LIKE '%mcp_servers.playwright%'
        OR errorMessage = 'codex app-server exited with code 1'
      );
  `)
} catch {
  /* best-effort cleanup only */
}

// Types matching the database rows
interface ConversationRow {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  contextUsage: string | null
  messageCount: number
  lastMessagePreview: string | null
  lastMessageAt: number | null
  readAt: number | null
  archivedAt: number | null
}

interface ConversationSummaryRow extends ConversationRow {
  searchMatchContent?: string | null
}

interface MessageRow {
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  status: Message["status"] | null
  contentSegments: string | null
  reasoning: string | null
  thinking: string | null
  thinkingDuration: number | null
  toolCalls: string | null
  attachments: string | null
  replyActions: string | null
  timestamp: number
}

export interface MessagePageCursor {
  timestamp: number
  id: string
}

export interface ConversationMessagesPage {
  messages: Message[]
  total: number
  hasMore: boolean
  nextCursor: MessagePageCursor | null
}

function parseJsonField<T>(value: string | null): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function messageFromRow(msgRow: MessageRow): Message {
  return sanitizeMessageForPersistence({
    id: msgRow.id,
    role: msgRow.role,
    content: msgRow.content,
    status: msgRow.status ?? undefined,
    contentSegments: parseJsonField<Message["contentSegments"]>(
      msgRow.contentSegments
    ),
    reasoning: parseJsonField<Message["reasoning"]>(msgRow.reasoning),
    thinking: msgRow.thinking || undefined,
    thinkingDuration: msgRow.thinkingDuration ?? undefined,
    toolCalls: parseJsonField<Message["toolCalls"]>(msgRow.toolCalls),
    attachments: parseJsonField<Message["attachments"]>(msgRow.attachments),
    replyActions: parseJsonField<Message["replyActions"]>(msgRow.replyActions),
    timestamp: msgRow.timestamp,
  })
}

function compactPreview(
  value: string | null | undefined,
  maxLength = 220
): string {
  const singleLine = (value ?? "").replace(/\s+/g, " ").trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}...`
}

function compactOversizedMessageMetadata(): void {
  const oversizedRows = db
    .prepare(
      `
        SELECT *
        FROM messages
        WHERE length(COALESCE(reasoning, '')) > 1000000
           OR length(COALESCE(toolCalls, '')) > 1000000
      `
    )
    .all() as MessageRow[]

  if (oversizedRows.length === 0) return

  const update = db.prepare(`
    UPDATE messages
    SET reasoning = @reasoning,
        toolCalls = @toolCalls
    WHERE id = @id
  `)

  const transaction = db.transaction((rows: MessageRow[]) => {
    for (const row of rows) {
      const message = messageFromRow(row)
      update.run({
        id: row.id,
        reasoning: message.reasoning ? JSON.stringify(message.reasoning) : null,
        toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      })
    }
  })

  try {
    transaction(oversizedRows)
  } catch (error) {
    console.warn("Failed to compact oversized message metadata", error)
  }
}

compactOversizedMessageMetadata()

export type AgentThreadStatus = "active" | "archived"

export interface AgentThread {
  id: string
  conversationId: string
  agentId: string
  createdByAgentId: string
  parentAgentThreadId: string | null
  title: string
  summary: string | null
  provider: string | null
  model: string | null
  lastInteractionProvider: string | null
  lastInteractionModel: string | null
  lastInteractionId: string | null
  lastInteractionAt: number | null
  status: AgentThreadStatus
  createdAt: number
  updatedAt: number
}

export interface AgentThreadMessage {
  id: string
  threadId: string
  role: "user" | "assistant"
  content: string
  requestId: string | null
  timestamp: number
}

// Helper Functions
export function getConversationsWithMessages(): Conversation[] {
  // Inbox conversations (scheduled runs) are surfaced separately via the
  // scheduling store — keep them out of the normal chat recents list.
  const convRows = db
    .prepare(
      `
        SELECT *
        FROM conversations
        WHERE (origin IS NULL OR origin = 'user')
          AND archivedAt IS NULL
        ORDER BY
          COALESCE(lastMessageAt, createdAt) DESC,
          createdAt DESC
      `
    )
    .all() as ConversationRow[]
  const allMessagesRows = db
    .prepare("SELECT * FROM messages ORDER BY timestamp ASC")
    .all() as MessageRow[]

  const messagesByConv = new Map<string, Message[]>()
  for (const msgRow of allMessagesRows) {
    if (!messagesByConv.has(msgRow.conversationId)) {
      messagesByConv.set(msgRow.conversationId, [])
    }
    messagesByConv.get(msgRow.conversationId)!.push(messageFromRow(msgRow))
  }

  return convRows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: messagesByConv.get(row.id) || [],
    contextUsage: parseJsonField<ContextUsageSnapshot>(row.contextUsage),
    readAt: row.readAt ?? null,
    archivedAt: row.archivedAt ?? null,
  }))
}

export function getConversationSummaries(
  search?: string,
  archived = false
): Conversation[] {
  const query = search?.trim()
  const like = query
    ? `%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`
    : null
  const where = [
    "(c.origin IS NULL OR c.origin = 'user')",
    archived
      ? "c.archivedAt IS NOT NULL"
      : like
        ? null
        : "c.archivedAt IS NULL",
    like
      ? `(c.title LIKE @like ESCAPE '\\' OR EXISTS (
          SELECT 1
          FROM messages sm
          WHERE sm.conversationId = c.id
            AND sm.content LIKE @like ESCAPE '\\'
        ))`
      : null,
  ]
    .filter(Boolean)
    .join(" AND ")

  const rows = db
    .prepare(
      `
        SELECT
          c.id,
          c.title,
          c.createdAt,
          c.updatedAt,
          c.contextUsage,
          c.messageCount,
          c.lastMessagePreview,
          c.lastMessageAt,
          c.readAt,
          c.archivedAt
          ${
            like
              ? `, (
                  SELECT mm.content
                  FROM messages mm
                  WHERE mm.conversationId = c.id
                    AND mm.content LIKE @like ESCAPE '\\'
                  ORDER BY mm.timestamp DESC
                  LIMIT 1
                ) AS searchMatchContent`
              : `, NULL AS searchMatchContent`
          }
        FROM conversations c
        WHERE ${where}
        ORDER BY
          COALESCE(c.lastMessageAt, c.createdAt) DESC,
          c.createdAt DESC
      `
    )
    .all(like ? { like } : {}) as ConversationSummaryRow[]

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: [],
    contextUsage: parseJsonField<ContextUsageSnapshot>(row.contextUsage),
    messageCount: row.messageCount,
    lastMessagePreview: compactPreview(row.lastMessagePreview),
    lastMessageAt: row.lastMessageAt ?? undefined,
    readAt: row.readAt ?? null,
    archivedAt: row.archivedAt ?? null,
    searchMatchPreview: compactPreview(row.searchMatchContent),
  }))
}

export function getConversation(id: string): Conversation | null {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | ConversationRow
    | undefined
  if (!row) return null

  const msgRows = db
    .prepare(
      "SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC"
    )
    .all(id) as MessageRow[]
  const messages: Message[] = msgRows.map(messageFromRow)

  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages,
    contextUsage: parseJsonField<ContextUsageSnapshot>(row.contextUsage),
    readAt: row.readAt ?? null,
    archivedAt: row.archivedAt ?? null,
  }
}

export function getConversationMessagesPage(
  id: string,
  options: { limit?: number; before?: MessagePageCursor | null } = {}
): ConversationMessagesPage {
  const limit = Math.max(1, Math.min(options.limit ?? 80, 200))
  const before = options.before
  const conversationRow = db
    .prepare("SELECT messageCount FROM conversations WHERE id = ?")
    .get(id) as { messageCount: number | null } | undefined

  const rows = db
    .prepare(
      `
        SELECT *
        FROM messages
        WHERE conversationId = @id
          ${
            before
              ? `AND (
                  timestamp < @beforeTimestamp
                  OR (timestamp = @beforeTimestamp AND id < @beforeId)
                )`
              : ""
          }
        ORDER BY timestamp DESC, id DESC
        LIMIT @limitPlusOne
      `
    )
    .all({
      id,
      beforeTimestamp: before?.timestamp ?? null,
      beforeId: before?.id ?? null,
      limitPlusOne: limit + 1,
    }) as MessageRow[]

  const pageRows = rows.slice(0, limit)
  const oldestRow = pageRows[pageRows.length - 1]

  return {
    messages: pageRows.reverse().map(messageFromRow),
    total: conversationRow?.messageCount ?? 0,
    hasMore: rows.length > limit,
    nextCursor:
      rows.length > limit && oldestRow
        ? { timestamp: oldestRow.timestamp, id: oldestRow.id }
        : null,
  }
}

/**
 * Lightweight scan of messages.attachments across all user conversations.
 *
 * Avoids loading message bodies — only pulls the `attachments` JSON blob,
 * the parent conversation's title, the message id, and the timestamp. Used
 * by the Library page to populate Media / Audio / Files tabs without
 * pulling the entire chat history into memory.
 *
 * Filters out conversations where origin is not 'user' (matches the inbox/
 * sidebar exclusion of system/agent-only threads).
 */
export interface AttachmentLibraryEntry {
  /** Original Attachment fields, copied through. */
  id: string
  filename: string
  mimeType: string
  size: number
  type: "image" | "pdf" | "document" | "audio" | "video" | "other"
  /** Source conversation + message context for "view in chat" linking. */
  conversationId: string
  conversationTitle: string
  messageId: string
  messageTimestamp: number
}

export function listAllAttachments(): AttachmentLibraryEntry[] {
  const rows = db
    .prepare(
      `
        SELECT
          m.id AS messageId,
          m.timestamp,
          m.attachments,
          c.id AS conversationId,
          c.title AS conversationTitle
        FROM messages m
        JOIN conversations c ON c.id = m.conversationId
        WHERE m.attachments IS NOT NULL
          AND m.attachments != ''
          AND (c.origin IS NULL OR c.origin = 'user')
        ORDER BY m.timestamp DESC
      `
    )
    .all() as Array<{
    messageId: string
    timestamp: number
    attachments: string
    conversationId: string
    conversationTitle: string
  }>

  const out: AttachmentLibraryEntry[] = []
  for (const row of rows) {
    const attachments = parseJsonField<
      Array<{
        id: string
        filename: string
        mimeType: string
        size: number
        type: "image" | "pdf" | "document" | "audio" | "video" | "other"
      }>
    >(row.attachments)
    if (!attachments || !Array.isArray(attachments)) continue
    for (const a of attachments) {
      if (!a || typeof a !== "object" || typeof a.id !== "string") continue
      out.push({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        type: a.type,
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        messageId: row.messageId,
        messageTimestamp: row.timestamp,
      })
    }
  }
  return out
}

export interface DeleteLibraryAttachmentsResult {
  requested: number
  deleted: number
  missing: string[]
  affectedMessages: number
}

function collectAllReferencedAttachmentIds(): Set<string> {
  const rows = db
    .prepare("SELECT attachments FROM messages WHERE attachments IS NOT NULL")
    .all() as { attachments: string | null }[]

  const referenced = new Set<string>()
  for (const row of rows) {
    if (!row.attachments) continue
    try {
      const parsed = JSON.parse(row.attachments) as Attachment[]
      for (const att of parsed) {
        if (typeof att?.id === "string") referenced.add(att.id)
      }
    } catch {
      /* skip malformed rows */
    }
  }
  return referenced
}

export function deleteLibraryAttachments(
  ids: string[]
): DeleteLibraryAttachmentsResult {
  const requestedIds = Array.from(
    new Set(
      ids
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
    )
  )
  if (requestedIds.length === 0) {
    return { requested: 0, deleted: 0, missing: [], affectedMessages: 0 }
  }

  const wanted = new Set(requestedIds)
  const rows = db
    .prepare(
      "SELECT id, attachments FROM messages WHERE attachments IS NOT NULL"
    )
    .all() as Array<{ id: string; attachments: string | null }>

  const updateMessage = db.prepare(
    "UPDATE messages SET attachments = ? WHERE id = ?"
  )
  const removedIds = new Set<string>()
  let affectedMessages = 0

  const transaction = db.transaction(() => {
    for (const row of rows) {
      if (!row.attachments) continue
      let parsed: Attachment[]
      try {
        parsed = JSON.parse(row.attachments) as Attachment[]
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue

      const kept = parsed.filter((att) => {
        if (!att || typeof att.id !== "string" || !wanted.has(att.id))
          return true
        removedIds.add(att.id)
        return false
      })
      if (kept.length === parsed.length) continue

      updateMessage.run(kept.length > 0 ? JSON.stringify(kept) : null, row.id)
      affectedMessages++
    }
  })

  transaction()

  const stillReferenced = collectAllReferencedAttachmentIds()
  for (const id of removedIds) {
    if (!stillReferenced.has(id)) unlinkUploadIfExists(id)
  }

  return {
    requested: requestedIds.length,
    deleted: removedIds.size,
    missing: requestedIds.filter((id) => !removedIds.has(id)),
    affectedMessages,
  }
}

export function createConversation(conversation: Conversation) {
  const latestMessage = conversation.messages.reduce<Message | null>(
    (latest, message) =>
      !latest || message.timestamp > latest.timestamp ? message : latest,
    null
  )
  const now = Date.now()
  const initialReadAt =
    conversation.readAt ??
    latestMessage?.timestamp ??
    conversation.createdAt ??
    now

  // Idempotent: the chat route and POST /api/conversations both call this in
  // the same flight, and SQLite UNIQUE conflicts would otherwise abort one of
  // them. INSERT OR IGNORE preserves whichever winner inserted first.
  const insertConv = db.prepare(`
        INSERT OR IGNORE INTO conversations (
          id, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageAt, readAt, archivedAt
        )
        VALUES (
          @id, @title, @createdAt, @updatedAt, @messageCount, @lastMessagePreview, @lastMessageAt, @readAt, @archivedAt
        )
    `)

  const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages (id, conversationId, role, content, status, contentSegments, reasoning, thinking, thinkingDuration, toolCalls, attachments, replyActions, timestamp)
        VALUES (@id, @conversationId, @role, @content, @status, @contentSegments, @reasoning, @thinking, @thinkingDuration, @toolCalls, @attachments, @replyActions, @timestamp)
    `)

  const refreshConversationSummary = db.prepare(`
        UPDATE conversations
        SET
          updatedAt = @updatedAt,
          messageCount = (
            SELECT COUNT(*)
            FROM messages
            WHERE conversationId = @id
          ),
          lastMessagePreview = (
            SELECT content
            FROM messages
            WHERE conversationId = @id
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
          ),
          lastMessageAt = (
            SELECT timestamp
            FROM messages
            WHERE conversationId = @id
            ORDER BY timestamp DESC, id DESC
            LIMIT 1
          )
        WHERE id = @id
    `)

  const transaction = db.transaction((conv: Conversation): boolean => {
    const convResult = insertConv.run({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: now,
      messageCount: conv.messages.length,
      lastMessagePreview: compactPreview(latestMessage?.content),
      lastMessageAt: latestMessage?.timestamp ?? null,
      readAt: initialReadAt,
      archivedAt: conversation.archivedAt ?? null,
    })

    for (const rawMsg of conv.messages) {
      const msg = sanitizeMessageForPersistence(rawMsg)
      insertMsg.run({
        id: msg.id,
        conversationId: conv.id,
        role: msg.role,
        content: msg.content,
        status: msg.status ?? null,
        contentSegments: msg.contentSegments
          ? JSON.stringify(msg.contentSegments)
          : null,
        reasoning: msg.reasoning ? JSON.stringify(msg.reasoning) : null,
        thinking: msg.thinking || null,
        thinkingDuration: msg.thinkingDuration ?? null,
        toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
        replyActions: msg.replyActions
          ? JSON.stringify(msg.replyActions)
          : null,
        timestamp: msg.timestamp,
      })
    }

    refreshConversationSummary.run({
      id: conv.id,
      updatedAt: now,
    })

    return convResult.changes > 0
  })

  const created = transaction(conversation)

  // Only emit on the run that actually inserted — the racing caller would
  // otherwise double-emit and the UI store would dedup-then-flicker.
  if (created) {
    emitChatEvent({
      type: "create_conversation",
      payload: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: now,
        messages: conversation.messages,
        messageCount: conversation.messages.length,
        lastMessagePreview: compactPreview(latestMessage?.content),
        lastMessageAt: latestMessage?.timestamp ?? undefined,
        readAt: initialReadAt,
        archivedAt: conversation.archivedAt ?? null,
      },
    })
  }
}

export function setConversationArchived(
  id: string,
  archived: boolean,
  archivedAt = Date.now()
): number | null {
  const nextArchivedAt = archived ? archivedAt : null

  db.prepare(
    `
        UPDATE conversations
        SET archivedAt = @archivedAt
        WHERE id = @id
          AND (origin IS NULL OR origin = 'user')
    `
  ).run({ id, archivedAt: nextArchivedAt })

  const row = db
    .prepare(
      "SELECT archivedAt FROM conversations WHERE id = ? AND (origin IS NULL OR origin = 'user')"
    )
    .get(id) as { archivedAt: number | null } | undefined
  const storedArchivedAt = row?.archivedAt ?? null

  emitChatEvent({
    type: "conversation_archive_state",
    payload: {
      conversationId: id,
      archivedAt: storedArchivedAt,
    },
  })

  return storedArchivedAt
}

export function markConversationRead(
  id: string,
  readAt = Date.now()
): number | null {
  const current = db
    .prepare(
      "SELECT lastMessageAt, updatedAt FROM conversations WHERE id = ? AND (origin IS NULL OR origin = 'user')"
    )
    .get(id) as
    | { lastMessageAt: number | null; updatedAt: number | null }
    | undefined
  const targetReadAt = Math.max(
    readAt,
    current?.lastMessageAt ?? readAt,
    current?.updatedAt ?? readAt
  )

  db.prepare(
    `
        UPDATE conversations
        SET readAt = CASE
          WHEN readAt IS NULL OR readAt < @readAt THEN @readAt
          ELSE readAt
        END
        WHERE id = @id
          AND (origin IS NULL OR origin = 'user')
    `
  ).run({ id, readAt: targetReadAt })

  const row = db
    .prepare(
      "SELECT readAt FROM conversations WHERE id = ? AND (origin IS NULL OR origin = 'user')"
    )
    .get(id) as { readAt: number | null } | undefined
  const nextReadAt = row?.readAt ?? null

  emitChatEvent({
    type: "conversation_read_state",
    payload: {
      conversationId: id,
      readAt: nextReadAt,
    },
  })

  return nextReadAt
}

export function markConversationUnread(id: string): number {
  db.prepare(
    `
        UPDATE conversations
        SET readAt = 0
        WHERE id = @id
          AND (origin IS NULL OR origin = 'user')
    `
  ).run({ id })

  emitChatEvent({
    type: "conversation_read_state",
    payload: {
      conversationId: id,
      readAt: 0,
    },
  })

  return 0
}

export function addMessage(conversationId: string, message: Message) {
  const storedMessage = sanitizeMessageForPersistence(message)
  const existingMessage = db
    .prepare("SELECT id FROM messages WHERE id = ?")
    .get(storedMessage.id) as { id: string } | undefined
  const insertMsg = db.prepare(`
        INSERT INTO messages (id, conversationId, role, content, status, contentSegments, reasoning, thinking, thinkingDuration, toolCalls, attachments, replyActions, timestamp)
        VALUES (@id, @conversationId, @role, @content, @status, @contentSegments, @reasoning, @thinking, @thinkingDuration, @toolCalls, @attachments, @replyActions, @timestamp)
        ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            status = excluded.status,
            contentSegments = excluded.contentSegments,
            reasoning = excluded.reasoning,
            thinking = excluded.thinking,
            thinkingDuration = excluded.thinkingDuration,
            toolCalls = excluded.toolCalls,
            attachments = excluded.attachments,
            replyActions = excluded.replyActions
    `)

  const updateConv = db.prepare(`
        UPDATE conversations
        SET
          updatedAt = @updatedAt,
          messageCount = messageCount + @messageDelta,
          readAt = CASE
            WHEN @messageRole = 'user' AND (readAt IS NULL OR readAt < @messageTimestamp)
              THEN @messageTimestamp
            ELSE readAt
          END,
          lastMessagePreview = CASE
            WHEN lastMessageAt IS NULL OR lastMessageAt <= @messageTimestamp
              THEN @lastMessagePreview
            ELSE lastMessagePreview
          END,
          lastMessageAt = CASE
            WHEN lastMessageAt IS NULL OR lastMessageAt <= @messageTimestamp
              THEN @messageTimestamp
            ELSE lastMessageAt
          END
        WHERE id = @id
    `)

  const transaction = db.transaction((convId: string, msg: Message) => {
    insertMsg.run({
      id: msg.id,
      conversationId: convId,
      role: msg.role,
      content: msg.content,
      status: msg.status ?? null,
      contentSegments: msg.contentSegments
        ? JSON.stringify(msg.contentSegments)
        : null,
      reasoning: msg.reasoning ? JSON.stringify(msg.reasoning) : null,
      thinking: msg.thinking || null,
      thinkingDuration: msg.thinkingDuration ?? null,
      toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
      replyActions: msg.replyActions ? JSON.stringify(msg.replyActions) : null,
      timestamp: msg.timestamp,
    })

    updateConv.run({
      id: convId,
      updatedAt: Date.now(),
      messageDelta: existingMessage ? 0 : 1,
      messageRole: msg.role,
      lastMessagePreview: compactPreview(msg.content),
      messageTimestamp: msg.timestamp,
    })
  })

  transaction(conversationId, storedMessage)

  emitChatEvent({
    type: "add_message",
    payload: {
      conversationId,
      message: storedMessage,
    },
  })

  if (message.role === "user") {
    const row = db
      .prepare("SELECT readAt FROM conversations WHERE id = ?")
      .get(conversationId) as { readAt: number | null } | undefined
    emitChatEvent({
      type: "conversation_read_state",
      payload: {
        conversationId,
        readAt: row?.readAt ?? message.timestamp,
      },
    })
  }
}

export function updateInteractionId(
  conversationId: string,
  provider: string,
  model: string,
  interactionId: string
) {
  db.prepare(
    `
        UPDATE conversations
        SET lastInteractionProvider = @provider,
            lastInteractionModel = @model,
            lastInteractionId = @interactionId,
            lastInteractionAt = @now,
            updatedAt = @now
        WHERE id = @conversationId
    `
  ).run({
    conversationId,
    provider,
    model,
    interactionId,
    now: Date.now(),
  })
}

export function updateConversationContextUsage(
  conversationId: string,
  snapshot: ContextUsageSnapshot
): ContextUsageSnapshot {
  const row = db
    .prepare("SELECT contextUsage FROM conversations WHERE id = ?")
    .get(conversationId) as { contextUsage: string | null } | undefined
  const previous = parseJsonField<ContextUsageSnapshot>(
    row?.contextUsage ?? null
  )
  const sameSource = Boolean(
    previous &&
    previous.provider === snapshot.provider &&
    previous.model === snapshot.model
  )
  const merged: ContextUsageSnapshot = {
    ...(sameSource ? (previous ?? {}) : {}),
    ...snapshot,
    lastCompactedAt:
      snapshot.lastCompactedAt ??
      (sameSource ? previous?.lastCompactedAt : null) ??
      null,
    compactedCount:
      snapshot.compactedCount ??
      (sameSource ? previous?.compactedCount : undefined),
  }

  db.prepare(
    `
        UPDATE conversations
        SET contextUsage = @contextUsage,
            updatedAt = @updatedAt
        WHERE id = @conversationId
    `
  ).run({
    conversationId,
    contextUsage: JSON.stringify(merged),
    updatedAt: Date.now(),
  })

  emitChatEvent({
    type: "context_usage",
    payload: {
      conversationId,
      contextUsage: merged,
    },
  })

  return merged
}

export function getInteractionId(
  conversationId: string,
  provider: string,
  model: string
): { id: string; at: number } | null {
  const row = db
    .prepare(
      "SELECT lastInteractionProvider, lastInteractionModel, lastInteractionId, lastInteractionAt FROM conversations WHERE id = ?"
    )
    .get(conversationId) as
    | {
        lastInteractionProvider: string | null
        lastInteractionModel: string | null
        lastInteractionId: string | null
        lastInteractionAt: number | null
      }
    | undefined

  if (!row?.lastInteractionId || !row.lastInteractionAt) return null
  if (row.lastInteractionProvider) {
    if (row.lastInteractionProvider !== provider) return null
    if (row.lastInteractionModel) {
      return row.lastInteractionModel === model
        ? { id: row.lastInteractionId, at: row.lastInteractionAt }
        : null
    }

    return interactionLogMatches({
      conversationId,
      interactionId: row.lastInteractionId,
      provider,
      model,
    })
      ? { id: row.lastInteractionId, at: row.lastInteractionAt }
      : null
  }

  // Backward compatibility for rows created before interaction ids were
  // provider/model-scoped. Use the request log that produced the same
  // interaction id; if we cannot prove both match, do not resume.
  if (
    !interactionLogMatches({
      conversationId,
      interactionId: row.lastInteractionId,
      provider,
      model,
    })
  )
    return null
  return { id: row.lastInteractionId, at: row.lastInteractionAt }
}

function interactionLogMatches(args: {
  conversationId: string
  interactionId: string
  provider: string
  model: string
}): boolean {
  const legacy = db
    .prepare(
      `
        SELECT provider, model
        FROM request_logs
        WHERE conversationId = ? AND interactionId = ?
        ORDER BY endedAt DESC, startedAt DESC
        LIMIT 1
    `
    )
    .get(args.conversationId, args.interactionId) as
    | { provider: string; model: string }
    | undefined

  return legacy?.provider === args.provider && legacy.model === args.model
}

function normalizeAgentThread(row: AgentThread): AgentThread {
  return {
    ...row,
    parentAgentThreadId: row.parentAgentThreadId ?? null,
    summary: row.summary ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    lastInteractionProvider: row.lastInteractionProvider ?? null,
    lastInteractionModel: row.lastInteractionModel ?? null,
    lastInteractionId: row.lastInteractionId ?? null,
    lastInteractionAt: row.lastInteractionAt ?? null,
    status: row.status === "archived" ? "archived" : "active",
  }
}

function normalizeAgentThreadMessage(
  row: AgentThreadMessage
): AgentThreadMessage {
  return {
    ...row,
    role: row.role === "assistant" ? "assistant" : "user",
    requestId: row.requestId ?? null,
  }
}

export function createAgentThread(args: {
  conversationId: string
  agentId: string
  createdByAgentId: string
  parentAgentThreadId?: string | null
  title?: string | null
  provider?: string | null
  model?: string | null
}): AgentThread {
  const now = Date.now()
  const id = `ath_${randomUUID()}`
  const title = cleanAgentThreadTitle(args.title) || `${args.agentId} thread`

  db.prepare(
    `
        INSERT INTO agent_threads (
            id, conversationId, agentId, createdByAgentId, parentAgentThreadId,
            title, summary, provider, model, status, createdAt, updatedAt
        ) VALUES (
            @id, @conversationId, @agentId, @createdByAgentId, @parentAgentThreadId,
            @title, NULL, @provider, @model, 'active', @createdAt, @updatedAt
        )
    `
  ).run({
    id,
    conversationId: args.conversationId,
    agentId: args.agentId,
    createdByAgentId: args.createdByAgentId,
    parentAgentThreadId: args.parentAgentThreadId ?? null,
    title,
    provider: args.provider ?? null,
    model: args.model ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const row = getAgentThread(id)
  if (!row) throw new Error(`Failed to create agent thread ${id}`)
  return row
}

export function getAgentThread(id: string): AgentThread | null {
  const row = db
    .prepare(
      `
        SELECT *
        FROM agent_threads
        WHERE id = ?
    `
    )
    .get(id) as AgentThread | undefined
  return row ? normalizeAgentThread(row) : null
}

export function listAgentThreadsForContext(args: {
  conversationId: string
  createdByAgentId: string
  parentAgentThreadId?: string | null
  limit?: number
}): AgentThread[] {
  const limit = Math.max(1, Math.min(args.limit ?? 12, 50))
  const parent = args.parentAgentThreadId ?? null
  const rows = parent
    ? db
        .prepare(
          `
            SELECT *
            FROM agent_threads
            WHERE conversationId = @conversationId
              AND createdByAgentId = @createdByAgentId
              AND parentAgentThreadId = @parentAgentThreadId
              AND status = 'active'
            ORDER BY updatedAt DESC
            LIMIT @limit
        `
        )
        .all({
          conversationId: args.conversationId,
          createdByAgentId: args.createdByAgentId,
          parentAgentThreadId: parent,
          limit,
        })
    : db
        .prepare(
          `
            SELECT *
            FROM agent_threads
            WHERE conversationId = @conversationId
              AND createdByAgentId = @createdByAgentId
              AND parentAgentThreadId IS NULL
              AND status = 'active'
            ORDER BY updatedAt DESC
            LIMIT @limit
        `
        )
        .all({
          conversationId: args.conversationId,
          createdByAgentId: args.createdByAgentId,
          limit,
        })
  return (rows as AgentThread[]).map(normalizeAgentThread)
}

export function getAgentThreadMessages(threadId: string): AgentThreadMessage[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM agent_thread_messages
        WHERE threadId = ?
        ORDER BY timestamp ASC
    `
    )
    .all(threadId) as AgentThreadMessage[]
  return rows.map(normalizeAgentThreadMessage)
}

export function addAgentThreadMessage(
  threadId: string,
  message: {
    role: "user" | "assistant"
    content: string
    requestId?: string | null
    timestamp?: number
  }
): AgentThreadMessage {
  const now = message.timestamp ?? Date.now()
  const row: AgentThreadMessage = {
    id: `atm_${randomUUID()}`,
    threadId,
    role: message.role,
    content: message.content,
    requestId: message.requestId ?? null,
    timestamp: now,
  }
  db.prepare(
    `
        INSERT INTO agent_thread_messages (id, threadId, role, content, requestId, timestamp)
        VALUES (@id, @threadId, @role, @content, @requestId, @timestamp)
    `
  ).run(row)
  db.prepare(
    `
        UPDATE agent_threads
        SET updatedAt = @updatedAt
        WHERE id = @threadId
    `
  ).run({ threadId, updatedAt: now })
  return row
}

export function addAgentThreadTurn(
  threadId: string,
  args: {
    prompt: string
    output: string
    requestId?: string | null
    timestamp?: number
  }
) {
  const start = args.timestamp ?? Date.now()
  const insert = db.prepare(`
        INSERT INTO agent_thread_messages (id, threadId, role, content, requestId, timestamp)
        VALUES (@id, @threadId, @role, @content, @requestId, @timestamp)
    `)
  const update = db.prepare(`
        UPDATE agent_threads
        SET updatedAt = @updatedAt
        WHERE id = @threadId
    `)
  const transaction = db.transaction(() => {
    insert.run({
      id: `atm_${randomUUID()}`,
      threadId,
      role: "user",
      content: args.prompt,
      requestId: args.requestId ?? null,
      timestamp: start,
    })
    insert.run({
      id: `atm_${randomUUID()}`,
      threadId,
      role: "assistant",
      content: args.output,
      requestId: args.requestId ?? null,
      timestamp: start + 1,
    })
    update.run({ threadId, updatedAt: Date.now() })
  })
  transaction()
}

export function touchAgentThreadRuntime(
  threadId: string,
  provider: string,
  model: string
) {
  db.prepare(
    `
        UPDATE agent_threads
        SET provider = @provider,
            model = @model,
            updatedAt = @updatedAt
        WHERE id = @threadId
    `
  ).run({
    threadId,
    provider,
    model,
    updatedAt: Date.now(),
  })
}

export function updateAgentThreadInteractionId(
  threadId: string,
  provider: string,
  model: string,
  interactionId: string
) {
  db.prepare(
    `
        UPDATE agent_threads
        SET lastInteractionProvider = @provider,
            lastInteractionModel = @model,
            lastInteractionId = @interactionId,
            lastInteractionAt = @now,
            updatedAt = @now
        WHERE id = @threadId
    `
  ).run({
    threadId,
    provider,
    model,
    interactionId,
    now: Date.now(),
  })
}

export function getAgentThreadInteractionId(
  threadId: string,
  provider: string,
  model: string
): { id: string; at: number } | null {
  const row = db
    .prepare(
      `
        SELECT lastInteractionProvider, lastInteractionModel, lastInteractionId, lastInteractionAt
        FROM agent_threads
        WHERE id = ?
    `
    )
    .get(threadId) as
    | {
        lastInteractionProvider: string | null
        lastInteractionModel: string | null
        lastInteractionId: string | null
        lastInteractionAt: number | null
      }
    | undefined

  if (!row?.lastInteractionId || !row.lastInteractionAt) return null
  if (row.lastInteractionProvider && row.lastInteractionProvider !== provider)
    return null
  if (row.lastInteractionModel) {
    return row.lastInteractionModel === model
      ? { id: row.lastInteractionId, at: row.lastInteractionAt }
      : null
  }
  if (
    !agentThreadInteractionLogMatches({
      threadId,
      interactionId: row.lastInteractionId,
      provider,
      model,
    })
  )
    return null
  return { id: row.lastInteractionId, at: row.lastInteractionAt }
}

function agentThreadInteractionLogMatches(args: {
  threadId: string
  interactionId: string
  provider: string
  model: string
}): boolean {
  const legacy = db
    .prepare(
      `
        SELECT provider, model
        FROM request_logs
        WHERE agentThreadId = ? AND interactionId = ?
        ORDER BY endedAt DESC, startedAt DESC
        LIMIT 1
    `
    )
    .get(args.threadId, args.interactionId) as
    | { provider: string; model: string }
    | undefined

  return legacy?.provider === args.provider && legacy.model === args.model
}

function cleanAgentThreadTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
}

/**
 * Collect attachment ids referenced by every message in a conversation. Used
 * by deleteConversation() to know which upload files to remove from disk
 * before the FK-cascade wipes the message rows that pointed to them.
 */
function collectConversationAttachmentIds(conversationId: string): string[] {
  const rows = db
    .prepare(
      "SELECT attachments FROM messages WHERE conversationId = ? AND attachments IS NOT NULL"
    )
    .all(conversationId) as { attachments: string | null }[]

  const ids: string[] = []
  for (const row of rows) {
    if (!row.attachments) continue
    try {
      const parsed = JSON.parse(row.attachments) as Attachment[]
      for (const att of parsed) {
        if (typeof att?.id === "string") ids.push(att.id)
      }
    } catch {
      /* skip rows with malformed JSON — nothing safe to do here */
    }
  }
  return ids
}

function unlinkUploadIfExists(attachmentId: string) {
  // attachment.id already includes the extension (e.g. "abc.pdf"), matching
  // the filename written by /api/upload. Resolving + sandbox-check guards
  // against path traversal in case a malformed id ever lands in storage.
  const target = path.resolve(UPLOADS_DIR, attachmentId)
  if (!target.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target)
  } catch (err) {
    console.warn("Failed to remove orphaned upload", attachmentId, err)
  }
}

function resolveExistingPathInside(
  rootDir: string,
  filePath: string
): string | null {
  try {
    const root = fs.realpathSync(rootDir)
    const target = fs.realpathSync(filePath)
    const rel = path.relative(root, target)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
    return target
  } catch {
    return null
  }
}

function pruneEmptyDirsInside(rootDir: string, startDir: string) {
  let root: string
  try {
    root = fs.realpathSync(rootDir)
  } catch {
    return
  }

  let dir = path.resolve(startDir)
  while (dir !== root) {
    const rel = path.relative(root, dir)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return
    try {
      fs.rmdirSync(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

function collectConversationArtifactFilePaths(
  conversationId: string
): string[] {
  const rows = db
    .prepare(
      "SELECT filePath FROM artifacts WHERE conversationId = ? AND filePath IS NOT NULL"
    )
    .all(conversationId) as { filePath: string | null }[]

  return Array.from(
    new Set(
      rows
        .map((row) => row.filePath)
        .filter(
          (filePath): filePath is string =>
            typeof filePath === "string" && filePath.length > 0
        )
    )
  )
}

function unlinkArtifactIfExists(filePath: string) {
  const target = resolveExistingPathInside(ARTIFACTS_DIR, filePath)
  if (!target) return
  try {
    fs.unlinkSync(target)
    pruneEmptyDirsInside(ARTIFACTS_DIR, path.dirname(target))
  } catch (err) {
    console.warn("Failed to remove artifact backing file", filePath, err)
  }
}

export function deleteConversation(id: string) {
  // Remove on-disk uploads BEFORE the FK cascade clears their references,
  // otherwise we lose the link from message → filename and the files leak
  // into .orchestrator/uploads forever.
  const attachmentIds = collectConversationAttachmentIds(id)
  const artifactFilePaths = collectConversationArtifactFilePaths(id)
  for (const att of attachmentIds) unlinkUploadIfExists(att)
  for (const filePath of artifactFilePaths) unlinkArtifactIfExists(filePath)

  // Foreign key constraint with ON DELETE CASCADE will handle messages
  const stmt = db.prepare("DELETE FROM conversations WHERE id = ?")
  stmt.run(id)

  emitChatEvent({
    type: "delete_conversation",
    payload: { id },
  })
}

/**
 * Sweep .orchestrator/uploads for files that are no longer referenced by any
 * message attachment. Runs once at startup as a safety net — covers crashes
 * during delete, schema migrations, manual DB edits, and any pre-cleanup
 * conversations deleted before the cleanup logic existed.
 *
 * Best-effort: errors are logged, never thrown — the app must boot regardless.
 */
function cleanupOrphanUploads(): { scanned: number; removed: number } {
  let scanned = 0
  let removed = 0
  try {
    // Production builds use an isolated temporary DB, so the real uploads
    // directory cannot be reconciled safely from this process.
    if (isProductionBuild) return { scanned: 0, removed: 0 }
    if (!fs.existsSync(UPLOADS_DIR)) return { scanned: 0, removed: 0 }

    const rows = db
      .prepare("SELECT attachments FROM messages WHERE attachments IS NOT NULL")
      .all() as { attachments: string | null }[]

    const referenced = new Set<string>()
    for (const row of rows) {
      if (!row.attachments) continue
      try {
        const parsed = JSON.parse(row.attachments) as Attachment[]
        for (const att of parsed) {
          if (typeof att?.id === "string") referenced.add(att.id)
        }
      } catch {
        /* skip malformed rows */
      }
    }

    const onDisk = fs.readdirSync(UPLOADS_DIR)
    for (const name of onDisk) {
      scanned++
      if (referenced.has(name)) continue
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, name))
        removed++
      } catch (err) {
        console.warn("Orphan-upload GC: failed to remove", name, err)
      }
    }
  } catch (err) {
    console.warn("Orphan-upload GC: scan failed", err)
  }
  return { scanned, removed }
}

// Run GC once at module load. Module is loaded eagerly when any DB function
// is first imported, so this catches every server startup including dev HMR.
{
  const r = cleanupOrphanUploads()
  if (r.removed > 0) {
    console.log(
      `[upload-gc] removed ${r.removed} orphaned upload(s) of ${r.scanned} scanned`
    )
  }
}

export default db
