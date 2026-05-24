/**
 * Smoke test for the lazy capability-gating refactor.
 *
 * Verifies:
 *   - Maps / Weather / Watchlist / Monitoring / Scheduling doctrines are
 *     NOT present in the orchestrator prompt by default.
 *   - <integrations> and <subsystems> blocks ARE present and mention each
 *     capability with a "not loaded" doctrine hint.
 *   - After ActivateIntegrationTools, the corresponding <doctrine for="…">
 *     block appears under <active_capability_doctrines>, doctrines from
 *     non-activated capabilities stay absent.
 *   - Sub-agents (researcher, multipurpose, concierge) never see BOOT.md
 *     or ONBOARDING.md in their workspace_context_files even when those
 *     files exist on disk, and never see the <subsystems> block.
 *   - The activation store distinguishes integration vs subsystem ids
 *     (integration requires "connected" state; subsystem activates
 *     unconditionally).
 *
 * Run: npx tsx scripts/smoke-capability-gating.ts
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { orchestrator } from '@/lib/ai/agents/orchestrator'
import { researcher } from '@/lib/ai/agents/researcher'
import { multipurpose } from '@/lib/ai/agents/multipurpose'
import { conciergeAgent } from '@/lib/ai/agents/concierge-agent'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'
import { AGENT_WORKSPACE_DIR } from '@/lib/config'
import { activateIntegrations } from '@/lib/integrations/activation-store'
import { executeTool } from '@/lib/ai/tools/executor'
import { activateIntegrationToolsTool } from '@/lib/ai/tools/integrations'
import { ALL_CAPABILITY_IDS, ALL_INTEGRATION_IDS, isSubsystemId } from '@/lib/integrations/exposure'
import { ALL_SUBSYSTEM_IDS } from '@/lib/integrations/subsystem-manifest'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

const DOCTRINE_MARKERS: Record<string, string> = {
    maps: '<maps_capability>',
    weather: '<weather_capability>',
    watchlist: '<watchlist_capability>',
    monitoring: '<smart_monitor_capability>',
    scheduling: '<scheduling_capability>',
    'google-workspace': '<google_workspace_capability>',
}

interface BuildOpts {
    agent: typeof orchestrator
    conversationId: string
}

function buildPromptFor({ agent, conversationId }: BuildOpts): string {
    if (!agent.buildPrompt) throw new Error(`${agent.id} has no buildPrompt`)
    return agent.buildPrompt({
        agentId: agent.id,
        userName: 'Test',
        assistantName: 'Test',
        availableTools: [],
        availableBuiltins: [],
        availableAgents: [],
        conversationId,
        declaredToolIds: agent.tools,
        delegationDepth: agent.id === 'orchestrator' ? 0 : 1,
        maxDelegationDepth: MAX_AGENT_DEPTH,
    })
}

// --- baseline: nothing activated -------------------------------------------

const baselineConvId = `smoke-cap-baseline-${randomUUID()}`
const baselinePrompt = buildPromptFor({ agent: orchestrator, conversationId: baselineConvId })

check(
    'Baseline orchestrator prompt contains <integrations> block',
    baselinePrompt.includes('<integrations>')
)
check(
    'Baseline orchestrator prompt contains <subsystems> block',
    baselinePrompt.includes('<subsystems>')
)
// The literal tag <active_capability_doctrines> may appear in descriptive
// text inside <integrations>/<subsystems> ("read the loaded doctrine
// under <active_capability_doctrines>") even when no doctrines are
// actually loaded — that's intentional guidance. What must NOT appear in
// baseline is any concrete <doctrine for="..."> block.
check(
    'Baseline orchestrator prompt has NO concrete <doctrine for="..."> blocks',
    !/<doctrine for="/.test(baselinePrompt)
)

for (const [id, marker] of Object.entries(DOCTRINE_MARKERS)) {
    check(
        `Baseline orchestrator prompt does NOT include ${id} doctrine (${marker})`,
        !baselinePrompt.includes(marker)
    )
}

check(
    'Baseline <integrations> block hints maps doctrine is gated',
    /maps[^]*?Doctrine:[^]*?not loaded/i.test(baselinePrompt)
)
check(
    'Baseline <subsystems> block hints scheduling doctrine is gated',
    /scheduling[^]*?Doctrine:[^]*?not loaded/i.test(baselinePrompt)
)

// --- after activating two capabilities (one integration, one subsystem) ---

const activatedConvId = `smoke-cap-activated-${randomUUID()}`
// Activate via the store directly to skip the connected-state probe for
// integrations — the smoke test is about prompt assembly, not the live
// status snapshot. Real activation in production still goes through the
// tool and respects connection state.
activateIntegrations(activatedConvId, ['maps', 'scheduling'])

const activatedPrompt = buildPromptFor({ agent: orchestrator, conversationId: activatedConvId })

check(
    'After activation, <active_capability_doctrines> block IS present',
    activatedPrompt.includes('<active_capability_doctrines>')
)
check(
    'After activation, maps doctrine IS loaded',
    activatedPrompt.includes('<doctrine for="maps">') && activatedPrompt.includes(DOCTRINE_MARKERS.maps)
)
check(
    'After activation, scheduling doctrine IS loaded',
    activatedPrompt.includes('<doctrine for="scheduling">') && activatedPrompt.includes(DOCTRINE_MARKERS.scheduling)
)
check(
    'After activation, non-activated weather doctrine is still absent',
    !activatedPrompt.includes(DOCTRINE_MARKERS.weather)
)
check(
    'After activation, non-activated watchlist doctrine is still absent',
    !activatedPrompt.includes(DOCTRINE_MARKERS.watchlist)
)
check(
    'After activation, non-activated monitoring doctrine is still absent',
    !activatedPrompt.includes(DOCTRINE_MARKERS.monitoring)
)
check(
    'Activated doctrines are in alphabetical order (maps before scheduling)',
    activatedPrompt.indexOf('<doctrine for="maps">') < activatedPrompt.indexOf('<doctrine for="scheduling">')
)
check(
    'Activated <integrations> entry for maps says "loaded"',
    /maps[^]*?Doctrine:[^]*?loaded \(~/i.test(activatedPrompt)
)

// --- google-workspace doctrine: same pattern, separate trip ---------------

const workspaceConvId = `smoke-cap-workspace-${randomUUID()}`
activateIntegrations(workspaceConvId, ['google-workspace'])
const workspacePrompt = buildPromptFor({ agent: orchestrator, conversationId: workspaceConvId })

check(
    'Activating google-workspace loads its doctrine block',
    workspacePrompt.includes('<doctrine for="google-workspace">') && workspacePrompt.includes(DOCTRINE_MARKERS['google-workspace'])
)
check(
    'google-workspace doctrine mentions production-Docs guidance (sentinel string)',
    workspacePrompt.includes('For production Google Docs:')
)
check(
    'action-policy <documents_drive_work> stub still references Workspace activation',
    workspacePrompt.includes('<documents_drive_work>') && /ActivateIntegrationTools\("google-workspace"\)/.test(workspacePrompt)
)

// --- sub-agents: no <subsystems>, no BOOT/ONBOARDING --------------------

// Materialize BOOT.md so we can assert sub-agents actually skip it
// rather than trivially passing because the file doesn't exist. We
// restore the original state afterward. ONBOARDING.md is not in
// CONTEXT_FILE_IDS — it's never auto-loaded into the prompt — so we
// don't need to write it for this test; the agent reads it on demand
// via the file tool when resuming onboarding.
const bootPath = path.join(AGENT_WORKSPACE_DIR, 'BOOT.md')
const bootOriginal = fs.existsSync(bootPath) ? fs.readFileSync(bootPath, 'utf-8') : null
fs.mkdirSync(AGENT_WORKSPACE_DIR, { recursive: true })
fs.writeFileSync(bootPath, '# BOOT\n\nSMOKE-BOOT-MARKER content for smoke test.\n')

try {
    const subAgentConvId = `smoke-cap-subagent-${randomUUID()}`

    const orchestratorPromptWithBoot = buildPromptFor({ agent: orchestrator, conversationId: subAgentConvId })
    check(
        'Orchestrator DOES see BOOT.md marker when present',
        orchestratorPromptWithBoot.includes('SMOKE-BOOT-MARKER')
    )

    for (const subAgent of [researcher, multipurpose, conciergeAgent]) {
        const subPrompt = buildPromptFor({ agent: subAgent, conversationId: subAgentConvId })
        check(
            `${subAgent.id} prompt does NOT contain BOOT.md content`,
            !subPrompt.includes('SMOKE-BOOT-MARKER')
        )
        check(
            `${subAgent.id} prompt does NOT contain <subsystems> block`,
            !subPrompt.includes('<subsystems>')
        )
        // Sub-agents may still see <integrations> when their declared tool
        // grant overlaps; e.g. concierge calls integration tools too. So we
        // don't assert absence of <integrations>, just that subsystems are
        // hidden — they're orchestrator-only.
    }
} finally {
    if (bootOriginal === null) fs.unlinkSync(bootPath)
    else fs.writeFileSync(bootPath, bootOriginal)
}

// --- ALL_CAPABILITY_IDS covers both manifests ------------------------------

for (const subsystemId of ALL_SUBSYSTEM_IDS) {
    check(
        `ALL_CAPABILITY_IDS includes subsystem "${subsystemId}"`,
        ALL_CAPABILITY_IDS.includes(subsystemId)
    )
    check(
        `isSubsystemId("${subsystemId}") returns true`,
        isSubsystemId(subsystemId)
    )
}
for (const integrationId of ALL_INTEGRATION_IDS) {
    check(
        `isSubsystemId("${integrationId}") returns false (integration)`,
        !isSubsystemId(integrationId)
    )
}

// --- ActivateIntegrationTools: subsystems skip the connection probe -------

const toolConvId = `smoke-cap-tool-${randomUUID()}`
const toolResult = await executeTool(
    activateIntegrationToolsTool,
    { integrations: ['watchlist'] },
    {
        callerAgentId: 'orchestrator',
        depth: 0,
        conversationId: toolConvId,
        parentRequestId: 'smoke',
    }
)
check(
    'ActivateIntegrationTools succeeds for "watchlist" subsystem',
    toolResult.success,
    toolResult.error
)
if (toolResult.success && toolResult.data && typeof toolResult.data === 'object') {
    const data = toolResult.data as { activated?: string[]; skipped?: string[]; message?: string }
    check(
        'Tool result reports watchlist as activated',
        Array.isArray(data.activated) && data.activated.includes('watchlist'),
        data
    )
    check(
        'Tool result message mentions Watchlist doctrine loaded',
        typeof data.message === 'string' && /watchlist/i.test(data.message) && /doctrine/i.test(data.message),
        data.message
    )
}

const toolPrompt = buildPromptFor({ agent: orchestrator, conversationId: toolConvId })
check(
    'After ActivateIntegrationTools("watchlist"), watchlist doctrine appears in prompt',
    toolPrompt.includes('<doctrine for="watchlist">') && toolPrompt.includes(DOCTRINE_MARKERS.watchlist)
)

// --- token budget regression ----------------------------------------------

const baselineTokensApprox = Math.round(baselinePrompt.length / 4)
const activatedTokensApprox = Math.round(activatedPrompt.length / 4)
console.log(`\nApprox token budget (4 chars/token):`)
console.log(`  baseline (zero activations): ${baselineTokensApprox} tokens`)
console.log(`  after maps + scheduling activated: ${activatedTokensApprox} tokens`)
console.log(`  delta from activation: +${activatedTokensApprox - baselineTokensApprox} tokens`)

// We expect baseline to be well under what it used to be (was ~33k including
// all doctrines). Give a generous ceiling — if it ever grows past 32k tokens
// again, something regressed and a doctrine sneaked back into the base.
check(
    `Baseline orchestrator prompt stays under 32k tokens (got ~${baselineTokensApprox})`,
    baselineTokensApprox < 32_000
)

// --- summary ---------------------------------------------------------------

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
}
console.log('\nAll capability-gating smoke checks passed.')
