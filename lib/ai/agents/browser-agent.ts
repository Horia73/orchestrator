import type { AgentConfig } from './types'

/**
 * Browser agent backed by the local Patchright/Gemini browser runtime.
 * The browser runtime owns its own visual loop and receives the delegated
 * task prompt directly, so parent agents must send self-contained handoffs.
 */
export const browserAgent: AgentConfig = {
    id: 'browser_agent',
    name: 'Browser agent',
    description: 'Drives a real browser for interactive web execution, visual inspection, screenshots, and short screen recordings. Browser state resumes through the parent-agent thread, and the local browser profile preserves cookies/session state across runs. Stops before payments, orders, bookings, sends, uploads, permissions, account changes, legal acceptance, and destructive actions unless the prompt includes explicit scoped confirmation.',
    kind: 'text',
    provider: 'browser',
    model: 'default',
    tools: [],
    canCallAgents: [],
}
