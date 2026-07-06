/**
 * Smoke test: orchestrator system-prompt budget + lazy-block gating.
 *
 * The base prompt grew organically to ~46k tokens before the 2026-06 trim
 * (runtime_tools duplication, always-on boot/self-dev policy). This guard
 * fails the build when the zero-activation prompt creeps past the budget
 * again, and pins the gating behaviours that keep it lean:
 *   - <runtime_tools> renders no per-tool menu for native-schema providers
 *     (codex/API) — schemas already ship in the request;
 *   - <boot_protocol> is included only while BOOT.md exists;
 *   - development protocols load only via activation:
 *     self_dev for Orchestrator itself, project_dev for standalone projects;
 *   - <current_time> (per-minute volatile) is the LAST block, so provider
 *     prefix caching survives turn-to-turn.
 *
 * Runs against a throwaway ORCHESTRATOR_STATE_DIR (fresh-install workspace)
 * so machine-local memory files don't skew the measurement.
 *
 * Run: npx tsx scripts/smoke-prompt-budget.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// Fresh, empty state dir BEFORE any lib import: runtime-paths resolves
// ORCHESTRATOR_STATE_DIR at module init.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-budget-'))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

// Budget for the zero-activation prompt on a fresh install (boot active,
// scaffold-only workspace). Measured ~150k chars after the trim; headroom
// allows organic growth without re-tripping on every copy edit. If this
// fails, run scripts/inspect-orchestrator-prompt-full.ts for the breakdown
// and either trim or consciously raise the budget in the same change.
//
// 2026-07: raised 165k → 170k. The baseline had already drifted to ~167.3k on
// master (organic prompt growth, over the old ceiling before this change), and
// the `ask_user` guidance block adds a lean ~0.9k on top. Restores real
// headroom so the guard catches the NEXT creep instead of staying tripped.
const MAX_PROMPT_CHARS = 170_000

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

async function main() {
    const { orchestrator } = await import('@/lib/ai/agents/orchestrator')
    const { MAX_AGENT_DEPTH } = await import('@/lib/ai/agents/types')
    const { getToolsForAgent, getToolsForBuiltins } = await import('@/lib/ai/tools/registry')
    const { filterIntegrationToolExposure } = await import('@/lib/integrations/exposure')
    const { executeActivateIntegrationTools } = await import('@/lib/ai/tools/integrations')
    const { runWithProfileContext } = await import('@/lib/profiles/context')
    const { createProfile } = await import('@/lib/profiles/store')

    const ctx = (over: Record<string, unknown> = {}) => ({
        agentId: orchestrator.id,
        userName: 'Test',
        assistantName: 'Test',
        availableTools: [] as never[],
        availableBuiltins: orchestrator.builtins ?? [],
        availableAgents: [] as never[],
        conversationId: `budget-${randomUUID()}`,
        declaredToolIds: orchestrator.tools,
        declaredTools: getToolsForAgent(orchestrator.tools),
        delegationDepth: 0,
        maxDelegationDepth: MAX_AGENT_DEPTH,
        ...over,
    })

    // Realistic tier-1 tool surface, like app/api/chat/route.ts.
    const seen = new Set<string>()
    const exposed = filterIntegrationToolExposure(
        [...getToolsForAgent(orchestrator.tools), ...getToolsForBuiltins(orchestrator.builtins ?? [])]
            .filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true))),
        { conversationId: `budget-${randomUUID()}`, agentId: orchestrator.id }
    )

    // --- budget (fresh install: BOOT.md exists → boot protocol included) ----
    const prompt = orchestrator.buildPrompt!(ctx({ availableTools: exposed }) as never)
    check(
        `zero-activation prompt within budget (${prompt.length.toLocaleString()} <= ${MAX_PROMPT_CHARS.toLocaleString()} chars)`,
        prompt.length <= MAX_PROMPT_CHARS,
        prompt.length
    )

    // --- runtime_tools dedup (native-schema providers get no prose menu) ----
    check('no per-tool prose menu without customToolNamePrefix', !prompt.includes('- delegate_to:'))
    check('built-ins routing note still present', prompt.includes('Native provider built-ins enabled:'))

    // --- clock last (prefix-cache stability) ---------------------------------
    check('prompt ends with </current_time>', prompt.trimEnd().endsWith('</current_time>'))
    check('runtime_context carries no volatile local_time line', !/^local_time:/m.test(prompt.split('<current_time>')[0]))

    // --- boot gating ---------------------------------------------------------
    check('fresh install includes <boot_protocol> (BOOT.md scaffolded)', prompt.includes('<boot_protocol>'))
    fs.rmSync(path.join(stateDir, 'workspace', 'BOOT.md'), { force: true })
    const afterBoot = orchestrator.buildPrompt!(ctx({ availableTools: exposed }) as never)
    check('after BOOT.md removal <boot_protocol> drops out', !afterBoot.includes('<boot_protocol>'))
    check('one-line BOOT.md mention stays in context_files_protocol', afterBoot.includes('BOOT.md: temporary onboarding instructions'))

    // --- development doctrine gating -----------------------------------------
    check('development protocols NOT in zero-activation prompt',
        !afterBoot.includes('<project_workspace_policy>') &&
        !afterBoot.includes('<project_development_policy>'))
    check('<subsystems> menu lists self_dev', afterBoot.includes('self_dev'))
    check('<subsystems> menu lists project_dev', afterBoot.includes('project_dev'))
    const activatedSelfDev = orchestrator.buildPrompt!(ctx({ preactivatedCapabilities: ['self_dev'] }) as never)
    check('ActivateIntegrationTools("self_dev") loads the full protocol',
        activatedSelfDev.includes('<project_workspace_policy>') &&
        activatedSelfDev.includes('<self_update_policy>') &&
        !activatedSelfDev.includes('<project_development_policy>'))
    const activatedProjectDev = orchestrator.buildPrompt!(ctx({ preactivatedCapabilities: ['project_dev'] }) as never)
    check('ActivateIntegrationTools("project_dev") loads the full protocol',
        activatedProjectDev.includes('<project_development_policy>') &&
        activatedProjectDev.includes('project-run:prepare') &&
        activatedProjectDev.includes('PUBLISHED_BASE_PATH') &&
        activatedProjectDev.includes('publish-static') &&
        activatedProjectDev.includes('lanUrl') &&
        activatedProjectDev.includes('tailscaleFunnelUrl') &&
        !activatedProjectDev.includes('application/vnd.ant.dev-preview') &&
        !activatedProjectDev.includes('live_preview_policy') &&
        !activatedProjectDev.includes('<self_update_policy>'))

    const subsystemBlock = (value: string) =>
        value.match(/<subsystems>[\s\S]*?<\/subsystems>/)?.[0] ?? ''
    const member = createProfile({ name: 'Member Smoke', role: 'member' })
    const memberPrompt = runWithProfileContext(
        { profileId: member.id, role: 'member' },
        () => orchestrator.buildPrompt!(ctx({ availableTools: exposed }) as never)
    )
    check('member <subsystems> menu hides self_dev',
        !subsystemBlock(memberPrompt).includes('(id: self_dev)'))
    check('member <subsystems> menu still lists project_dev',
        subsystemBlock(memberPrompt).includes('(id: project_dev)'))
    const memberActivatedSelfDev = runWithProfileContext(
        { profileId: member.id, role: 'member' },
        () => orchestrator.buildPrompt!(ctx({
            availableTools: exposed,
            preactivatedCapabilities: ['self_dev'],
        }) as never)
    )
    check('member preactivation cannot load self_dev doctrine',
        !memberActivatedSelfDev.includes('<project_workspace_policy>') &&
        !memberActivatedSelfDev.includes('<self_update_policy>'))
    const memberActivatedProjectDev = runWithProfileContext(
        { profileId: member.id, role: 'member' },
        () => orchestrator.buildPrompt!(ctx({
            availableTools: exposed,
            preactivatedCapabilities: ['project_dev'],
        }) as never)
    )
    check('member preactivation can load project_dev doctrine',
        memberActivatedProjectDev.includes('<project_development_policy>') &&
        memberActivatedProjectDev.includes('project-run:prepare'))
    const memberSelfDevActivation = await runWithProfileContext(
        { profileId: member.id, role: 'member' },
        () => executeActivateIntegrationTools(
            { integrations: ['self_dev'] },
            {
                callerAgentId: 'orchestrator',
                depth: 0,
                conversationId: `member-self-dev-${randomUUID()}`,
                parentRequestId: 'smoke',
            }
        )
    )
    check('member ActivateIntegrationTools("self_dev") is skipped',
        memberSelfDevActivation.success === true &&
        Array.isArray((memberSelfDevActivation.data as { activated?: unknown[] })?.activated) &&
        (memberSelfDevActivation.data as { activated: unknown[] }).activated.length === 0 &&
        String((memberSelfDevActivation.data as { message?: unknown })?.message ?? '').includes('admin profile'))

    fs.rmSync(stateDir, { recursive: true, force: true })

    if (failures) {
        console.error(`\n${failures} check(s) failed`)
        process.exit(1)
    }
    console.log('\nAll prompt-budget checks passed')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
