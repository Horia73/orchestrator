import { randomUUID } from "crypto"

import db, { createConversation, deleteConversation } from "@/lib/db"
import { emitAppEvent } from "@/lib/events"
import { appendRuntimeRunIndex } from "@/lib/runtime-index"
import type { InboxReplyAction, Message } from "@/lib/types"
import { copyArtifactsForMessageMap } from "@/lib/artifacts/store"
import { stripArtifactBlocksForPreview } from "@/lib/artifacts/text"

import {
  CreateScheduledTaskInputSchema,
  ScheduledActionSchema,
  ScheduleSpecSchema,
  type CreateScheduledTaskInput,
  type ScheduledAction,
  type ScheduledTaskCreatedBy,
  type ScheduledTask,
  type ScheduledTaskStatus,
  type ScheduleSpec,
  type UpdateScheduledTaskInput,
  UpdateScheduledTaskInputSchema,
} from "./schema"
import {
  assertSchedulable,
  computeNextRunAt,
  ensureEveryStartAt,
} from "./compute"

// Recurring tasks auto-pause after this many consecutive failures so a bad
// prompt or broken integration cannot loop forever (cost / runaway guard).
const MAX_CONSECUTIVE_FAILURES = 5

// One-shot tasks in a terminal run state are kept briefly so the user can still
// see "it ran / it was missed / it failed", then auto-pruned so completed
// throwaway tasks don't accumulate forever. Errors linger longer than successes
// because they are diagnostic. The surfaced Inbox result lives in a separate
// conversation and is NOT removed by pruning — only the task row + its run
// history (which is unreachable once the task is gone) are dropped.
const TERMINAL_ONESHOT_TTL_MS = 24 * 60 * 60_000 // done, missed
const FAILED_ONESHOT_TTL_MS = 72 * 60 * 60_000 // error

function emitScheduledTaskChanged(taskId: string, reason: string) {
  emitAppEvent({ type: "scheduled_tasks.changed", taskId, reason })
}

function emitTaskRunsChanged(taskId: string, runId?: string) {
  emitAppEvent({ type: "task_runs.changed", taskId, runId })
}

function emitInboxChanged(
  conversationId: string,
  action: "created" | "read" | "deleted" | "changed"
) {
  emitAppEvent({ type: "inbox.changed", conversationId, action })
}

// ---------------------------------------------------------------------------
// scheduled_tasks CRUD
// ---------------------------------------------------------------------------

interface ScheduledTaskRow {
  id: string
  title: string
  enabled: number
  status: string
  action: string
  schedule: string
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: string | null
  lastRunError: string | null
  lastConversationId: string | null
  runCount: number
  consecutiveFailures: number
  createdBy: string
  createdAt: number
  updatedAt: number
}

