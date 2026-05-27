// Tracks in-flight non-chat agent runs (inbox replies and scheduled tasks
// that wake a model). Distinct from `chat-streams` because:
//   - many can run in parallel under the same conversationId
//   - no anti-double-stream semantics (a new run does not abort an old one)
//   - lifetime is bounded explicitly by the caller's try/finally

export interface ActiveAgentRun {
    id: string
    kind: 'inbox' | 'scheduled'
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

export function registerAgentRun(run: ActiveAgentRun): void {
    agentRuns.set(run.id, run)
}

export function clearAgentRun(id: string): void {
    agentRuns.delete(id)
}

export function listAgentRuns(): ActiveAgentRun[] {
    return Array.from(agentRuns.values()).sort((a, b) => a.startedAt - b.startedAt)
}
