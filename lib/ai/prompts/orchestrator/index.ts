import { ORCHESTRATOR_ACTION_POLICY } from './action-policy'
import { ORCHESTRATOR_CORE } from './core'
import { ORCHESTRATOR_DELEGATION } from './delegation'
import { ORCHESTRATOR_INTEGRATIONS } from './integrations'
import { ORCHESTRATOR_BOOT_PROTOCOL, ORCHESTRATOR_MEMORY } from './memory'
import { ORCHESTRATOR_OUTPUT_CONTRACT } from './output-contract'

// Static orchestrator prompt. Capability doctrines that used to live here
// (maps, weather, watchlist, monitoring, scheduling) now live in
// lib/integrations/doctrines/ and are injected lazily by
// buildActiveCapabilityDoctrinesBlock() only when the orchestrator
// activates the capability for the conversation via
// ActivateIntegrationTools. The always-on capability summary surface is in
// the <integrations> + <subsystems> blocks built by exposure.ts.
//
// The development protocols moved the same way: Orchestrator self-updates live
// in lib/integrations/doctrines/self-development.ts behind self_dev, while
// standalone/external projects live in project-development.ts behind
// project_dev. <coding_product_work> routes to the right one.
//
// The one conditional piece is <boot_protocol>: the onboarding script only
// matters while BOOT.md exists in the workspace, so it is included only then
// (it sits right after the memory block, where it used to live inline). Both
// variants are joined once at module load — the per-call cost is a lookup.
function joinPrompt(withBootProtocol: boolean): string {
    return [
        ORCHESTRATOR_CORE,
        ORCHESTRATOR_MEMORY,
        withBootProtocol ? ORCHESTRATOR_BOOT_PROTOCOL : '',
        ORCHESTRATOR_ACTION_POLICY,
        ORCHESTRATOR_INTEGRATIONS,
        ORCHESTRATOR_DELEGATION,
        ORCHESTRATOR_OUTPUT_CONTRACT,
    ].filter(Boolean).join('\n\n')
}

// Smart Monitor gets its concrete operating/action policy in every wake prompt
// (lib/monitoring/smart-monitor.ts). Shipping the chat agent's commerce,
// document, coding, artifact, onboarding, and worked-example policy as well is
// both redundant and costly. Keep the shared core that a custom watch can
// legitimately need: memory, integration activation, delegation, and output.
const SMART_MONITOR_PROMPT = [
    ORCHESTRATOR_CORE,
    ORCHESTRATOR_MEMORY,
    ORCHESTRATOR_INTEGRATIONS,
    ORCHESTRATOR_DELEGATION,
    ORCHESTRATOR_OUTPUT_CONTRACT,
].filter(Boolean).join('\n\n')

const PROMPT_WITH_BOOT = joinPrompt(true)
const PROMPT_WITHOUT_BOOT = joinPrompt(false)

export function buildOrchestratorStaticPrompt(opts: {
    bootActive: boolean
    mode?: 'orchestrator' | 'smart-monitor'
}): string {
    if (opts.mode === 'smart-monitor') return SMART_MONITOR_PROMPT
    return opts.bootActive ? PROMPT_WITH_BOOT : PROMPT_WITHOUT_BOOT
}