function taskFromRow(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    title: row.title,
    enabled: row.enabled === 1,
    status: row.status as ScheduledTaskStatus,
    action: ScheduledActionSchema.parse(JSON.parse(row.action)),
    schedule: ScheduleSpecSchema.parse(JSON.parse(row.schedule)),
    nextRunAt: row.nextRunAt ?? null,
    lastRunAt: row.lastRunAt ?? null,
    lastRunStatus:
      (row.lastRunStatus as ScheduledTask["lastRunStatus"]) ?? null,
    lastRunError: row.lastRunError ?? null,
    lastConversationId: row.lastConversationId ?? null,
    runCount: row.runCount,
    consecutiveFailures: row.consecutiveFailures,
    createdBy: (row.createdBy === "orchestrator" || row.createdBy === "system"
      ? row.createdBy
      : "user") as ScheduledTaskCreatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function getScheduledTask(id: string): ScheduledTask | null {
  const row = db
    .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
    .get(id) as ScheduledTaskRow | undefined
  return row ? taskFromRow(row) : null
}

export function listScheduledTasks(): ScheduledTask[] {
  const rows = db
    .prepare("SELECT * FROM scheduled_tasks ORDER BY createdAt DESC")
    .all() as ScheduledTaskRow[]
  return rows.map(taskFromRow)
}

/** Validates + schedules a new task. Throws InvalidScheduleError / ZodError on bad input. */
export function createScheduledTask(
  input: CreateScheduledTaskInput
): ScheduledTask {
  const parsed = CreateScheduledTaskInputSchema.parse(input)
  const now = Date.now()
  const schedule =
    parsed.schedule.kind === "every" &&
    (parsed.enabled || typeof parsed.schedule.startAt === "number")
      ? ensureEveryStartAt(parsed.schedule, now + parsed.schedule.everyMs)
      : parsed.schedule
  const id = `sch_${randomUUID()}`

  let status: ScheduledTaskStatus
  let nextRunAt: number | null
  if (!parsed.enabled) {
    status = "paused"
    nextRunAt = null
  } else {
    assertSchedulable(schedule, now)
    nextRunAt = computeNextRunAt(schedule, now)
    status = "scheduled"
  }

  db.prepare(
    `
        INSERT INTO scheduled_tasks (
            id, title, enabled, status, action, schedule, nextRunAt,
            lastRunAt, lastRunStatus, lastRunError, lastConversationId,
            runCount, consecutiveFailures, createdBy, createdAt, updatedAt
        ) VALUES (
            @id, @title, @enabled, @status, @action, @schedule, @nextRunAt,
            NULL, NULL, NULL, NULL,
            0, 0, @createdBy, @createdAt, @updatedAt
        )
    `
  ).run({
    id,
    title: parsed.title,
    enabled: parsed.enabled ? 1 : 0,
    status,
    action: JSON.stringify(parsed.action),
    schedule: JSON.stringify(schedule),
    nextRunAt,
    createdBy: parsed.createdBy,
    createdAt: now,
    updatedAt: now,
  })

  const created = getScheduledTask(id)
  if (!created) throw new Error(`Failed to create scheduled task ${id}`)
  emitScheduledTaskChanged(id, "created")
  return created
}

export function updateScheduledTask(
  id: string,
  patch: UpdateScheduledTaskInput
): ScheduledTask | null {
  const current = getScheduledTask(id)
  if (!current) return null
  const parsed = UpdateScheduledTaskInputSchema.parse(patch)
  const now = Date.now()

  const title = parsed.title ?? current.title
  const action: ScheduledAction = parsed.action ?? current.action
  const requestedSchedule: ScheduleSpec = parsed.schedule ?? current.schedule
  const defaultEveryStartAt =
    requestedSchedule.kind === "every"
      ? parsed.schedule !== undefined
        ? now + requestedSchedule.everyMs
        : (current.nextRunAt ?? now + requestedSchedule.everyMs)
      : now
  const schedule: ScheduleSpec =
    requestedSchedule.kind === "every"
      ? ensureEveryStartAt(requestedSchedule, defaultEveryStartAt)
      : requestedSchedule
  const enabled = parsed.enabled ?? current.enabled

  // Recompute the next fire whenever schedule or enabled state changed; a
  // schedule edit always re-arms a paused/done/missed/errored task.
  const scheduleChanged = parsed.schedule !== undefined
  const scheduleNormalized = schedule !== requestedSchedule
  const enabledChanged =
    parsed.enabled !== undefined && parsed.enabled !== current.enabled

  let status: ScheduledTaskStatus = current.status
  let nextRunAt: number | null = current.nextRunAt
  if (!enabled) {
    status = "paused"
    nextRunAt = null
  } else if (
    scheduleChanged ||
    scheduleNormalized ||
    enabledChanged ||
    current.status === "paused" ||
    current.status === "missed"
  ) {
    assertSchedulable(schedule, now)
    nextRunAt = computeNextRunAt(schedule, now)
    status = "scheduled"
  }

  db.prepare(
    `
        UPDATE scheduled_tasks
        SET title = @title, enabled = @enabled, status = @status,
            action = @action, schedule = @schedule, nextRunAt = @nextRunAt,
            updatedAt = @updatedAt
        WHERE id = @id
    `
  ).run({
    id,
    title,
    enabled: enabled ? 1 : 0,
    status,
    action: JSON.stringify(action),
    schedule: JSON.stringify(schedule),
    nextRunAt,
    updatedAt: now,
  })

  const updatedTask = getScheduledTask(id)
  if (updatedTask) emitScheduledTaskChanged(id, "updated")
  return updatedTask
}

export function deleteScheduledTask(id: string): boolean {
  const res = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id)
  const deleted = res.changes > 0
  if (deleted) emitScheduledTaskChanged(id, "deleted")
  return deleted
}

/**
 * Drop one-shot tasks that have reached a terminal run state (done / missed /
 * error) and sat past their retention window, together with their now-unreachable
 * run history. Recurring tasks and user-paused tasks are never touched. Surfaced
 * Inbox conversations are independent and intentionally preserved. Returns the
 * ids removed so the caller can log. Cheap and idempotent — safe to call often.
 */
export function pruneTerminalOneShots(nowMs: number): string[] {
  const doneMissedThreshold = nowMs - TERMINAL_ONESHOT_TTL_MS
  const errorThreshold = nowMs - FAILED_ONESHOT_TTL_MS
  const run = db.transaction((): string[] => {
    const rows = db
      .prepare(
        `
        SELECT id FROM scheduled_tasks
        WHERE json_extract(schedule, '$.kind') = 'once'
          AND (
            (status IN ('done', 'missed') AND updatedAt < @doneMissedThreshold)
            OR (status = 'error' AND updatedAt < @errorThreshold)
          )
      `
      )
      .all({ doneMissedThreshold, errorThreshold }) as Array<{ id: string }>
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const deleteRuns = db.prepare(
      "DELETE FROM scheduled_task_runs WHERE taskId = ?"
    )
    const deleteTask = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?")
    for (const id of ids) {
      deleteRuns.run(id)
      deleteTask.run(id)
    }
    return ids
  })
  const ids = run()
  // One coalesced event is enough — the Scheduling UI refetches the whole list
  // on any scheduled_tasks.changed.
  if (ids.length > 0) emitScheduledTaskChanged(ids[ids.length - 1], "pruned")
  return ids
}

// ---------------------------------------------------------------------------
// Scheduler runtime helpers
// ---------------------------------------------------------------------------

/** Tasks whose nextRunAt has arrived and are eligible to fire. */
export function getDueCandidates(nowMs: number): ScheduledTask[] {
  const rows = db
    .prepare(
      `
        SELECT * FROM scheduled_tasks
        WHERE enabled = 1
          AND status IN ('scheduled', 'error')
          AND nextRunAt IS NOT NULL
          AND nextRunAt <= ?
        ORDER BY nextRunAt ASC
    `
    )
    .all(nowMs) as ScheduledTaskRow[]
  return rows.map(taskFromRow)
}

export interface ClaimedTask {
  task: ScheduledTask
  isOnce: boolean
}

