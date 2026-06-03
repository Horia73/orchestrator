import type { AgentConfig } from './types'
import { orchestrator } from './orchestrator'

// ---------------------------------------------------------------------------
// Inbox alias of the orchestrator.
//
// Same prompt, same tools, same delegation rights — only the id/name/desc
// differ so Settings shows a dedicated card whose provider/model override
// applies only when continuing an Inbox reply. Lets the user send Inbox
// traffic to a different (e.g. cheaper) subscription without touching the
// main chat orchestrator.
// ---------------------------------------------------------------------------

export const inboxAgent: AgentConfig = {
    ...orchestrator,
    id: 'inbox-agent',
    name: 'Inbox',
    description: 'Continues inline replies inside Inbox items (no chat fork).',
    tier: 'system',
}
