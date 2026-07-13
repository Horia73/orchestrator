// Tracks in-flight non-chat agent runs (inbox replies and scheduled tasks
// that wake a model). Distinct from `chat-streams` because:
//   - many can run in parallel under the same conversationId
//   - no anti-double-stream semantics (a new run does not abort an old one)
//   - lifetime is bounded explicitly by the caller's try/finally

import { getAiRunAdmissionBlock } from '@/lib/ai/run-admission'

export interface ActiveAgentRun {
    id: string
    kind: 'inbox' | 'scheduled' | 'app'
    conversationId: string
    startedAt: number
}

const globalForAgentRuns = globalThis as unknown as {
    __orchestratorAgentRuns?: Map<string, ActiveAgentRun>
}

const agentRuns = globalForAgentRuns.__orchestratorAgentRuns ?? new Map<string, ActiveAgentRun>()

if (!globalForAgentRuns.__orchestratorAgentRuns) {
    globalForAgentRuns.__orchestratorAgentRuns = agentRuns
}

export function registerAgentRun(run: ActiveAgentRun): boolean {
    if (getAiRunAdmissionBlock()) return false
    agentRuns.set(run.id, run)
    return true
}

export function clearAgentRun(id: string): void {
    agentRuns.delete(id)
}

export function listAgentRuns(): ActiveAgentRun[] {
    return Array.from(agentRuns.values()).sort((a, b) => a.startedAt - b.startedAt)
}
