import { ORCHESTRATOR_ACTION_POLICY } from './action-policy'
import { ORCHESTRATOR_CORE } from './core'
import { ORCHESTRATOR_DELEGATION } from './delegation'
import { ORCHESTRATOR_EXAMPLES } from './examples'
import { ORCHESTRATOR_INTEGRATIONS } from './integrations'
import { ORCHESTRATOR_MEMORY } from './memory'
import { ORCHESTRATOR_MONITORING } from './monitoring'
import { ORCHESTRATOR_OUTPUT_CONTRACT } from './output-contract'
import { ORCHESTRATOR_SCHEDULING } from './scheduling'
import { ORCHESTRATOR_WATCHLIST } from './watchlist'

export const ORCHESTRATOR_PROMPT = [
    ORCHESTRATOR_CORE,
    ORCHESTRATOR_MEMORY,
    ORCHESTRATOR_ACTION_POLICY,
    ORCHESTRATOR_INTEGRATIONS,
    ORCHESTRATOR_DELEGATION,
    ORCHESTRATOR_WATCHLIST,
    // Smart Monitor sits between Watchlist and Scheduling in the prompt
    // because its mental model leans on both — it's a consolidated heartbeat
    // (like Watchlist's markets monitor) that exposes subscriptions, not
    // scheduled tasks. Putting it after Watchlist + before Scheduling lets
    // the model contrast each.
    ORCHESTRATOR_MONITORING,
    ORCHESTRATOR_SCHEDULING,
    ORCHESTRATOR_OUTPUT_CONTRACT,
    ORCHESTRATOR_EXAMPLES,
].filter(Boolean).join('\n\n')
