import type { AgentConfig } from './types'

/**
 * Android agent — planned runtime.
 *
 * Target: use an Android phone connected over USB for app workflows such as
 * ride hailing, deliveries, and other mobile-only services.
 */
export const androidAgent: AgentConfig = {
    id: 'android_agent',
    name: 'Android agent',
    description: 'Controls a USB-connected Android phone for app tasks like Bolt. To be implemented.',
    kind: 'android',
    status: 'planned',
    tools: [],
    canCallAgents: [],
}
