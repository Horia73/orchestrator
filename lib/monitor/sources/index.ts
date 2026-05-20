import type { MonitorRule, WatchSource } from '../schema'
import { ruleMatchesSource } from '../rules'

import { customSourceAdapter } from './custom'
import { gmailSourceAdapter } from './gmail'
import { homeAssistantSourceAdapter } from './home_assistant'
import type { SourceAdapter } from './types'
import { webSourceAdapter } from './web'
import { whatsappSourceAdapter } from './whatsapp'

// ---------------------------------------------------------------------------
// Source registry.
//
// Engine and tools look up adapters by source through this single map. To add
// a new source: write the adapter, add its WatchSource value in schema.ts,
// add an entry here. Nothing else changes — the engine is source-agnostic.
// ---------------------------------------------------------------------------

const REGISTRY: Record<WatchSource, SourceAdapter> = {
    gmail: gmailSourceAdapter,
    whatsapp: whatsappSourceAdapter,
    home_assistant: homeAssistantSourceAdapter,
    web: webSourceAdapter,
    custom: customSourceAdapter,
}

export function getSourceAdapter(source: WatchSource): SourceAdapter {
    return REGISTRY[source]
}

export function listSourceAdapters(): SourceAdapter[] {
    return Object.values(REGISTRY)
}

/** Capability snapshot of a single source — used by the orchestrator tools
 *  and `/monitor` UI to show "what can I watch via Gmail?" before the user
 *  commits to a rule. */
export interface SourceCapability {
    source: WatchSource
    supportedRuleKinds: ReadonlyArray<MonitorRule['kind']>
    supportedActionKinds: ReadonlyArray<string>
}

export function listSourceCapabilities(): SourceCapability[] {
    return listSourceAdapters().map((a) => ({
        source: a.source,
        supportedRuleKinds: a.supportedRuleKinds,
        supportedActionKinds: a.supportedActionKinds,
    }))
}

/** Validate that a rule's leaf predicates all belong to the watch's source.
 *  Used at create/update time before the watch lands in the store — produces
 *  a friendly error instead of a tick-time runtime failure. */
export function assertRuleMatchesSource(rule: MonitorRule, source: WatchSource): void {
    if (source === 'custom') return // adapter-less; nothing to validate yet.
    if (!ruleMatchesSource(rule, source)) {
        throw new Error(
            `Rule contains predicate(s) not supported by source "${source}". Allowed kinds: ${getSourceAdapter(source).supportedRuleKinds.join(', ')}.`,
        )
    }
}

export type { SourceAdapter, AvailabilityResult, CheapCheckInput, CheapCheckResult, MatchedCandidate } from './types'
