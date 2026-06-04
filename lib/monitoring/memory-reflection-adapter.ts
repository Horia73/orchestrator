// Memory reflection system-task adapter — mirrors lib/monitoring/smart-monitor-adapter.ts.
//
// Owns the single "Memory reflection" system task in Scheduling: a nightly
// agent wake that does memory housekeeping — prune/dedup/resolve-conflict across
// the durable memory files (USER.md, MEMORY.md, MONITORS.md, PLAYBOOKS.md), spot
// cross-day patterns in the daily-memory window, and consolidate Smart Monitor
// learnings into MONITORS.md. The intelligence lives entirely in the
// orchestrator's <memory_reflection_protocol> prompt; this adapter is just the
// bridge that keeps the scheduled wake armed. No scoring, dedup, or decay logic
// runs in code — the model decides what to keep and what to forget.

import { getConfiguredTimezone } from '../config'
import type { CreateScheduledTaskInput } from '@/lib/scheduling/schema'

export const REFLECTION_TASK_TITLE = 'Memory reflection'

// Nightly, during a typical quiet window. Unrelated to the Smart Monitor cheap
// cadence — this is a once-a-day housekeeping wake, not a polling loop.
const REFLECTION_HOUR = 3
const REFLECTION_MINUTE = 0

const REFLECTION_PROMPT = [
  'This is the scheduled nightly Memory reflection — background housekeeping, not a user request. No one is waiting and nothing should reach the Inbox.',
  '',
  'Follow <memory_reflection_protocol> in your instructions. In short:',
  '1. Read your durable memory (USER.md, MEMORY.md, MONITORS.md, PLAYBOOKS.md) and the recent daily working memory already in your context.',
  '2. Curate the durable files: resolve contradictions in favor of the newest evidence, merge duplicates, tighten verbose prose, and delete entries that are stale, superseded, or no longer relevant. New facts are already saved during normal turns — your job here is mostly cleanup, not bulk re-adding.',
  '3. Spot cross-day patterns: something recurring across several days in the daily memory (a sender, a request, a routine, a preference) that is now worth one durable line — add it to the right file. A single occurrence is not a pattern.',
  '4. For the Smart Monitor, review recent wake decisions with search_past_runs and consolidate durable learnings into MONITORS.md (recurring noise to keep quiet, recurring signals that matter, learned notify/quiet preferences); prune monitor notes that no longer hold.',
  '5. Never delete or rewrite the raw MEMORY_DAY/<date>.md day files — they are the audit trail and safety net. Curate only the durable files.',
  '6. Save changes with the Write/Edit tools (in-context edits do not persist). Keep every file compact. If nothing needs changing, change nothing and finish. Do NOT call notify_inbox.',
].join('\n')

/** Use the app-wide configured timezone so nightly reflection follows the same
 *  local day boundary as daily memory, scheduling defaults, and runtime prompts. */
export function resolveReflectionTimezone(): string {
  return getConfiguredTimezone()
}

/** Pure builder for the system task spec — exported so smoke tests can validate
 *  it against CreateScheduledTaskInputSchema without touching the store. */
export function buildReflectionTaskInput(timezone: string): CreateScheduledTaskInput {
  return {
    title: REFLECTION_TASK_TITLE,
    action: {
      kind: 'agent',
      agentId: 'orchestrator',
      prompt: REFLECTION_PROMPT,
    },
    schedule: {
      kind: 'dailyAt',
      hour: REFLECTION_HOUR,
      minute: REFLECTION_MINUTE,
      timezone,
    },
    enabled: true,
    createdBy: 'system',
  }
}

function isDesiredSchedule(schedule: unknown, timezone: string): boolean {
  if (!schedule || typeof schedule !== 'object') return false
  const s = schedule as {
    kind?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
  }
  return (
    s.kind === 'dailyAt' &&
    s.hour === REFLECTION_HOUR &&
    s.minute === REFLECTION_MINUTE &&
    s.timezone === timezone
  )
}

/**
 * Idempotently create the single system "Memory reflection" nightly agent task
 * and reconcile it on each boot. Unlike the Smart Monitor heartbeat this stays
 * enabled unconditionally — memory housekeeping is always wanted, with or
 * without any monitors configured. Only ever touches our own system task.
 */
export async function ensureMemoryReflectionTask(): Promise<void> {
  const { listScheduledTasks, createScheduledTask, updateScheduledTask } =
    await import('@/lib/scheduling/store')

  const timezone = resolveReflectionTimezone()
  const existing = listScheduledTasks().find(
    (t) =>
      t.createdBy === 'system' &&
      t.action.kind === 'agent' &&
      t.title === REFLECTION_TASK_TITLE
  )

  if (existing) {
    const patch: Parameters<typeof updateScheduledTask>[1] = {}
    if (!existing.enabled) patch.enabled = true
    if (!isDesiredSchedule(existing.schedule, timezone)) {
      patch.schedule = {
        kind: 'dailyAt',
        hour: REFLECTION_HOUR,
        minute: REFLECTION_MINUTE,
        timezone,
      }
    }
    // Keep the prompt in sync as the doctrine evolves across releases.
    if (existing.action.kind !== 'agent' || existing.action.prompt !== REFLECTION_PROMPT) {
      patch.action = {
        kind: 'agent',
        agentId: 'orchestrator',
        prompt: REFLECTION_PROMPT,
        adaptive: false,
      }
    }
    if (Object.keys(patch).length > 0) updateScheduledTask(existing.id, patch)
    return
  }

  createScheduledTask(buildReflectionTaskInput(timezone))
}

/** Idempotent boot entry, mirrors wireSmartMonitor(). */
export async function wireMemoryReflection(): Promise<void> {
  await ensureMemoryReflectionTask()
}
