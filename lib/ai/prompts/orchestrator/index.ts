import { ORCHESTRATOR_ACTION_POLICY } from './action-policy'
import { ORCHESTRATOR_CORE } from './core'
import { ORCHESTRATOR_DELEGATION } from './delegation'
import { ORCHESTRATOR_EXAMPLES } from './examples'
import { ORCHESTRATOR_INTEGRATIONS } from './integrations'
import { ORCHESTRATOR_MEMORY } from './memory'
import { ORCHESTRATOR_OUTPUT_CONTRACT } from './output-contract'

// Static orchestrator prompt. Capability doctrines that used to live here
// (maps, weather, watchlist, monitoring, scheduling) now live in
// lib/integrations/doctrines/ and are injected lazily by
// buildActiveCapabilityDoctrinesBlock() only when the orchestrator
// activates the capability for the conversation via
// ActivateIntegrationTools. The always-on capability summary surface is in
// the <integrations> + <subsystems> blocks built by exposure.ts.
export const ORCHESTRATOR_PROMPT = [
    ORCHESTRATOR_CORE,
    ORCHESTRATOR_MEMORY,
    ORCHESTRATOR_ACTION_POLICY,
    ORCHESTRATOR_INTEGRATIONS,
    ORCHESTRATOR_DELEGATION,
    ORCHESTRATOR_OUTPUT_CONTRACT,
    ORCHESTRATOR_EXAMPLES,
].filter(Boolean).join('\n\n')