/**
 * Atomically take ownership of a due task: flips it to `running` and advances
 * (recurring) or clears (one-shot) nextRunAt BEFORE execution so a slow run or
 * an overlapping tick can never double-fire. Returns null if another tick won
 * the race.
 */
export function claimForRun(id: string, nowMs: number): ClaimedTask | null {
  const tx = db.transaction((): ClaimedTask | null => {
    const row = db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRow | undefined
    if (!row) return null
    if (
      row.enabled !== 1 ||
      (row.status !== "scheduled" && row.status !== "error")
    )
      return null

    const task = taskFromRow(row)
    const isOnce = task.schedule.kind === "once"
    const runSchedule =
      task.schedule.kind === "every"
        ? ensureEveryStartAt(
            task.schedule,
            task.nextRunAt ?? nowMs + task.schedule.everyMs
          )
        : task.schedule
    const advancedNext = isOnce ? null : computeNextRunAt(runSchedule, nowMs)

    db.prepare(
      `
            UPDATE scheduled_tasks
            SET status = 'running', schedule = @schedule, nextRunAt = @nextRunAt, updatedAt = @now
            WHERE id = @id
        `
    ).run({
      id,
      schedule: JSON.stringify(runSchedule),
      nextRunAt: advancedNext,
      now: nowMs,
    })

    return {
      task:
        runSchedule === task.schedule
          ? task
          : { ...task, schedule: runSchedule },
      isOnce,
    }
  })
  const claimed = tx()
  if (claimed) emitScheduledTaskChanged(id, "running")
  return claimed
}

/** One-shot whose time passed while the server was down: do NOT run it. */
export function markMissed(id: string, nowMs: number): ScheduledTask | null {
  db.prepare(
    `
        UPDATE scheduled_tasks
        SET status = 'missed', nextRunAt = NULL,
            lastRunAt = @now, lastRunStatus = 'missed', updatedAt = @now
        WHERE id = @id
    `
  ).run({ id, now: nowMs })
  const task = getScheduledTask(id)
  if (task) emitScheduledTaskChanged(id, "missed")
  return task
}

export function finishRun(
  id: string,
  result: {
    ok: boolean
    isOnce: boolean
    conversationId: string | null
    error?: string | null
    nowMs: number
  }
): void {
  const current = getScheduledTask(id)
  if (!current) return

  const consecutiveFailures = result.ok ? 0 : current.consecutiveFailures + 1
  let status: ScheduledTaskStatus
  let enabled = current.enabled
  let nextRunAt = current.nextRunAt

  if (result.isOnce) {
    status = result.ok ? "done" : "error"
    nextRunAt = null
  } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // Runaway guard: a recurring task that keeps failing is auto-paused.
    status = "paused"
    enabled = false
    nextRunAt = null
  } else {
    status = result.ok ? "scheduled" : "error"
  }

  db.prepare(
    `
        UPDATE scheduled_tasks
        SET status = @status, enabled = @enabled, nextRunAt = @nextRunAt,
            lastRunAt = @now, lastRunStatus = @lastRunStatus,
            lastRunError = @lastRunError, lastConversationId = @conversationId,
            runCount = runCount + 1, consecutiveFailures = @consecutiveFailures,
            updatedAt = @now
        WHERE id = @id
    `
  ).run({
    id,
    status,
    enabled: enabled ? 1 : 0,
    nextRunAt,
    now: result.nowMs,
    lastRunStatus: result.ok ? "ok" : "error",
    lastRunError: result.ok ? null : (result.error ?? "Unknown error"),
    conversationId: result.conversationId,
    consecutiveFailures,
  })
  emitScheduledTaskChanged(id, "finished")
}

/** Record a manual "Run now" without consuming/disarming the schedule. */
export function recordManualRun(
  id: string,
  result: {
    ok: boolean
    conversationId: string | null
    error?: string | null
    nowMs: number
  }
): void {
  const current = getScheduledTask(id)
  if (!current) return
  db.prepare(
    `
        UPDATE scheduled_tasks
        SET lastRunAt = @now, lastRunStatus = @lastRunStatus,
            lastRunError = @lastRunError, lastConversationId = @conversationId,
            runCount = runCount + 1,
            consecutiveFailures = @consecutiveFailures, updatedAt = @now
        WHERE id = @id
    `
  ).run({
    id,
    now: result.nowMs,
    lastRunStatus: result.ok ? "ok" : "error",
    lastRunError: result.ok ? null : (result.error ?? "Unknown error"),
    conversationId: result.conversationId,
    consecutiveFailures: result.ok ? 0 : current.consecutiveFailures + 1,
  })
  emitScheduledTaskChanged(id, "manual-run-recorded")
}

/** Park a task whose schedule can no longer be computed (e.g. corrupt cron). */
export function markTaskError(
  id: string,
  message: string,
  nowMs: number
): void {
  db.prepare(
    `
        UPDATE scheduled_tasks
        SET status = 'error', nextRunAt = NULL,
            lastRunStatus = 'error', lastRunError = @message, updatedAt = @now
        WHERE id = @id
    `
  ).run({ id, message, now: nowMs })
  emitScheduledTaskChanged(id, "error")
}

/**
 * Boot recovery: tasks left `running` by a crash/restart are not re-executed
 * blindly (the action may have side effects). One-shots become `missed`;
 * recurring tasks are simply re-armed for their next occurrence. Returns the
 * one-shots that were missed so the caller can notify the user.
 */
