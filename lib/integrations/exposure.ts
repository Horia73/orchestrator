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
    if (entry.id === 'whatsapp') return `loaded (${entry.operationalToolIds.length} read-only tools; connect first when needed)`
    const connected = snapshot[entry.statusKind]?.state === 'connected'
    if (!connected) return 'unavailable until connected'
    if (activated.has(entry.id)) return `loaded (${entry.operationalToolIds.length} tools)`
    return `inactive — call ActivateIntegrationTools("${entry.id}") to load the tool details`
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
        if (runbookPath) parts.push(`  Setup runbook: ${runbookPath}`)
        if (entry.note) parts.push(`  Note: ${entry.note}`)
        return parts.join('\n')
    })

    return [
        '<integrations>',
        'Integrations available in this runtime. This is the always-on summary — it tells you each integration exists, what it does, and its live connection state, WITHOUT loading heavy tool schemas.',
        'How to use this:',
        '- Setup/lifecycle tools (status, configure, OAuth) are always available for these integrations; use them plus the setup runbook to connect or repair an integration. Follow <integration_setup_policy>.',
        '- Operational tool schemas (search, send, read, control, …) are NOT loaded by default. When an integration is connected and you actually need to operate it, call ActivateIntegrationTools with its id once. Then call the direct tool if it is visible, or call RunActivatedIntegrationTool with the target tool_id and arguments in the same turn. This keeps context lean — do not activate integrations you are not about to use.',
        '- Never claim an integration is connected unless its State here (or a fresh status check) confirms it.',
        ...lines,
        '</integrations>',
    ].join('\n')
}

/** Human summary of an integration's now-available operational tools, for the ActivateIntegrationTools result. */
export function describeActivatedIntegration(integrationId: string): string {
    const entry = getIntegrationManifest(integrationId)
    if (!entry) return `Unknown integration "${integrationId}".`
    if (entry.operationalToolIds.length === 0) {
        return `${entry.label} has no operational tools to load (setup/lifecycle only).`
    }
    return `${entry.label} tools are now active for this conversation: ${entry.operationalToolIds.join(', ')}. Use the direct tool when visible, or RunActivatedIntegrationTool with a listed tool_id and arguments in this same turn.`
}

/** All manifest ids — used to validate the ActivateIntegrationTools argument. */
export const ALL_INTEGRATION_IDS: string[] = INTEGRATION_MANIFEST.map(e => e.id)
