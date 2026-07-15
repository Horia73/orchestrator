import type { AgentCallReasoningEntry } from "@/lib/types"

export type BrowserAgentPauseKind = "none" | "checkpoint" | "takeover"

const AWAITING_USER_RE = /\bSession status:\s*awaiting_user\b/i
const FINAL_ACTION_RE = /\bFinal action:\s*(ask|checkpoint)\b/gi

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

export function browserSessionIdFromRunContent(content: string): string | null {
  const match = content.match(/\bBrowser session:\s*([A-Za-z0-9_.:-]+)/i)
  return match?.[1] ?? null
}
