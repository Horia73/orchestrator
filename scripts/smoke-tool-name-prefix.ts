/**
 * Smoke test: custom-tool name prefixing in the <runtime_tools> prompt block.
 *
 * Regression guard for the Smart Monitor wake failure where `set_task_state`
 * and `ReportAgentNeed` returned "No such tool available" under the
 * claude-code provider. Claude Code bridges our custom tools through a stdio
 * MCP server and only exposes them to the model as `mcp__orch-tools__<id>` —
 * never the bare id. The prompt used to advertise bare ids, so following a
 * brief that said "call set_task_state" dead-ended. The fix renders tool names
 * (and the bare→prefixed mapping) with the provider's customToolNamePrefix so
 * the advertised name always matches the callable one.
 *
 * Verifies:
 *   - claude-code exposes customToolNamePrefix === 'mcp__orch-tools__';
 *     codex / google / anthropic / lm-studio do not (they pass custom tools bare).
 *   - buildToolsSection renders custom tool names WITH the prefix and states
 *     the bare→prefixed mapping when a prefix is set.
 *   - With no prefix, the per-tool menu is omitted entirely: those providers
 *     (codex `dynamicTools`, Anthropic/OpenAI/Google/LM Studio native tool defs) already
 *     deliver every schema in the request, so a prose copy would duplicate
 *     ~6k tokens. Only the built-ins routing note renders, when present.
 *
 * Run: npx tsx scripts/smoke-tool-name-prefix.ts
 */
import { buildToolsSection } from '@/lib/ai/prompts/shared'
import type { PromptContext, ToolDef } from '@/lib/ai/agents/types'
import { getProviderCapabilities } from '@/lib/ai/providers'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

const CLAUDE_CODE_PREFIX = 'mcp__orch-tools__'

const tools: ToolDef[] = [
    {
        id: 'set_task_state',
        name: 'set_task_state',
        description: 'Persist per-wake state (watermarks, sleep knobs, digest queue).',
        input_schema: { type: 'object', properties: { state: { type: 'object' } }, required: ['state'] },
        tags: ['write'],
    },
    {
        id: 'ReportAgentNeed',
        name: 'ReportAgentNeed',
        description: 'Record a blocker for later triage.',
        input_schema: { type: 'object', properties: {} },
        tags: ['write'],
    },
]

function ctx(prefix?: string): PromptContext {
    return {
        userName: 'Test',
        assistantName: 'Test',
        availableTools: tools,
        availableBuiltins: [],
        availableAgents: [],
        customToolNamePrefix: prefix,
    }
}

// --- provider capabilities --------------------------------------------------

const cc = getProviderCapabilities('claude-code')
check(
    'claude-code exposes customToolNamePrefix === mcp__orch-tools__',
    cc?.customToolNamePrefix === CLAUDE_CODE_PREFIX,
    cc?.customToolNamePrefix
)
for (const id of ['codex', 'google', 'anthropic', 'lm-studio'] as const) {
    const caps = getProviderCapabilities(id)
    // Skip providers not registered in this environment; only assert when present.
    if (!caps) continue
    check(`${id} does NOT set customToolNamePrefix (bare names)`, !caps.customToolNamePrefix, caps.customToolNamePrefix)
}

// --- prefixed rendering (claude-code) ---------------------------------------

const prefixed = buildToolsSection(ctx(CLAUDE_CODE_PREFIX))
check('prefixed: set_task_state listed as mcp__orch-tools__set_task_state', prefixed.includes(`- ${CLAUDE_CODE_PREFIX}set_task_state:`))
check('prefixed: ReportAgentNeed listed as mcp__orch-tools__ReportAgentNeed', prefixed.includes(`- ${CLAUDE_CODE_PREFIX}ReportAgentNeed:`))
check('prefixed: no bare "- set_task_state:" list entry', !prefixed.includes('- set_task_state:'))
check(
    'prefixed: note instructs on-demand load via ToolSearch select:<prefix>',
    prefixed.includes('ToolSearch') && prefixed.includes(`select:${CLAUDE_CODE_PREFIX}`)
)

// --- bare rendering (codex / API providers) ---------------------------------
// Schemas arrive natively in the request on these providers, so the prompt
// must NOT re-list tool definitions — only the built-ins note survives.

const bare = buildToolsSection(ctx(undefined))
check('bare: no per-tool menu (schemas are native, prose copy would duplicate)', !bare.includes('- set_task_state:'))
check('bare: empty without builtins', bare === '')

const bareWithBuiltins = buildToolsSection({ ...ctx(undefined), availableBuiltins: ['web_search'] })
check('bare+builtins: built-ins note renders', bareWithBuiltins.includes('Native provider built-ins enabled:') && bareWithBuiltins.includes('web_search'))
check('bare+builtins: still no per-tool menu or ToolSearch note', !bareWithBuiltins.includes('- set_task_state:') && !bareWithBuiltins.includes('ToolSearch'))

if (failures) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
}
console.log('\nAll tool-name-prefix checks passed')
