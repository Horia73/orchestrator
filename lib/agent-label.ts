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

/**
 * Produce stable, visibly distinct labels within one parent workspace. This is
 * also a defensive fix for historical runs created before assigned-name
 * collision prevention existed.
 */
export function distinctAgentRoleAndNames(
  entries: readonly AgentLabelFields[],
  reserved: readonly AgentLabelFields[] = []
): string[] {
  const seen = new Map<string, number>()
  for (const entry of reserved) {
    const key = agentRoleAndName(entry).toLocaleLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return entries.map((entry) => {
    const base = agentRoleAndName(entry)
    const key = base.toLocaleLowerCase()
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    return occurrence === 1 ? base : `${base} · ${occurrence}`
  })
}

/** Keep a model-assigned persona distinct from its parent and batch siblings. */
export function distinctAssignedName(
  name: string | undefined,
  reservedNames: Iterable<string | undefined>
): string | undefined {
  if (!name) return undefined
  const reserved = new Set(
    Array.from(reservedNames)
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().toLocaleLowerCase())
  )
  if (!reserved.has(name.toLocaleLowerCase())) return name

  const base = name.replace(/-\d+$/, "") || name
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const marker = `-${suffix}`
    const candidate = `${base.slice(0, Math.max(1, 24 - marker.length))}${marker}`
    if (!reserved.has(candidate.toLocaleLowerCase())) return candidate
  }
  return name
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
