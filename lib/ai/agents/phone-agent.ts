import type { AgentConfig } from './types'

/**
 * Phone agent — planned runtime.
 *
 * Target: place and receive calls, talk over the phone, and report outcomes
 * back to the orchestrator. The telephony bridge is not wired yet.
 */
export const phoneAgent: AgentConfig = {
    id: 'phone_agent',
    name: 'Phone agent',
    description: 'Calls and speaks over the phone for real-world tasks. To be implemented.',
    kind: 'phone',
    status: 'planned',
    tools: [],
    canCallAgents: [],
}
