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
    subsystemForGatedTool,
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
    /** Agent the exposure is for. Drives per-agent default activation (below). */
    agentId?: string
}

// ---------------------------------------------------------------------------
// Per-agent default activation.
//
// Some orchestrator-class aliases run autonomously (Smart Monitor wakes) or
// near-autonomously (Inbox replies) and shouldn't pay an activation round-trip
// for the capability that defines them. These ids are treated as activated for
// those agents WITHOUT an ActivateIntegrationTools call — their gated tool
// schemas and doctrine load up front.
//
// Keep this LEAN: every default re-adds that capability's tool schemas +
// doctrine to those contexts. The main chat orchestrator has no defaults — it
// activates on demand. Note the Smart Monitor wake's core loop
// (notify_inbox / set_task_state / monitor_wake_feedback) is always-on
// regardless, so it keeps working even with an empty default set.
// ---------------------------------------------------------------------------
const DEFAULT_ACTIVATED_BY_AGENT: Record<string, readonly string[]> = {
    // Inbox replies frequently set reminders / schedule follow-ups.
    'inbox-agent': ['scheduling'],
    // Smart Monitor's whole job is monitoring; give wakes the doctrine + watch
    // tools up front so a wake can adjust a watch without a hop.
    'smart-monitor-agent': ['monitoring'],
}

/** Capability ids pre-activated for an agent without an explicit activation call. */
export function getDefaultActivatedCapabilities(agentId: string | undefined): readonly string[] {
    if (!agentId) return []
    return DEFAULT_ACTIVATED_BY_AGENT[agentId] ?? []
}

/** Stored per-conversation activations unioned with the agent's defaults. */
function effectiveActivated(opts: ExposureOptions): Set<string> {
    const set = getActivatedIntegrations(opts.conversationId)
    for (const id of getDefaultActivatedCapabilities(opts.agentId)) set.add(id)
    return set
}

/**
 * Drop operational capability tool schemas the agent hasn't earned this turn:
 * - integration operational tools: dropped unless connected AND activated
 *   (activationOnly integrations like maps/weather skip the connection gate);
 * - native subsystem tools (watchlist/monitoring/scheduling/microscripts):
 *   dropped unless the subsystem is activated.
 * Non-gated tools, setup/lifecycle tools, and the safe-subset tools left out of
 * a subsystem's toolIds (notify_inbox, monitor_wake_feedback, …) always pass.
 */
export function filterIntegrationToolExposure(
    tools: ToolDef[],
    opts: ExposureOptions
): ToolDef[] {
    const snapshot = getIntegrationStatusSnapshot(opts.origin)
    const activated = effectiveActivated(opts)
    return tools.filter(tool => {
        const integrationId = operationalIntegrationFor(tool.id)
        if (integrationId) {
            if (integrationId === 'whatsapp') return true
            const entry = getIntegrationManifest(integrationId)
            if (!entry) return true
            // activationOnly capabilities (maps, weather) gate by activation
            // alone — there is no connection handshake to wait on.
            if (entry.activationOnly) return activated.has(integrationId)
            const state = snapshot[entry.statusKind]?.state
            return state === 'connected' && activated.has(integrationId)
        }
        const subsystemId = subsystemForGatedTool(tool.id)
        if (subsystemId) return activated.has(subsystemId)
        return true
    })
}

/**
 * One-line menu of the operational tools a capability unlocks on activation,
 * each annotated with a short description so the agent knows what is behind the
 * gate and activates the right capability instead of blind-calling a hidden
 * tool. Returns null when there is nothing to advertise.
 */
