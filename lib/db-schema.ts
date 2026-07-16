// Database schema and one-time migrations for the shared SQLite store.
// Keep data-shape changes here so lib/db.ts stays focused on persistence APIs.

interface SqliteExecutor {
  exec(sql: string): unknown
}

export function initializeDatabaseSchema(db: SqliteExecutor): void {
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
          durationMs INTEGER,
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
          usageCorrectionVersion TEXT,
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
          toolCallId TEXT,
          toolName TEXT NOT NULL,
          title TEXT,
          phase INTEGER,
          argsJson TEXT,
          resultText TEXT,
          deltasJson TEXT,
          success INTEGER NOT NULL,
          startedAt INTEGER NOT NULL,
          durationMs INTEGER,
          errorMessage TEXT
      );

      -- Heavy per-request transcript (interleaved thinking + tool_call entries and
      -- the matching content segments) kept OUT of request_logs so the Logs list
      -- query stays slim. Written once at request completion, read only when a row
      -- is expanded in the Logs detail. One row per request; cleared with the logs.
      CREATE TABLE IF NOT EXISTS request_log_reasoning (
          requestId TEXT PRIMARY KEY,
          reasoning TEXT,
          contentSegments TEXT
      );

      -- The full, exact input sent to the provider for a request: the complete
      -- system prompt and the resolved messages (with injected memories /
      -- runtime / attachment context already inlined), plus the exposed tool
      -- names. Kept OUT of request_logs so the list query stays slim; written
      -- once right before the provider call, read only when a row is expanded
      -- in the Logs detail. One row per request; cleared with the logs.
      CREATE TABLE IF NOT EXISTS request_log_input (
          requestId TEXT PRIMARY KEY,
          systemPrompt TEXT,
          messages TEXT,
          tools TEXT,
          createdAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_input_created ON request_log_input(createdAt);

      CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          appliedAt INTEGER NOT NULL
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

      -- Asynchronous specialist delegation. A batch may contain one or many
      -- child runs. Unlike synchronous delegate_to/delegate_parallel calls,
      -- the parent model is allowed to continue while these rows are active,
      -- then collect/wait/cancel them through manage_delegations. The worker
      -- also registers each live batch in the update-drain registry; these
      -- rows are the durable recovery/status record if the process dies.
      CREATE TABLE IF NOT EXISTS async_delegation_batches (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          createdByAgentId TEXT NOT NULL,
          parentAgentThreadId TEXT,
          parentRequestId TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running', -- running | ok | error | aborted | lost
          maxConcurrency INTEGER NOT NULL DEFAULT 1,
          wakeOnComplete INTEGER NOT NULL DEFAULT 0,
          startedAt INTEGER NOT NULL,
          endedAt INTEGER,
          notifiedAt INTEGER,
          collectedAt INTEGER,
          FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE,
          FOREIGN KEY (parentAgentThreadId) REFERENCES agent_threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_async_delegation_batches_scope
          ON async_delegation_batches(conversationId, createdByAgentId, parentAgentThreadId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_async_delegation_batches_status
          ON async_delegation_batches(status, startedAt DESC);

      CREATE TABLE IF NOT EXISTS async_delegation_jobs (
          id TEXT PRIMARY KEY,
          batchId TEXT NOT NULL,
          agentId TEXT NOT NULL,
          agentThreadId TEXT NOT NULL,
          assignedName TEXT,
          taskLabel TEXT,
          prompt TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued', -- queued | running | ok | error | aborted | lost
          result TEXT,
          error TEXT,
          startedAt INTEGER,
          endedAt INTEGER,
          FOREIGN KEY (batchId) REFERENCES async_delegation_batches(id) ON DELETE CASCADE,
          FOREIGN KEY (agentThreadId) REFERENCES agent_threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_async_delegation_jobs_batch
          ON async_delegation_jobs(batchId, position);
      CREATE INDEX IF NOT EXISTS idx_async_delegation_jobs_status
          ON async_delegation_jobs(status, startedAt DESC);

      -- Tracked background jobs (Bash run_in_background / start_background_job).
      -- Jobs are detached OS processes owned by the server, not by the agent
      -- turn that started them; on exit the server posts a completion notice
      -- into the owning conversation (steering queue if a turn is streaming,
      -- headless wake turn otherwise). conversationId is a soft reference on
      -- purpose: deleting a conversation must not orphan-kill the OS process
      -- bookkeeping mid-run.
      CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          conversationId TEXT,
          command TEXT NOT NULL,
          description TEXT,
          cwd TEXT,
          pid INTEGER,
          logPath TEXT NOT NULL,
          exitMarkerPath TEXT,
          status TEXT NOT NULL DEFAULT 'running', -- running | exited | failed | killed | lost
          exitCode INTEGER,
          wakeOnExit INTEGER NOT NULL DEFAULT 1,
          runner TEXT NOT NULL DEFAULT 'process', -- process | container
          containerName TEXT,
          startedAt INTEGER NOT NULL,
          endedAt INTEGER,
          notifiedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_background_jobs_conversation ON background_jobs(conversationId, startedAt DESC);

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

      CREATE TABLE IF NOT EXISTS apps (
          -- Registry of reusable internal mini-apps. The app's code is a normal
          -- versioned artifact; artifactId points at the current code version.
          -- Soft reference on purpose: artifacts get deleted directly and via
          -- conversation cascade, and a hard FK would make those deletes throw.
          -- Dangling pointers surface as codeMissing in lib/apps/store.ts.
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          artifactId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apps_updated ON apps(updatedAt DESC);

      CREATE TABLE IF NOT EXISTS app_data (
          appId TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updatedAt INTEGER NOT NULL,
          FOREIGN KEY (appId) REFERENCES apps (id) ON DELETE CASCADE
      );
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
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_started ON scheduled_task_runs(startedAt DESC);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          subscription TEXT NOT NULL,
          userAgent TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated ON push_subscriptions(updatedAt DESC);

      -- Audit log for one-click direct actions on Inbox quick-reply buttons.
      -- The agent can read recent rows via the inbox_action_history tool to
      -- learn the user's housekeeping preferences across runs.
      CREATE TABLE IF NOT EXISTS inbox_direct_action_log (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          messageId TEXT NOT NULL,
          actionId TEXT NOT NULL,
          tool TEXT NOT NULL,
          params TEXT,                     -- JSON of the params passed to the tool
          result TEXT NOT NULL,            -- 'ok' | 'error'
          errorMessage TEXT,
          sourceKind TEXT NOT NULL,        -- 'gmail' | 'whatsapp'
          sourceTarget TEXT NOT NULL,      -- gmail messageId or whatsapp chatId
          createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_direct_action_log_created
          ON inbox_direct_action_log(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_direct_action_log_source
          ON inbox_direct_action_log(sourceKind, createdAt DESC);

      CREATE TABLE IF NOT EXISTS audio_context_cache (
          cacheKey TEXT PRIMARY KEY,
          attachmentId TEXT NOT NULL,
          filename TEXT,
          mimeType TEXT NOT NULL,
          size INTEGER NOT NULL,
          fileMtimeMs REAL NOT NULL,
          promptVersion INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          content TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audio_context_cache_attachment
          ON audio_context_cache(attachmentId);
      CREATE INDEX IF NOT EXISTS idx_audio_context_cache_updated
          ON audio_context_cache(updatedAt DESC);
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
    db.exec(
      `ALTER TABLE conversations ADD COLUMN forkedFromConversationId TEXT`
    )
  } catch {
    /* column already exists */
  }
  // Migration: background jobs learn which runner owns them ('process' =
  // detached child of this server, 'container' = per-job Docker container via
  // the host bridge) so reconcile/kill route correctly after upgrades.
  try {
    db.exec(`ALTER TABLE background_jobs ADD COLUMN runner TEXT NOT NULL DEFAULT 'process'`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE background_jobs ADD COLUMN containerName TEXT`)
  } catch {
    /* column already exists */
  }

  // Migration: Inbox item → Smart Monitor watch linkage (JSON string[] of
  // watch ids). Set when a monitor wake's notify_inbox surfaces; read by the
  // inbox surface to record user_signal events for behavioral learning.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN monitorWatchIds TEXT`)
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
    db.exec(`ALTER TABLE messages ADD COLUMN durationMs INTEGER`)
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
  try {
    db.exec(`ALTER TABLE request_logs ADD COLUMN usageCorrectionVersion TEXT`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN toolCallId TEXT`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN title TEXT`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN phase INTEGER`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN argsJson TEXT`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN resultText TEXT`)
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE tool_logs ADD COLUMN deltasJson TEXT`)
  } catch {
    /* column already exists */
  }

  // Backfill: Codex app-server used to persist tokenUsage.total as the request
  // usage. On resumed stateful threads that field is cumulative for the whole
  // thread, so later rows looked like tens of millions of input/cache tokens.
  // Convert existing rows once by subtracting the previous row on the same
  // app-server interaction. New rows are already written as per-turn deltas.
  try {
    db.exec(`
      WITH legacy_rows AS (
        SELECT
          id,
          LAG(inputTokens) OVER (
            PARTITION BY interactionId ORDER BY startedAt, id
          ) AS prevInputTokens,
          LAG(cachedTokens) OVER (
            PARTITION BY interactionId ORDER BY startedAt, id
          ) AS prevCachedTokens,
          LAG(outputTokens) OVER (
            PARTITION BY interactionId ORDER BY startedAt, id
          ) AS prevOutputTokens,
          LAG(thinkingTokens) OVER (
            PARTITION BY interactionId ORDER BY startedAt, id
          ) AS prevThinkingTokens,
          LAG(totalTokens) OVER (
            PARTITION BY interactionId ORDER BY startedAt, id
          ) AS prevTotalTokens
        FROM request_logs
        WHERE provider = 'codex'
          AND statefulMode = 1
          AND interactionId LIKE 'appserver:%'
          AND usageCorrectionVersion IS NULL
      ),
      deltas AS (
        SELECT
          request_logs.id AS id,
          request_logs.inputTokens - legacy_rows.prevInputTokens AS inputTokens,
          CASE
            WHEN request_logs.cachedTokens IS NOT NULL
             AND legacy_rows.prevCachedTokens IS NOT NULL
             AND request_logs.cachedTokens >= legacy_rows.prevCachedTokens
            THEN request_logs.cachedTokens - legacy_rows.prevCachedTokens
            ELSE request_logs.cachedTokens
          END AS cachedTokens,
          request_logs.outputTokens - legacy_rows.prevOutputTokens AS outputTokens,
          CASE
            WHEN request_logs.thinkingTokens IS NOT NULL
             AND legacy_rows.prevThinkingTokens IS NOT NULL
             AND request_logs.thinkingTokens >= legacy_rows.prevThinkingTokens
            THEN request_logs.thinkingTokens - legacy_rows.prevThinkingTokens
            ELSE request_logs.thinkingTokens
          END AS thinkingTokens,
          request_logs.totalTokens - legacy_rows.prevTotalTokens AS totalTokens
        FROM request_logs
        JOIN legacy_rows ON legacy_rows.id = request_logs.id
        WHERE legacy_rows.prevInputTokens IS NOT NULL
          AND legacy_rows.prevOutputTokens IS NOT NULL
          AND legacy_rows.prevTotalTokens IS NOT NULL
          AND request_logs.inputTokens IS NOT NULL
          AND request_logs.outputTokens IS NOT NULL
          AND request_logs.totalTokens IS NOT NULL
          AND request_logs.inputTokens >= legacy_rows.prevInputTokens
          AND request_logs.outputTokens >= legacy_rows.prevOutputTokens
          AND request_logs.totalTokens >= legacy_rows.prevTotalTokens
          AND NOT EXISTS (
            SELECT 1 FROM schema_migrations
            WHERE id = 'codex-appserver-turn-delta-v1'
          )
      )
      UPDATE request_logs
      SET
        inputTokens = (SELECT inputTokens FROM deltas WHERE deltas.id = request_logs.id),
        cachedTokens = (SELECT cachedTokens FROM deltas WHERE deltas.id = request_logs.id),
        outputTokens = (SELECT outputTokens FROM deltas WHERE deltas.id = request_logs.id),
        thinkingTokens = (SELECT thinkingTokens FROM deltas WHERE deltas.id = request_logs.id),
        totalTokens = (SELECT totalTokens FROM deltas WHERE deltas.id = request_logs.id),
        usageCorrectionVersion = 'codex-appserver-turn-delta-v1'
      WHERE id IN (SELECT id FROM deltas);

      INSERT OR IGNORE INTO schema_migrations (id, appliedAt)
      VALUES ('codex-appserver-turn-delta-v1', strftime('%s', 'now') * 1000);
    `)
  } catch {
    /* best-effort historical usage backfill */
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
}