export function recoverStuckRunning(nowMs: number): ScheduledTask[] {
  const rows = db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'running'")
    .all() as ScheduledTaskRow[]
  const missed: ScheduledTask[] = []
  for (const row of rows) {
    const task = taskFromRow(row)
    if (task.schedule.kind === "once") {
      const m = markMissed(task.id, nowMs)
      if (m) missed.push(m)
    } else {
      const next = computeNextRunAt(task.schedule, nowMs)
      db.prepare(
        `
                UPDATE scheduled_tasks
                SET status = 'scheduled', nextRunAt = @next, updatedAt = @now
                WHERE id = @id
            `
      ).run({ id: task.id, next, now: nowMs })
      emitScheduledTaskChanged(task.id, "recovered")
    }
  }
  return missed
}

// ---------------------------------------------------------------------------
// Run history (Past runs) — every fire is recorded here for audit, even when
// the run stays silent (no Inbox push). The Inbox only ever holds runs that
// explicitly surfaced.
// ---------------------------------------------------------------------------

export interface TaskRunRecord {
  id: string
  taskId: string
  startedAt: number
  endedAt: number
  status: "ok" | "error"
  trigger: "schedule" | "manual"
  surfaced: boolean
  conversationId: string | null
  summary: string
  contentSegments?: Message["contentSegments"]
  reasoning?: Message["reasoning"]
  attachments?: Message["attachments"]
  error: string | null
}

export const DEFAULT_RUN_HISTORY_PAGE_SIZE = 50
export const MAX_RUN_HISTORY_PAGE_SIZE = 200

export interface TaskRunCursor {
  startedAt: number
  id: string
}

export interface TaskRunPage {
  runs: TaskRunRecord[]
  nextCursor: string | null
  hasMore: boolean
  total: number
}

export interface TaskRunFilters {
  status?: "ok" | "error"
  trigger?: "schedule" | "manual"
  surfaced?: boolean
}

export interface TaskRunSearchFilters extends TaskRunFilters {
  taskId?: string
  taskTitle?: string
  startedAfter?: number
  q?: string
  limit?: number
}

export interface TaskRunSearchRecord extends TaskRunRecord {
  taskTitle: string | null
  taskAction: ScheduledAction | null
}

type TaskRunRow = Omit<
  TaskRunRecord,
  "surfaced" | "contentSegments" | "reasoning" | "attachments"
> & {
  surfaced: number
  contentSegments: string | null
  reasoning: string | null
  attachments: string | null
}
type TaskRunSearchRow = TaskRunRow & {
  taskTitle: string | null
  taskAction: string | null
}

function runFromRow(r: TaskRunRow): TaskRunRecord {
  return {
    ...r,
    surfaced: r.surfaced === 1,
    conversationId: r.conversationId ?? null,
    contentSegments: parseJson<Message["contentSegments"]>(r.contentSegments),
    reasoning: parseJson<Message["reasoning"]>(r.reasoning),
    attachments: parseJson<Message["attachments"]>(r.attachments),
    error: r.error ?? null,
  }
}

function searchRunFromRow(r: TaskRunSearchRow): TaskRunSearchRecord {
  let taskAction: ScheduledAction | null = null
  if (r.taskAction) {
    try {
      taskAction = ScheduledActionSchema.parse(JSON.parse(r.taskAction))
    } catch {
      taskAction = null
    }
  }
  return {
    ...runFromRow(r),
    taskTitle: r.taskTitle ?? null,
    taskAction,
  }
}

function clampRunHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_RUN_HISTORY_PAGE_SIZE
  return Math.max(
    1,
    Math.min(
      MAX_RUN_HISTORY_PAGE_SIZE,
      Math.floor(limit ?? DEFAULT_RUN_HISTORY_PAGE_SIZE)
    )
  )
}

export function encodeTaskRunCursor(
  run: Pick<TaskRunRecord, "startedAt" | "id">
): string {
  return `${run.startedAt}:${encodeURIComponent(run.id)}`
}

export function parseTaskRunCursor(value: string): TaskRunCursor | null {
  const splitAt = value.indexOf(":")
  if (splitAt <= 0) return null
  const startedAt = Number(value.slice(0, splitAt))
  const id = decodeURIComponent(value.slice(splitAt + 1))
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || !id) return null
  return { startedAt, id }
}

export function recordTaskRun(run: {
  taskId: string
  startedAt: number
  status: "ok" | "error"
  trigger: "schedule" | "manual"
  surfaced: boolean
  conversationId: string | null
  summary: string
  contentSegments?: Message["contentSegments"]
  reasoning?: Message["reasoning"]
  attachments?: Message["attachments"]
  error?: string | null
}): void {
  const id = `run_${randomUUID()}`
  const endedAt = Date.now()
  const task = getScheduledTask(run.taskId)
  db.prepare(
    `
        INSERT INTO scheduled_task_runs (
            id, taskId, startedAt, endedAt, status, trigger, surfaced, conversationId,
            summary, contentSegments, reasoning, attachments, error
        ) VALUES (
            @id, @taskId, @startedAt, @endedAt, @status, @trigger, @surfaced, @conversationId,
            @summary, @contentSegments, @reasoning, @attachments, @error
        )
    `
  ).run({
    id,
    taskId: run.taskId,
    startedAt: run.startedAt,
    endedAt,
    status: run.status,
    trigger: run.trigger,
    surfaced: run.surfaced ? 1 : 0,
    conversationId: run.conversationId,
    summary: run.summary,
    contentSegments: run.contentSegments?.length
      ? JSON.stringify(run.contentSegments)
      : null,
    reasoning: run.reasoning?.length ? JSON.stringify(run.reasoning) : null,
    attachments: run.attachments?.length ? JSON.stringify(run.attachments) : null,
    error: run.error ?? null,
  })
  appendRuntimeRunIndex({
    id,
    taskId: run.taskId,
    taskTitle: task?.title ?? null,
    startedAt: run.startedAt,
    endedAt,
    status: run.status,
    trigger: run.trigger,
    surfaced: run.surfaced,
    conversationId: run.conversationId,
    summary: run.summary,
    error: run.error ?? null,
  })
  emitTaskRunsChanged(run.taskId, id)
}

