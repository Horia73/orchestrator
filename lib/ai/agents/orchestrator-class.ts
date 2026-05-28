// Agent ids that ARE the orchestrator. The Inbox and Smart Monitor agents are
// `{ ...orchestrator }` spreads (see inbox-agent.ts / smart-monitor-agent.ts) —
// same prompt, same tools, same delegation rights, differing only in
// id/name/description so Settings can show a dedicated card with its own
// provider/model override.
//
// Every runtime gate that asks "is this the orchestrator?" must consult this
// set instead of comparing against the literal 'orchestrator' id, otherwise the
// aliases get treated as restricted sub-agents and lose orchestrator-only tools
// (observability, maps, weather) and prompt surfaces (<subsystems>,
// <pending_update>, onboarding) despite holding the same grant.
//
// This module imports nothing on purpose: both lib/ai/tools/executor.ts and
// lib/ai/prompts/shared.ts depend on it, and the agent registry transitively
// pulls in the prompt builder, so a registry-backed lookup here would create an
// import cycle. Any new orchestrator alias must be added to this set.
export const ORCHESTRATOR_CLASS_AGENT_IDS: ReadonlySet<string> = new Set([
    'orchestrator',
    'inbox-agent',
    'smart-monitor-agent',
])

/** True when the agent id is the orchestrator or one of its aliases. */
export function isOrchestratorClassAgent(id: string | undefined | null): boolean {
    return id != null && ORCHESTRATOR_CLASS_AGENT_IDS.has(id)
}
