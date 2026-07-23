import type { AgentCallReasoningEntry, ReasoningEntry } from "@/lib/types"

export type BrowserAgentPauseKind = "none" | "checkpoint" | "takeover"

const AWAITING_USER_RE = /\bSession status:\s*awaiting_user\b/i
const FINAL_ACTION_RE = /\bFinal action:\s*(ask|checkpoint)\b/gi
const BROWSER_QUEUE_RE = /\b(?:browser is busy with another conversation|previous app generation is still finishing browser work)\b/i

export function browserAgentPauseKindFromContent(
  content: string
): BrowserAgentPauseKind {
  if (!AWAITING_USER_RE.test(content)) return "none"

  let finalAction: "ask" | "checkpoint" | null = null
  for (const match of content.matchAll(FINAL_ACTION_RE)) {
    finalAction = match[1].toLowerCase() as "ask" | "checkpoint"
  }

  // Older/in-flight runs may not include Final action yet. Treat an explicit
  // awaiting_user status as a takeover unless it is positively identified as
  // an internal checkpoint, so a login/confirmation request is never hidden.
  return finalAction === "checkpoint" ? "checkpoint" : "takeover"
}

export function browserAgentRunPauseKind(
  entry: AgentCallReasoningEntry
): BrowserAgentPauseKind {
  return browserAgentPauseKindFromContent(entry.content)
}

export function isBrowserAgentRunAwaitingUser(
  entry: AgentCallReasoningEntry
): boolean {
  return browserAgentRunPauseKind(entry) === "takeover"
}

export function isBrowserAgentRunCheckpointed(
  entry: AgentCallReasoningEntry
): boolean {
  return browserAgentRunPauseKind(entry) === "checkpoint"
}

export function isBrowserAgentRunLive(
  entry: AgentCallReasoningEntry
): boolean {
  return entry.status === "running" || browserAgentRunPauseKind(entry) !== "none"
}

function browserAgentThreadKey(entry: AgentCallReasoningEntry): string {
  return entry.agentThreadId?.trim() || entry.runId
}

/**
 * A browser thread can emit several agent_call entries as the parent resumes a
 * checkpoint or takeover. Only the newest entry describes the thread's current
 * state; treating every historical pause as live leaves the UI looking active
 * while the parent has already continued below it.
 */
export function latestBrowserAgentRuns(
  runs: AgentCallReasoningEntry[]
): AgentCallReasoningEntry[] {
  const latest = new Map<
    string,
    { index: number; run: AgentCallReasoningEntry }
  >()

  runs.forEach((run, index) => {
    if (run.agentId !== "browser_agent") return
    latest.set(browserAgentThreadKey(run), { index, run })
  })

  return [...latest.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ run }) => run)
}

function collectBrowserAgentRuns(
  reasoning: ReasoningEntry[],
  out: AgentCallReasoningEntry[]
): void {
  for (const entry of reasoning) {
    if (entry.type !== "agent_call") continue
    if (entry.agentId === "browser_agent") out.push(entry)
    if (entry.reasoning?.length) {
      collectBrowserAgentRuns(entry.reasoning, out)
    }
  }
}

export function latestBrowserAgentRunsFromReasoning(
  reasoning: ReasoningEntry[]
): AgentCallReasoningEntry[] {
  const runs: AgentCallReasoningEntry[] = []
  collectBrowserAgentRuns(reasoning, runs)
  return latestBrowserAgentRuns(runs)
}

export function shouldAutoCloseBrowserAgentPanel(
  entry: AgentCallReasoningEntry
): boolean {
  return (
    entry.agentId === "browser_agent" &&
    (entry.status !== "running" || browserAgentRunPauseKind(entry) !== "none")
  )
}

export function browserSessionIdFromRunContent(content: string): string | null {
  const match = content.match(/\bBrowser session:\s*([A-Za-z0-9_.:-]+)/i)
  return match?.[1] ?? null
}

/** Runtime session for this exact run; content parsing keeps older rows usable. */
export function browserSessionIdFromRun(
  entry: AgentCallReasoningEntry
): string | null {
  return entry.browserSessionId?.trim()
    || browserSessionIdFromRunContent(entry.content)
}

/** Covers both the global agent gate and the browser manager's per-profile queue. */
export function isBrowserAgentRunWaitingInQueue(
  entry: AgentCallReasoningEntry
): boolean {
  if (browserSessionIdFromRun(entry)) return false
  if (entry.queued) return true
  return (entry.reasoning ?? []).some(
    item => item.type === "thought" && BROWSER_QUEUE_RE.test(item.content)
  )
}