export function getTaskRun(runId: string): TaskRunRecord | null {
  const row = db
    .prepare("SELECT * FROM scheduled_task_runs WHERE id = ?")
    .get(runId) as TaskRunRow | undefined
  return row ? runFromRow(row) : null
}

export function getTaskRunWithTask(runId: string): TaskRunSearchRecord | null {
  const row = db
    .prepare(
      `
        SELECT r.*, t.title as taskTitle, t.action as taskAction
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.taskId
        WHERE r.id = ?
    `
    )
    .get(runId) as TaskRunSearchRow | undefined
  return row ? searchRunFromRow(row) : null
}

export function searchTaskRuns(filters: TaskRunSearchFilters): {
  runs: TaskRunSearchRecord[]
  total: number
} {
  const where: string[] = []
  const params: unknown[] = []

  if (filters.taskId) {
    where.push("r.taskId = ?")
    params.push(filters.taskId)
  }
  if (filters.taskTitle) {
    where.push("t.title LIKE ?")
    params.push(`%${filters.taskTitle}%`)
  }
  if (filters.startedAfter !== undefined) {
    where.push("r.startedAt >= ?")
    params.push(filters.startedAfter)
  }
  if (filters.status) {
    where.push("r.status = ?")
    params.push(filters.status)
  }
  if (filters.trigger) {
    where.push("r.trigger = ?")
    params.push(filters.trigger)
  }
  if (filters.surfaced !== undefined) {
    where.push("r.surfaced = ?")
    params.push(filters.surfaced ? 1 : 0)
  }
  if (filters.q) {
    where.push("(r.summary LIKE ? OR r.error LIKE ? OR t.title LIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const limit = clampRunHistoryLimit(filters.limit)
  const rows = db
    .prepare(
      `
        SELECT r.*, t.title as taskTitle, t.action as taskAction
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.taskId
        ${whereSql}
        ORDER BY r.startedAt DESC, r.id DESC
        LIMIT ?
    `
    )
    .all(...params, limit) as TaskRunSearchRow[]
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) as c
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.taskId
        ${whereSql}
    `
    )
    .get(...params) as { c: number }
  return { runs: rows.map(searchRunFromRow), total: totalRow.c }
}

export function listTaskRunsPage(
  taskId: string,
  options: {
    limit?: number
    before?: TaskRunCursor | null
    filters?: TaskRunFilters
  } = {}
): TaskRunPage {
  const limit = clampRunHistoryLimit(options.limit)
  const cursor = options.before ?? null
  const filters = options.filters ?? {}
  const conditions = ["taskId = @taskId"]
  const countConditions = ["taskId = @taskId"]
  if (cursor)
    conditions.push(
      "(startedAt < @startedAt OR (startedAt = @startedAt AND id < @id))"
    )
  if (filters.status) {
    conditions.push("status = @status")
    countConditions.push("status = @status")
  }
  if (filters.trigger) {
    conditions.push("trigger = @trigger")
    countConditions.push("trigger = @trigger")
  }
  if (filters.surfaced !== undefined) {
    conditions.push("surfaced = @surfaced")
    countConditions.push("surfaced = @surfaced")
  }
  const where = `WHERE ${conditions.join(" AND ")}`
  const params = {
    taskId,
    startedAt: cursor?.startedAt ?? null,
    id: cursor?.id ?? null,
    status: filters.status ?? null,
    trigger: filters.trigger ?? null,
    surfaced: filters.surfaced === undefined ? null : filters.surfaced ? 1 : 0,
  }
  const rows = db
    .prepare(
      `
        SELECT * FROM scheduled_task_runs
        ${where}
        ORDER BY startedAt DESC, id DESC
        LIMIT @limit
    `
    )
    .all({
      ...params,
      limit: limit + 1,
    }) as TaskRunRow[]
  const visibleRows = rows.slice(0, limit)
  const runs = visibleRows.map(runFromRow)
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total FROM scheduled_task_runs
        WHERE ${countConditions.join(" AND ")}
    `
    )
    .get(params) as { total: number }
  const hasMore = rows.length > limit
  const last = runs.at(-1)

  return {
    runs,
    nextCursor: hasMore && last ? encodeTaskRunCursor(last) : null,
    hasMore,
    total: totalRow.total,
  }
}

export function listTaskRuns(
  taskId: string,
  limit = DEFAULT_RUN_HISTORY_PAGE_SIZE
): TaskRunRecord[] {
  return listTaskRunsPage(taskId, { limit }).runs
}

// ---------------------------------------------------------------------------
// Per-task private state — a recurring task's own memory (last-seen watermark,
// rolling baselines for adaptive cadence, last observed price, …). Injected
// into the run as <task_state> and rewritten by the agent via set_task_state.
// This replaces the old "write monitor state to a shared file" anti-pattern: it is scoped
// to the task, structured, and never leaks into unrelated context.
// ---------------------------------------------------------------------------

