import type { ToolDef } from '@/lib/ai/agents/types'
import {
    INTEGRATION_MANIFEST,
    type IntegrationManifestEntry,
    getIntegrationManifest,
    integrationsInScope,
    operationalIntegrationFor,
    runbookPathFor,
} from '@/lib/integrations/manifest'
import {
    ALL_SUBSYSTEM_IDS,
    SUBSYSTEM_MANIFEST,
    type SubsystemManifestEntry,
    getSubsystemManifest,
} from '@/lib/integrations/subsystem-manifest'
import {
    getIntegrationStatusSnapshot,
    type IntegrationStatusSnapshot,
} from '@/lib/integrations/status-snapshot'
import { getActivatedIntegrations } from '@/lib/integrations/activation-store'

// ---------------------------------------------------------------------------
// Tiered integration exposure.
//
// Tier 0 (always, tiny):   the <integrations> block — existence + capability + state.
// Tier 1 (always, small):  setup/lifecycle tool schemas for in-scope integrations.
// Tier 2 (on demand):      operational tool schemas — only when the integration
//                          is connected AND activated for the conversation.
//
// One lever (the resolved ToolDef[] passed to both the prompt builder and the
// provider) keeps the advertised schema and the callable set perfectly in sync.
// ---------------------------------------------------------------------------

export interface ExposureOptions {
    conversationId: string | undefined
    origin?: string
}

/**
 * Drop operational integration tools whose integration is not connected, or is
 * connected but not yet activated for this conversation. Non-integration tools
 * and setup/lifecycle tools always pass through.
 */
export function filterIntegrationToolExposure(
    tools: ToolDef[],
    opts: ExposureOptions
): ToolDef[] {
    const snapshot = getIntegrationStatusSnapshot(opts.origin)
    const activated = getActivatedIntegrations(opts.conversationId)
    return tools.filter(tool => {
        const integrationId = operationalIntegrationFor(tool.id)
        if (!integrationId) return true
        if (integrationId === 'whatsapp') return true
        const entry = getIntegrationManifest(integrationId)
        if (!entry) return true
        const state = snapshot[entry.statusKind]?.state
        return state === 'connected' && activated.has(integrationId)
    })
}

function stateLabel(snapshot: IntegrationStatusSnapshot, entry: IntegrationManifestEntry): string {
    const s = snapshot[entry.statusKind]
    switch (s?.state) {
        case 'connected':
            return s.detail ? `connected (${s.detail})` : 'connected'
        case 'needs_reconnect':
            return s.detail ? `needs reconnect (${s.detail})` : 'needs reconnect'
        case 'configured':
            return 'configured but not connected'
        case 'not_configured':
            return 'not configured'
        default:
            return 'unknown — verify before relying on it'
    }
}

function toolsLabel(
    snapshot: IntegrationStatusSnapshot,
    activated: Set<string>,
    entry: IntegrationManifestEntry
): string {
    if (entry.operationalToolIds.length === 0) return 'setup/lifecycle only'
    if (entry.id === 'whatsapp') return `loaded (${entry.operationalToolIds.length} tools; writes require explicit confirmation; connect first when needed)`
    const connected = snapshot[entry.statusKind]?.state === 'connected'
    if (!connected) return 'unavailable until connected'
    if (activated.has(entry.id)) return `loaded (${entry.operationalToolIds.length} tools)`
    return `inactive — call ActivateIntegrationTools("${entry.id}") to load the tool details`
}