function gatedToolsMenuLine(
    toolIds: readonly string[],
    toolSummaries: Map<string, string> | undefined
): string | null {
    if (toolIds.length === 0) return null
    const parts = toolIds.map(id => {
        const desc = toolSummaries?.get(id)
        return desc ? `${id} — ${desc}` : id
    })
    return `  Tools when active: ${parts.join('; ')}`
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
    if (entry.operationalToolIds.length === 0) {
        return entry.setupToolIds.length > 0 ? 'setup/lifecycle only' : 'status/runbook only'
    }
    if (entry.id === 'whatsapp') return `loaded (${entry.operationalToolIds.length} tools; writes require explicit confirmation; connect first when needed)`
    if (activated.has(entry.id)) return `loaded (${entry.operationalToolIds.length} tools)`
    // activationOnly (maps, weather): no connection gate — activatable anytime.
    if (entry.activationOnly) {
        return `inactive — call ActivateIntegrationTools("${entry.id}") to load the ${entry.operationalToolIds.length} tool schemas`
    }
    const connected = snapshot[entry.statusKind]?.state === 'connected'
    if (!connected) return 'unavailable until connected'
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
    opts: ExposureOptions,
    toolSummaries?: Map<string, string>
): string {
    const scope = integrationsInScope(declaredToolIds)
    if (scope.length === 0) return ''

    const snapshot = getIntegrationStatusSnapshot(opts.origin)
    const activated = effectiveActivated(opts)

    const lines = scope.map(entry => {
        const runbookPath = runbookPathFor(entry)
        const parts = [
            `- ${entry.label} (id: ${entry.id}) — ${entry.capability}`,
            `  State: ${stateLabel(snapshot, entry)}. Tools: ${toolsLabel(snapshot, activated, entry)}.`,
        ]
        // Advertise the per-tool menu only for activationOnly capabilities
        // (maps, weather) whose tools used to be always-on and now need an
        // activation hop — so the model knows exactly what it unlocks and
        // activates instead of blind-calling. Connection-bearing integrations
        // (Gmail, Calendar, Workspace, Home Assistant) keep the compact line:
        // their capability summary already describes them, their schemas were
        // gated before this change, and a full menu for tools the model can't
        // call until connected is just bloat.
        if (entry.activationOnly && entry.operationalToolIds.length > 0 && !activated.has(entry.id)) {
            const menu = gatedToolsMenuLine(entry.operationalToolIds, toolSummaries)
            if (menu) parts.push(menu)
        }
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
        '- IMPORTANT — do not get stuck: if you try a capability tool by name and the runtime reports it is not available / no such tool, that only means its schema is not in your live tool list (some runtimes freeze the list at start); the tool still exists. Run it via RunActivatedIntegrationTool with its exact tool_id and arguments — never tell the user the capability is missing or silently abandon the task over this.',
        '- Composition integrations (maps, weather) gate BOTH their operational tool schemas AND their doctrine behind activation, with no connection handshake: their status/lifecycle tools stay visible, but call ActivateIntegrationTools with the id before composing to load the rendering/query tools (see the "Tools when active" menu) plus the schema + cross-integration recipes. A missing API key surfaces as a per-call error, not a reason to skip activation.',
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
    const activated = effectiveActivated(opts)
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
export function buildSubsystemsContextBlock(
    opts: ExposureOptions,
    toolSummaries?: Map<string, string>
): string {
    if (SUBSYSTEM_MANIFEST.length === 0) return ''
    const activated = effectiveActivated(opts)

    const lines = SUBSYSTEM_MANIFEST.map((entry) => {
        const gated = entry.toolIds ?? []
        const isActive = activated.has(entry.id)
        const parts = [`- ${entry.label} (id: ${entry.id}) — ${entry.capability}`]
        if (gated.length === 0) {
            // Doctrine-only playbook: no tools of its own, just lazy guidance.
            parts.push(`  Doctrine: ${subsystemDoctrineLabel(entry, activated)}.`)
        } else {
            const toolsState = isActive
                ? `loaded (${gated.length} tools)`
                : `inactive — call ActivateIntegrationTools("${entry.id}") to load the ${gated.length} tool schemas`
            parts.push(`  Tools: ${toolsState}. Doctrine: ${subsystemDoctrineLabel(entry, activated)}.`)
            if (!isActive) {
                const menu = gatedToolsMenuLine(gated, toolSummaries)
                if (menu) parts.push(menu)
            }
        }
        return parts.join('\n')
    })

    return [
        '<subsystems>',
        'Orchestrator-native subsystems and playbooks available in this runtime (no setup, no connection state). Their operational tool schemas (where they have tools) AND their operating doctrine load lazily via the same primitive as integrations: call ActivateIntegrationTools with the id when you are about to use one — set up a monitor, schedule a task, manage a microscript, compose a watchlist update, author a media production prompt, prepare a browser_agent handoff, or emit a recipe/workout artifact. Doctrine-only entries have no tools — activation just loads their guidance. The "Tools when active" menu lists what a tool-bearing entry unlocks; activate before calling, do not call a gated tool blind. If a gated subsystem tool is not in your live tool list (some runtimes freeze it), run it via RunActivatedIntegrationTool with its tool_id and arguments — the tool still exists; do not abandon the task. Read loaded doctrine under <active_capability_doctrines>.',
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
        const toolIds = subsystem.toolIds ?? []
        const toolPart = toolIds.length > 0
            ? `${subsystem.label} tools are now active for this conversation: ${toolIds.join(', ')}. Use the direct tool when visible, or RunActivatedIntegrationTool with a listed tool_id and arguments in this same turn. `
            : ''
        return `${toolPart}${subsystem.label} doctrine is now loaded — the full doctrine for ${subsystem.id} (schema, flow, gotchas) is in your prompt under <active_capability_doctrines> from the next turn onward; read it there before composing.`
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
