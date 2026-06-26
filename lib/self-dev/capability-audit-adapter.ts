// Capability audit system-task adapter — mirrors lib/monitoring/memory-reflection-adapter.ts.
//
// Owns the single "Capability audit" system task in Scheduling: a weekly agent
// wake that triages AGENT_NEEDS.md (the agents' own blocked-needs backlog) into
// a ranked, evidence-backed proposal posted to the Inbox — with the emphasis on
// NEW capabilities/features the agents found missing, not just bug fixes.
//
// The weekly run ONLY proposes; it never implements. Implementation happens
// later, and only after the user clicks a "Build" action on the Inbox item:
// that reply re-wakes the orchestrator in the same Inbox thread and runs the
// normal self_dev gate (worktree + coder + typecheck/build/smoke + preview,
// then a second confirmation before any push/release/deploy). The intelligence
// lives entirely in the prompt below; this adapter is just the bridge that
// keeps the weekly wake armed. No scoring or triage logic runs in code — the
// model decides what to resolve, drop, and propose.

import { getConfiguredTimezone } from '@/lib/config'
import type { CreateScheduledTaskInput } from '@/lib/scheduling/schema'

export const CAPABILITY_AUDIT_TASK_TITLE = 'Capability audit'

// Weekly, Monday in a quiet pre-dawn window — after the nightly Memory
// reflections, and decoupled from any polling loop. The plan lands in the Inbox
// for the user to review whenever, so the fire time only needs to be quiet.
const AUDIT_WEEKDAY = 1 // 0 = Sunday .. 6 = Saturday
const AUDIT_HOUR = 4
const AUDIT_MINUTE = 0

const CAPABILITY_AUDIT_PROMPT = [
  'This is the scheduled weekly Capability Audit — background self-development triage, not a user request. No one is waiting. This run ONLY produces a proposal: it must NOT implement anything, must NOT activate self_dev or project_dev, must NOT prepare a worktree, delegate to coder, push, deploy, or change any code.',
  '',
  "Your job: turn the agents' own blocked-needs backlog into a ranked, evidence-backed proposal for the user to approve — with the emphasis on NEW CAPABILITIES / FEATURES the agents found missing, not just bug fixes.",
  '',
  '1. Read AGENT_NEEDS.md (your workspace file). The `## Open` section is your PRIMARY INPUT and source of truth: each entry is something an agent could not complete because a capability, tool, integration, runtime behavior, doc, or repo behavior was missing or broken.',
  '',
  "2. For corroboration ONLY, you may pull supporting signal: search_agent_logs (status='error', range='30d') for recurring failures, and get_agent_log for the tool breakdown of a failing run. Use this to confirm or prioritize an Open need — NEVER to invent items that have no Open entry behind them.",
  '',
  '3. Triage EACH Open entry into exactly one bucket. Before deciding, do a quick codebase check (Grep/Glob/Read) to ground your judgment:',
  '   - RESOLVED: already implemented, or the underlying problem no longer exists (confirm in the code). This is bookkeeping — close it yourself with ResolveAgentNeed (dedupe_key + a one-line resolution), and just list it in the report. If the entry has no dedupe_key (an old hand-written entry), move it to `## Resolved` with Edit instead.',
  '   - DROP: stale, duplicate, or not worth building (cost > value, or out of product scope). Do NOT close or edit it; include it in the proposal as a "recommend drop" with a one-line reason for the user to confirm.',
  '   - BUILD: genuinely worth implementing. Design a SCOPED proposal: the outcome, the subsystem/files likely touched, acceptance criteria, and a rough size (S/M/L). Lead with missing_capability / feature entries; bugs come after.',
  '',
  '4. Rank the BUILD items: new capabilities / features FIRST (the user wants features predominantly), then high/critical-severity bugs, then minor.',
  '',
  '5. If there are zero BUILD and zero DROP items after triage (only resolved / no-ops), STAY SILENT — do NOT call notify_inbox. An empty week is a no-op.',
  '',
  '6. Otherwise post ONE notify_inbox. Title: specific, e.g. "Capability audit: 3 features to build, 1 to drop". Body, written to the user like an email:',
  '   - A short lead: how many Open needs there were, how many you closed as bookkeeping, what you propose now.',
  '   - A ranked list. For each BUILD item: the proposed capability; WHY — cite the AGENT_NEEDS entry (summary, severity, dedupe_key, and when / how often it was reported) plus any corroborating log evidence; scope; acceptance criteria; size. For each DROP: a one-line reason.',
  '   - Every line MUST trace to an AGENT_NEEDS entry or a clearly repeated error pattern. Do not pad with speculative features.',
  '   Include `actions` buttons (max 8): one "Build: <short>" per top BUILD item, plus "Build all approved", "Drop the flagged needs", and "Dismiss".',
  "   Each Build button's `value` must read like: \"Approved — implement this via self-development: <one-line outcome> (AGENT_NEEDS dedupe_key: <key>). Follow the self_dev gate: worktree + coder + typecheck/build/smoke + managed preview, and ASK ME AGAIN before pushing to master, publishing a release, or deploying to production. When it ships, close the AGENT_NEEDS entry with ResolveAgentNeed.\"",
  '',
  '7. NEVER in this run: activate self_dev or project_dev, prepare a worktree, delegate to coder, push, deploy, or change any code. Proposing is the whole job. Implementation happens only after the user clicks a Build button, in a fresh Inbox reply.',
  '',
  '8. Do not paste run narration, tool ids, or internal bookkeeping into the Inbox body — write the clean, user-facing proposal only.',
].join('\n')