/** Rough token-cost label for the integration's doctrine ("~3.7k tokens"). */
function doctrineLabel(entry: IntegrationManifestEntry, activated: Set<string>): string | null {
    if (!entry.doctrine) return null
    // ~4 chars/token English approximation; rounded to one decimal at the kilo.
    const tokens = entry.doctrine.length / 4
    const kilo = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${Math.round(tokens)}`
    if (activated.has(entry.id)) {
        return `loaded (${kilo} tokens; see <active_capability_doctrines>)`
    }
    return `${kilo} tokens, not loaded — call ActivateIntegrationTools("${entry.id}") before composing to get schema + cross-integration recipes`
}

/**
 * The Tier-0 <integrations> block. Lists every integration the agent is in
 * scope for: what it does, its live connection state, the runbook to set it
 * up, and whether its operational tools are loaded. Deliberately compact —
 * this replaces dumping ~100 tool schemas on every turn.
 */
export function buildIntegrationsContextBlock(
    declaredToolIds: string[],
    opts: ExposureOptions
): string {
    const scope = integrationsInScope(declaredToolIds)
    if (scope.length === 0) return ''

    const snapshot = getIntegrationStatusSnapshot(opts.origin)
    const activated = getActivatedIntegrations(opts.conversationId)

    const lines = scope.map(entry => {
        const runbookPath = runbookPathFor(entry)
        const parts = [
            `- ${entry.label} (id: ${entry.id}) — ${entry.capability}`,
            `  State: ${stateLabel(snapshot, entry)}. Tools: ${toolsLabel(snapshot, activated, entry)}.`,
        ]
        const doctrine = doctrineLabel(entry, activated)
        if (doctrine) parts.push(`  Doctrine: ${doctrine}.`)
        if (runbookPath) parts.push(`  Setup runbook: ${runbookPath}`)
        if (entry.note) parts.push(`  Note: ${entry.note}`)
        return parts.join('\n')
    })

    return [
        '<integrations>',
        'Integrations available in this runtime. This is the always-on summary — it tells you each integration exists, what it does, and its live connection state, WITHOUT loading heavy tool schemas or doctrine.',
        'How to use this:',
        '- Setup/lifecycle tools (status, configure, OAuth) are always available for these integrations; use them plus the setup runbook to connect or repair an integration. Follow <integration_setup_policy>.',
        '- Operational tool schemas (search, send, read, control, …) are NOT loaded by default. When an integration is connected and you actually need to operate it, call ActivateIntegrationTools with its id once. Then call the direct tool if it is visible, or call RunActivatedIntegrationTool with the target tool_id and arguments in the same turn. This keeps context lean — do not activate integrations you are not about to use.',
        '- Composition integrations (maps, weather) also carry a Doctrine block: schema references and cross-integration recipes. Their tools are always visible, but the doctrine is loaded only when you ActivateIntegrationTools — call it before composing if the Doctrine line says "not loaded".',
        '- Never claim an integration is connected unless its State here (or a fresh status check) confirms it.',
        ...lines,
        '</integrations>',
    ].join('\n')
}

/**
 * The lazy doctrine surface. Emits one `<doctrine for="…">…</doctrine>`
 * block per activated capability whose manifest entry carries a doctrine
 * string — covers both external integrations (maps, weather) and native
 * subsystems (watchlist, monitoring, scheduling). Sorted by id for cache
 * stability — order is deterministic across turns once an activation set
 * is fixed.
 *
 * Returns '' when no activated capability has a doctrine, so the caller's
 * `.filter(Boolean)` drops the block cleanly.
 */
export function buildActiveCapabilityDoctrinesBlock(opts: ExposureOptions): string {
    const activated = getActivatedIntegrations(opts.conversationId)
    if (activated.size === 0) return ''
    const sorted = [...activated].sort()
    const blocks: string[] = []
    for (const id of sorted) {
        const doctrine = getIntegrationManifest(id)?.doctrine ?? getSubsystemManifest(id)?.doctrine
        if (!doctrine) continue
        blocks.push(`<doctrine for="${id}">\n${doctrine}\n</doctrine>`)
    }
    if (blocks.length === 0) return ''
    return [
        '<active_capability_doctrines>',
        'Operating doctrine for capabilities you have activated this conversation. Each block carries the canonical schema, flow, cross-integration recipes, and gotchas for one capability. Loaded lazily — only after ActivateIntegrationTools. Sorted alphabetically by id for cache stability.',
        ...blocks,
        '</active_capability_doctrines>',
    ].join('\n\n')
}

/** Rough token-cost label for a subsystem's doctrine ("~2.7k tokens"). */
function subsystemDoctrineLabel(entry: SubsystemManifestEntry, activated: Set<string>): string {
    const tokens = entry.doctrine.length / 4
    const kilo = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${Math.round(tokens)}`
    if (activated.has(entry.id)) {
        return `loaded (${kilo} tokens; see <active_capability_doctrines>)`
    }
    return `${kilo} tokens, not loaded — call ActivateIntegrationTools("${entry.id}") before composing to get the full doctrine`
}

