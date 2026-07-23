import type { AgentCallReasoningEntry } from "@/lib/types"

/**
 * Nested runs are rendered only by their direct parent's workspace. The
 * known-parent check keeps synthetic system runs whose parentRunId is a message
 * id (rather than an agent run id) visible in the root timeline.
 */
export function isNestedAgentRun(
  entry: AgentCallReasoningEntry,
  knownAgentRunIds: ReadonlySet<string>
): boolean {
  return Boolean(entry.parentRunId && knownAgentRunIds.has(entry.parentRunId))
}

/** Direct children only — descendants belong to the next child's workspace. */
export function directChildAgentRuns(
  runs: readonly AgentCallReasoningEntry[],
  parentRunId: string
): AgentCallReasoningEntry[] {
  return runs.filter((run) => run.parentRunId === parentRunId)
}
