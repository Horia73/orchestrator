import type { AgentConfig } from './types'

/**
 * Browser agent backed by the local visual browser runtime.
 * The browser runtime owns its own visual loop and receives the delegated
 * task prompt directly, so parent agents must send self-contained handoffs.
 */
export const browserAgent: AgentConfig = {
    id: 'browser_agent',
    name: 'Browser agent',
    description: 'Drives a real browser for interactive web tasks, logged-in sites, visual inspection, screenshots, and short recordings.',
    kind: 'text',
    provider: 'browser',
    model: 'default',
    tools: [],
    canCallAgents: [],
}