/** Use the app-wide configured timezone so the weekly audit follows the same
 *  local day boundary as scheduling defaults and the nightly reflection. */
export function resolveCapabilityAuditTimezone(): string {
  return getConfiguredTimezone()
}

/** Pure builder for the system task spec — exported so smoke tests can validate
 *  it against CreateScheduledTaskInputSchema without touching the store. */
export function buildCapabilityAuditTaskInput(timezone: string): CreateScheduledTaskInput {
  return {
    title: CAPABILITY_AUDIT_TASK_TITLE,
    action: {
      kind: 'agent',
      agentId: 'orchestrator',
      prompt: CAPABILITY_AUDIT_PROMPT,
    },
    schedule: {
      kind: 'weeklyAt',
      weekdays: [AUDIT_WEEKDAY],
      hour: AUDIT_HOUR,
      minute: AUDIT_MINUTE,
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
    weekdays?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
  }
  return (
    s.kind === 'weeklyAt' &&
    Array.isArray(s.weekdays) &&
    s.weekdays.length === 1 &&
    s.weekdays[0] === AUDIT_WEEKDAY &&
    s.hour === AUDIT_HOUR &&
    s.minute === AUDIT_MINUTE &&
    s.timezone === timezone
  )
}

/**
 * Idempotently create the single system "Capability audit" weekly agent task
 * and reconcile it on each boot. Like the Memory reflection task this stays
 * enabled unconditionally — capability triage is always wanted. Only ever
 * touches our own system task.
 */
export async function ensureCapabilityAuditTask(): Promise<void> {
  const { listScheduledTasks, createScheduledTask, updateScheduledTask } =
    await import('@/lib/scheduling/store')

  const timezone = resolveCapabilityAuditTimezone()
  const existing = listScheduledTasks().find(
    (t) =>
      t.createdBy === 'system' &&
      t.action.kind === 'agent' &&
      t.title === CAPABILITY_AUDIT_TASK_TITLE
  )

  if (existing) {
    const patch: Parameters<typeof updateScheduledTask>[1] = {}
    if (!existing.enabled) patch.enabled = true
    if (!isDesiredSchedule(existing.schedule, timezone)) {
      patch.schedule = {
        kind: 'weeklyAt',
        weekdays: [AUDIT_WEEKDAY],
        hour: AUDIT_HOUR,
        minute: AUDIT_MINUTE,
        timezone,
      }
    }
    // Keep the prompt in sync as the doctrine evolves across releases.
    if (existing.action.kind !== 'agent' || existing.action.prompt !== CAPABILITY_AUDIT_PROMPT) {
      patch.action = {
        kind: 'agent',
        agentId: 'orchestrator',
        prompt: CAPABILITY_AUDIT_PROMPT,
        adaptive: false,
      }
    }
    if (Object.keys(patch).length > 0) updateScheduledTask(existing.id, patch)
    return
  }

  createScheduledTask(buildCapabilityAuditTaskInput(timezone))
}

/** Idempotent boot entry, mirrors wireMemoryReflection(). */
export async function wireCapabilityAudit(): Promise<void> {
  await ensureCapabilityAuditTask()
}
