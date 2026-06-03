import type { AgentConfig } from './types'
import { orchestrator } from './orchestrator'

// ---------------------------------------------------------------------------
// Smart Monitor alias of the orchestrator.
//
// Same prompt, same tools, same delegation rights — only the id/name/desc
// differ so Settings shows a dedicated card whose provider/model override
// applies only when the Smart Monitor heartbeat wakes the agent on matches.
// Lets the user send recurring monitor wakes to a different (e.g. cheaper)
// subscription without touching the main chat orchestrator.
// ---------------------------------------------------------------------------

export const smartMonitorAgent: AgentConfig = {
    ...orchestrator,
    id: 'smart-monitor-agent',
    name: 'Smart Monitor',
    description: 'Wakes on Smart Monitor matches; decides notify/action.',
    tier: 'system',
}