export function getTaskState(id: string): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT state FROM scheduled_tasks WHERE id = ?")
    .get(id) as { state: string | null } | undefined
  if (!row?.state) return null
  try {
    const parsed = JSON.parse(row.state)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function setTaskState(id: string, state: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(state ?? {})
  } catch {
    return // non-serializable — drop rather than corrupt the row
  }
  if (serialized.length > 100_000) serialized = serialized.slice(0, 100_000)
  db.prepare(
    "UPDATE scheduled_tasks SET state = @state, updatedAt = @now WHERE id = @id"
  ).run({ id, state: serialized, now: Date.now() })
}

// ---------------------------------------------------------------------------
// Inbox conversations
//
// A scheduled run drops its transcript into an "inbox" conversation. These
// reuse the conversations/messages tables but are tagged origin='inbox' and
// are deliberately written WITHOUT emitting chat events, so they never appear
// in the normal chat recents (which the UI fetches via getConversationsWithMessages).
// ---------------------------------------------------------------------------

const insertInboxMessage = db.prepare(`
    INSERT INTO messages (id, conversationId, role, content, status, contentSegments, reasoning, thinking, thinkingDuration, toolCalls, attachments, replyActions, timestamp)
    VALUES (@id, @conversationId, @role, @content, @status, @contentSegments, @reasoning, @thinking, @thinkingDuration, @toolCalls, @attachments, @replyActions, @timestamp)
`)

const SCHEDULED_TRIGGER_PREFIX = "⏰ Scheduled task "

function isScheduledTriggerMessage(
  message: Pick<Message, "role" | "content">
): boolean {
  return (
    message.role === "user" &&
    message.content.startsWith(SCHEDULED_TRIGGER_PREFIX)
  )
}

export function createInboxConversation(args: {
  taskId: string
  title: string
  messages: Message[]
  /** Pre-generated id so callers can log an agent run against it. */
  id?: string
}): string {
  const now = Date.now()
  const conversationId = args.id ?? `inbox_${randomUUID()}`
  const latestMessage = args.messages.reduce<Message | null>(
    (latest, message) =>
      !latest || message.timestamp > latest.timestamp ? message : latest,
    null
  )
  const tx = db.transaction(() => {
    db.prepare(
      `
            INSERT INTO conversations (
              id, title, createdAt, updatedAt, origin, scheduledTaskId, readAt,
              messageCount, lastMessagePreview, lastMessageAt
            )
            VALUES (
              @id, @title, @createdAt, @updatedAt, 'inbox', @taskId, NULL,
              @messageCount, @lastMessagePreview, @lastMessageAt
            )
        `
    ).run({
      id: conversationId,
      title: args.title,
      createdAt: now,
      updatedAt: now,
      taskId: args.taskId,
      messageCount: args.messages.length,
      lastMessagePreview: latestMessage
        ? stripArtifactBlocksForPreview(latestMessage.content).slice(0, 240)
        : null,
      lastMessageAt: latestMessage?.timestamp ?? null,
    })

    for (const msg of args.messages) {
      insertInboxMessage.run({
        id: msg.id,
        conversationId,
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
  })
  tx()
  emitInboxChanged(conversationId, "created")
  return conversationId
}

export interface InboxListItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number | null
  readAt: number | null
  scheduledTaskId: string | null
  preview: string
  messageCount: number
}

export function listInboxConversations(limit = 200): InboxListItem[] {
  const rows = db
    .prepare(
      `
        SELECT c.id, c.title, c.createdAt, c.updatedAt, c.lastMessageAt, c.readAt, c.scheduledTaskId,
               (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id AND NOT (m.role = 'user' AND m.content LIKE '⏰ Scheduled task %')) AS messageCount,
               (SELECT m2.content FROM messages m2 WHERE m2.conversationId = c.id ORDER BY m2.timestamp DESC LIMIT 1) AS preview
        FROM conversations c
        WHERE c.origin = 'inbox'
        ORDER BY COALESCE(c.lastMessageAt, c.updatedAt, c.createdAt) DESC,
                 c.updatedAt DESC,
                 c.createdAt DESC
        LIMIT ?
    `
    )
    .all(limit) as Array<{
    id: string
    title: string
    createdAt: number
    updatedAt: number
    lastMessageAt: number | null
    readAt: number | null
    scheduledTaskId: string | null
    messageCount: number
    preview: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMessageAt: r.lastMessageAt ?? null,
    readAt: r.readAt ?? null,
    scheduledTaskId: r.scheduledTaskId ?? null,
    preview: stripArtifactBlocksForPreview(r.preview ?? "").slice(0, 240),
    messageCount: r.messageCount,
  }))
}

export function findInboxConversationByTaskAndTitle(
  taskId: string,
  title: string
): InboxListItem | null {
  const row = db
    .prepare(
      `
        SELECT c.id, c.title, c.createdAt, c.updatedAt, c.lastMessageAt, c.readAt, c.scheduledTaskId,
               (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id AND NOT (m.role = 'user' AND m.content LIKE '⏰ Scheduled task %')) AS messageCount,
               (SELECT m2.content FROM messages m2 WHERE m2.conversationId = c.id ORDER BY m2.timestamp DESC LIMIT 1) AS preview
        FROM conversations c
        WHERE c.origin = 'inbox'
          AND c.scheduledTaskId = ?
          AND c.title = ?
        ORDER BY COALESCE(c.lastMessageAt, c.updatedAt, c.createdAt) DESC,
                 c.updatedAt DESC,
                 c.createdAt DESC
        LIMIT 1
    `
    )
    .get(taskId, title) as
    | {
        id: string
        title: string
        createdAt: number
        updatedAt: number
        lastMessageAt: number | null
        readAt: number | null
        scheduledTaskId: string | null
        messageCount: number
        preview: string | null
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt ?? null,
    readAt: row.readAt ?? null,
    scheduledTaskId: row.scheduledTaskId ?? null,
    preview: stripArtifactBlocksForPreview(row.preview ?? "").slice(0, 240),
    messageCount: row.messageCount,
  }
}