/**
 * The Tier-0 <subsystems> block. Mirrors <integrations> but for orchestrator-
 * native subsystems with no connection state and no setup runbook. Always-on
 * (it's small) so the orchestrator knows each subsystem exists; the heavy
 * doctrine still goes through ActivateIntegrationTools.
 */
export function buildSubsystemsContextBlock(opts: ExposureOptions): string {
    if (SUBSYSTEM_MANIFEST.length === 0) return ''
    const activated = getActivatedIntegrations(opts.conversationId)

    const lines = SUBSYSTEM_MANIFEST.map((entry) => {
        return [
            `- ${entry.label} (id: ${entry.id}) — ${entry.capability}`,
            `  Doctrine: ${subsystemDoctrineLabel(entry, activated)}.`,
        ].join('\n')
    })

    return [
        '<subsystems>',
        'Orchestrator-native subsystems available in this runtime. Their tools are always granted (no setup, no connection state) — but their operating doctrine is loaded lazily, same primitive as integrations: call ActivateIntegrationTools with the subsystem id when you are about to set up a monitor, schedule a task, or compose a watchlist update. Read the loaded doctrine under <active_capability_doctrines>.',
        ...lines,
        '</subsystems>',
    ].join('\n')
}

/** Human summary of a now-activated capability — covers integrations + subsystems. Drives the ActivateIntegrationTools result message. */
export function describeActivatedIntegration(capabilityId: string): string {
    const integration = getIntegrationManifest(capabilityId)
    if (integration) {
        const parts: string[] = []
        if (integration.operationalToolIds.length > 0) {
            parts.push(`${integration.label} tools are now active for this conversation: ${integration.operationalToolIds.join(', ')}. Use the direct tool when visible, or RunActivatedIntegrationTool with a listed tool_id and arguments in this same turn.`)
        } else if (integration.doctrine) {
            parts.push(`${integration.label} doctrine is now loaded.`)
        } else {
            parts.push(`${integration.label} has no operational tools or doctrine to load (setup/lifecycle only).`)
        }
        if (integration.doctrine) {
            parts.push(`The full doctrine for ${integration.id} (schema, flow, cross-integration recipes) is now in your prompt under <active_capability_doctrines> from the next turn onward — read it there before composing.`)
        }
        return parts.join(' ')
    }

    const subsystem = getSubsystemManifest(capabilityId)
    if (subsystem) {
        return `${subsystem.label} doctrine is now loaded. The full doctrine for ${subsystem.id} (schema, flow, gotchas) is now in your prompt under <active_capability_doctrines> from the next turn onward — read it there before composing. The subsystem's tools were already granted; activation only injects the doctrine.`
    }

    return `Unknown capability "${capabilityId}".`
}

/** All integration ids — Maps/Weather/Gmail/Calendar/etc. */
export const ALL_INTEGRATION_IDS: string[] = INTEGRATION_MANIFEST.map(e => e.id)

/**
 * Every capability id the orchestrator may pass to ActivateIntegrationTools —
 * integrations + orchestrator-native subsystems. The activation tool uses
 * this as its enum so both kinds route through one primitive.
 */
export const ALL_CAPABILITY_IDS: string[] = [...ALL_INTEGRATION_IDS, ...ALL_SUBSYSTEM_IDS]

/** True when the id refers to a native orchestrator subsystem (no setup/state). */
export function isSubsystemId(id: string): boolean {
    return ALL_SUBSYSTEM_IDS.includes(id as (typeof ALL_SUBSYSTEM_IDS)[number])
}
