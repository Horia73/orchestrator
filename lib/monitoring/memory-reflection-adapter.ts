// Memory reflection system-task adapter — mirrors lib/monitoring/smart-monitor-adapter.ts.
//
// Owns the single "Memory reflection" system task in Scheduling: a nightly
// agent wake that does memory housekeeping — prune/dedup/resolve-conflict across
// the durable memory files (USER.md, MEMORY.md, MONITORS.md, PLAYBOOKS.md), spot
// cross-day patterns in the daily-memory window, and consolidate Smart Monitor
// learnings into MONITORS.md. The intelligence lives entirely in the dedicated
// REFLECTION_PROMPT below; this adapter keeps that scheduled wake armed. No
// scoring, dedup, or decay logic runs in code — the model decides what to keep
// and what to forget.

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
  'Follow this dedicated reflection protocol:',
  '1. Start with a file-size audit: run `wc -c USER.md MEMORY.md MEMORY_ARCHIVE.md MONITORS.md PLAYBOOKS.md`. Treat 50,000 chars as approaching the hot-file limit and 60,000 chars as over budget for USER.md, MEMORY.md, PLAYBOOKS.md, and MONITORS.md. If any hot file is near/over budget, or if your prompt shows `[truncated: file exceeded context budget]`, read that full file from disk before editing; do not rely on truncated prompt context.',
  '2. Read your durable memory (USER.md, MEMORY.md, MONITORS.md, PLAYBOOKS.md) and the compact recent-daily views already in your context. The raw MEMORY_DAY files remain complete: when an omission marker touches a pattern you are evaluating, use memory_search or read that raw file before drawing the conclusion. Also read MEMORY_ARCHIVE.md (it is NOT auto-loaded) before you reorganize the hot/cold split.',
  '3. Curate the durable files: resolve contradictions in favor of the newest evidence, merge duplicates — including the same fact duplicated across two files (e.g. in both USER.md and MEMORY.md): keep it only in its canonical home (profile/personal → USER.md, assistant operating rule → MEMORY.md, procedure → PLAYBOOKS.md) and delete the other copy; this is safe across the hot files but never demote an autonomous-run-needed fact into MEMORY_ARCHIVE.md to resolve a duplicate. For size pressure, compact in this order: move old/rarely-needed but still useful interactive facts to MEMORY_ARCHIVE.md, delete entries that are stale/superseded/irrelevant, then DENSIFY — rewrite genuinely verbose or redundant entries to say the same thing in fewer words (same facts and nuance, tighter phrasing). Densification is lossless and is the preferred tool; deletion is lossy, so be conservative with it. Do NOT re-paraphrase already-tight prose night after night — repeated paraphrase risks meaning drift, so leave clean entries alone, and if a file is already lean change nothing. New facts are already saved during normal turns — your job here is cleanup, not bulk re-adding.',
  '4. Keep the HOT tier lean, but SAFELY. USER.md, MEMORY.md, PLAYBOOKS.md, and MONITORS.md each need to stay well under the per-file prompt budget; do not focus only on MEMORY.md. You MAY move durable facts that are rarely needed day-to-day into MEMORY_ARCHIVE.md (cold storage), but ONLY facts used in interactive conversation. CRITICAL: Smart Monitor wakes, scheduled tasks, and Microscript agent-wakes load MEMORY.md/MONITORS.md but do NOT run semantic recall, so a fact in the archive is INVISIBLE to them. Keep anything autonomous runs depend on (notify/quiet rules, device/entity specifics they act on, output-schema requirements, standing auto-action authorizations) in the hot files. Archiving is otherwise lossless — the archive is indexed for recall and resurfaces in chat. Promote a fact back when it becomes routinely relevant again.',
  '5. Spot cross-day patterns: something recurring across several days in the daily memory (a sender, a request, a routine, a preference) that is now worth one durable line — add it to the right file. A single occurrence is not a pattern.',
  '6. Synthesize playbooks from repeated workflows: call memory_recent_activity (~14 days) and scan the daily-memory window for the same multi-step request recurring across distinct days. When a workflow recurred on 2-3+ distinct days and PLAYBOOKS.md has no entry covering it, distill one per <durable_procedure_protocol>: trigger phrase, ordered steps with the tools/integrations/sub-agents actually used, {{parameters}} for the run-specific values, preconditions and gotchas. Use memory_search to recover the concrete steps when the daily notes are thin. Merge near-duplicates instead of appending variants; delete playbooks that stopped working or stopped recurring. A single occurrence is not a playbook; simple one-tool asks need none.',
  '7. For the Smart Monitor, review recent wake decisions with search_past_runs and the per-watch engagement history (user_signal events in monitor_watch_get — what the user opened, replied to, or dismissed unread), and consolidate durable learnings into MONITORS.md (recurring noise to keep quiet, recurring signals that matter, learned notify/quiet preferences); prune monitor notes that no longer hold.',
  '8. Never delete or rewrite the raw MEMORY_DAY/<date>.md day files — they are the audit trail and safety net. Curate only the durable files.',
  '9. Save changes with the Write/Edit tools (in-context edits do not persist). If any file was near/over budget, rerun `wc -c` after edits; if it is still near/over budget, do another compaction pass rather than declaring success. Keep every file compact. If nothing needs changing, change nothing and finish. Stay silent — do NOT call notify_inbox — with ONE exception: if step 6 created a brand-new playbook, you may send a single short notify_inbox naming its trigger phrase(s) so the user knows the shortcut exists (and can correct or remove it). Edits, merges, and densification never notify.',
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