export function countUnreadInbox(): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS n
        FROM conversations
        WHERE origin = 'inbox'
          AND (
            readAt IS NULL
            OR (lastMessageAt IS NOT NULL AND readAt < lastMessageAt)
          )
      `
    )
    .get() as { n: number }
  return row.n
}

export interface InboxConversationDetail {
  id: string
  title: string
  createdAt: number
  readAt: number | null
  scheduledTaskId: string | null
  messages: Message[]
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function getInboxConversation(
  id: string
): InboxConversationDetail | null {
  const row = db
    .prepare(
      "SELECT id, title, createdAt, readAt, scheduledTaskId FROM conversations WHERE id = ? AND origin = 'inbox'"
    )
    .get(id) as
    | {
        id: string
        title: string
        createdAt: number
        readAt: number | null
        scheduledTaskId: string | null
      }
    | undefined
  if (!row) return null

  const msgRows = db
    .prepare(
      "SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC"
    )
    .all(id) as Array<{
    id: string
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
  }>

  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    readAt: row.readAt ?? null,
    scheduledTaskId: row.scheduledTaskId ?? null,
    messages: msgRows
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        status: m.status ?? undefined,
        contentSegments: parseJson<Message["contentSegments"]>(
          m.contentSegments
        ),
        reasoning: parseJson<Message["reasoning"]>(m.reasoning),
        thinking: m.thinking || undefined,
        thinkingDuration: m.thinkingDuration ?? undefined,
        toolCalls: parseJson<Message["toolCalls"]>(m.toolCalls),
        attachments: parseJson<Message["attachments"]>(m.attachments),
        replyActions: parseJson<Message["replyActions"]>(m.replyActions),
        timestamp: m.timestamp,
      }))
      .filter((message) => !isScheduledTriggerMessage(message)),
  }
}

export function appendInboxMessage(
  conversationId: string,
  message: Message
): boolean {
  const row = db
    .prepare("SELECT id FROM conversations WHERE id = ? AND origin = 'inbox'")
    .get(conversationId)
  if (!row) return false

  const existingMessage = db
    .prepare("SELECT id FROM messages WHERE id = ?")
    .get(message.id) as { id: string } | undefined

  const tx = db.transaction(() => {
    insertInboxMessage.run({
      id: message.id,
      conversationId,
      role: message.role,
      content: message.content,
      status: message.status ?? null,
      contentSegments: message.contentSegments
        ? JSON.stringify(message.contentSegments)
        : null,
      reasoning: message.reasoning ? JSON.stringify(message.reasoning) : null,
      thinking: message.thinking || null,
      thinkingDuration: message.thinkingDuration ?? null,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      attachments: message.attachments
        ? JSON.stringify(message.attachments)
        : null,
      replyActions: message.replyActions
        ? JSON.stringify(message.replyActions)
        : null,
      timestamp: message.timestamp,
    })

    db.prepare(
      `
        UPDATE conversations
        SET updatedAt = @updatedAt,
            messageCount = messageCount + @messageDelta,
            lastMessagePreview = @lastMessagePreview,
            lastMessageAt = @lastMessageAt,
            readAt = @readAt
        WHERE id = @id AND origin = 'inbox'
      `
    ).run({
      id: conversationId,
      updatedAt: Date.now(),
      messageDelta: existingMessage ? 0 : 1,
      lastMessagePreview: stripArtifactBlocksForPreview(message.content).slice(
        0,
        240
      ),
      lastMessageAt: message.timestamp,
      readAt: message.role === "user" ? Date.now() : null,
    })
  })

  tx()
  emitInboxChanged(conversationId, "changed")
  return true
}

/**
 * Locates a direct-action quick-reply on an Inbox message, marks it consumed,
 * and returns the original action so the caller can dispatch the underlying
 * tool. Returns null when the message/action does not exist, the action has
 * no directAction payload, or it has already been consumed (anti-replay).
 */
export function claimInboxDirectAction(
  conversationId: string,
  messageId: string,
  actionId: string
): InboxReplyAction | null {
  const row = db
    .prepare(
      `SELECT m.replyActions
         FROM messages m
         JOIN conversations c ON c.id = m.conversationId
         WHERE m.id = ? AND m.conversationId = ? AND c.origin = 'inbox'`
    )
    .get(messageId, conversationId) as { replyActions: string | null } | undefined
  if (!row) return null

  const actions = parseJson<InboxReplyAction[]>(row.replyActions)
  if (!actions || !Array.isArray(actions)) return null

  const action = actions.find((a) => a && a.id === actionId)
  if (!action) return null
  if (!action.directAction) return null
  if (action.consumedAt) return null

  const updated: InboxReplyAction[] = actions.map((a) =>
    a.id === actionId ? { ...a, consumedAt: Date.now() } : a
  )

  db.prepare("UPDATE messages SET replyActions = ? WHERE id = ?").run(
    JSON.stringify(updated),
    messageId
  )
  emitInboxChanged(conversationId, "changed")
  return action
}

export interface InboxDirectActionLogEntry {
  id: string
  conversationId: string
  messageId: string
  actionId: string
  tool: string
  params: Record<string, unknown> | null
  result: "ok" | "error"
  errorMessage: string | null
  sourceKind: "gmail" | "whatsapp"
  sourceTarget: string
  createdAt: number
}

export function logInboxDirectAction(args: {
  conversationId: string
  messageId: string
  actionId: string
  tool: string
  params: Record<string, unknown> | null
  result: "ok" | "error"
  errorMessage?: string | null
  sourceKind: "gmail" | "whatsapp"
  sourceTarget: string
}): void {
  db.prepare(
    `INSERT INTO inbox_direct_action_log
       (id, conversationId, messageId, actionId, tool, params, result, errorMessage, sourceKind, sourceTarget, createdAt)
     VALUES (@id, @conversationId, @messageId, @actionId, @tool, @params, @result, @errorMessage, @sourceKind, @sourceTarget, @createdAt)`
  ).run({
    id: `iact_${randomUUID()}`,
    conversationId: args.conversationId,
    messageId: args.messageId,
    actionId: args.actionId,
    tool: args.tool,
    params: args.params ? JSON.stringify(args.params) : null,
    result: args.result,
    errorMessage: args.errorMessage ?? null,
    sourceKind: args.sourceKind,
    sourceTarget: args.sourceTarget,
    createdAt: Date.now(),
  })
}

export function listInboxDirectActions(args: {
  limit?: number
  sourceKind?: "gmail" | "whatsapp"
  since?: number
} = {}): InboxDirectActionLogEntry[] {
  const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 50)))
  const filters: string[] = []
  const params: Record<string, unknown> = { limit }
  if (args.sourceKind) {
    filters.push("sourceKind = @sourceKind")
    params.sourceKind = args.sourceKind
  }
  if (typeof args.since === "number" && Number.isFinite(args.since)) {
    filters.push("createdAt >= @since")
    params.since = args.since
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  const rows = db
    .prepare(
      `SELECT id, conversationId, messageId, actionId, tool, params, result,
              errorMessage, sourceKind, sourceTarget, createdAt
         FROM inbox_direct_action_log
         ${where}
         ORDER BY createdAt DESC
         LIMIT @limit`
    )
    .all(params) as Array<{
    id: string
    conversationId: string
    messageId: string
    actionId: string
    tool: string
    params: string | null
    result: "ok" | "error"
    errorMessage: string | null
    sourceKind: "gmail" | "whatsapp"
    sourceTarget: string
    createdAt: number
  }>
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    actionId: row.actionId,
    tool: row.tool,
    params: parseJson<Record<string, unknown>>(row.params) ?? null,
    result: row.result,
    errorMessage: row.errorMessage,
    sourceKind: row.sourceKind,
    sourceTarget: row.sourceTarget,
    createdAt: row.createdAt,
  }))
}

export function markInboxRead(id: string): number | null {
  const current = db
    .prepare(
      `
        SELECT readAt, lastMessageAt, updatedAt, createdAt
        FROM conversations
        WHERE id = ? AND origin = 'inbox'
      `
    )
    .get(id) as
    | {
        readAt: number | null
        lastMessageAt: number | null
        updatedAt: number
        createdAt: number
      }
    | undefined
  if (!current) return null

  const readAt = current.lastMessageAt ?? current.updatedAt ?? current.createdAt
  const res = db
    .prepare(
      `
      UPDATE conversations
      SET readAt = @readAt
      WHERE id = @id
        AND origin = 'inbox'
        AND (readAt IS NULL OR readAt < @readAt)
    `
    )
    .run({ id, readAt })

  const row = db
    .prepare(
      "SELECT readAt FROM conversations WHERE id = ? AND origin = 'inbox'"
    )
    .get(id) as { readAt: number | null } | undefined
  const nextReadAt = row?.readAt ?? null

  if (res.changes > 0) emitInboxChanged(id, "read")
  return nextReadAt
}

export function deleteInboxConversation(id: string): boolean {
  const row = db
    .prepare("SELECT id FROM conversations WHERE id = ? AND origin = 'inbox'")
    .get(id)
  if (!row) return false
  deleteConversation(id) // FK-cascades messages; emits a harmless delete event
  emitInboxChanged(id, "deleted")
  return true
}

/**
 * "Reply" on an inbox item: forks its transcript into a fresh, normal chat
 * the user can continue. The new conversation is emitted via createConversation
 * so it shows up in recents and opens like any other chat.
 */
export function forkInboxToConversation(id: string): string | null {
  const inbox = getInboxConversation(id)
  if (!inbox) return null

  const now = Date.now()
  const newId = `conv_${randomUUID()}`
  const messageIdMap = new Map<string, string>()
  const messages: Message[] = inbox.messages.map((m, i) => {
    const nextId = `msg_${randomUUID()}`
    messageIdMap.set(m.id, nextId)
    return {
      ...m,
      id: nextId,
      timestamp: now + i,
    }
  })

  createConversation({
    id: newId,
    title: inbox.title,
    messages,
    createdAt: now,
  })

  db.prepare(
    "UPDATE conversations SET origin = @origin, forkedFromConversationId = @from WHERE id = @id"
  ).run({ origin: "user", from: id, id: newId })

  copyArtifactsForMessageMap({
    fromConversationId: id,
    toConversationId: newId,
    messageIdMap,
  })

  markInboxRead(id)
  return newId
}
