import type { AgentCallReasoningEntry } from "@/lib/types"

type AgentLabelFields = Pick<
  AgentCallReasoningEntry,
  "agentName" | "assignedName" | "taskLabel"
>

/**
 * Role plus the persona name the delegating agent assigned this run, e.g.
 * "Researcher Marty". Falls back to the bare role when no name was given.
 */
export function agentRoleAndName(entry: AgentLabelFields): string {
  const role = entry.agentName?.trim() || "Agent"
  const name = entry.assignedName?.trim()
  return name ? `${role} ${name}` : role
}

/** Short task topic for this run (the agent thread title), clamped for display. */
export function agentTaskHint(
  entry: AgentLabelFields,
  max = 48
): string | null {
  const task = entry.taskLabel?.trim()
  if (!task) return null
  return task.length > max ? `${task.slice(0, max - 1)}…` : task
}

/**
 * Full one-line agent label, e.g. "Researcher Marty (solar panels in europe)".
 * Drops the parenthetical when there's no task topic.
 */
export function agentFullLabel(entry: AgentLabelFields, max = 48): string {
  const base = agentRoleAndName(entry)
  const task = agentTaskHint(entry, max)
  return task ? `${base} (${task})` : base
}
