import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildArtifactAuthoring,
    buildAskUserGuidance,
    buildClockContext,
    buildRuntimeContext,
    buildSafetyCore,
    buildToolsSection,
    workspaceFileExists,
} from './shared'
import { buildOrchestratorStaticPrompt } from './orchestrator/index'
import { buildSkillsIndex } from '@/lib/skills/prompt'
import { ensureWorkspaceTemplates } from '@/lib/settings/workspace-files'

export const PROMPT_BUDGET_CHARS_PER_TOKEN = 3.5
export const PROMPT_SYSTEM_TOOL_MAX_FRACTION = 0.55

function assembleOrchestratorPrompt(ctx: PromptContext): string {

    // Order matters for prompt caching: most-stable first, most-volatile last.
    // Static policy → per-agent stable surfaces (skills index, tools menu,
    // roster) → per-conversation semi-stable state (runtime context, menus,
    // workspace files) → the per-minute clock dead last, so a turn-to-turn
    // cache miss starts at the clock instead of at runtime_context.
    const smartMonitorMode = ctx.agentId === 'smart-monitor-agent'
    const blocks = [
        buildOrchestratorStaticPrompt({
            bootActive: workspaceFileExists('BOOT.md'),
            mode: smartMonitorMode ? 'smart-monitor' : 'orchestrator',
        }),
        buildSafetyCore(),
        smartMonitorMode ? '' : buildArtifactAuthoring(),
        smartMonitorMode ? '' : buildAskUserGuidance(),
        smartMonitorMode ? '' : buildSkillsIndex(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx), // Populated from orchestrator.canCallAgents via route.ts.
        buildRuntimeContext(ctx),
        buildClockContext(),
    ].filter(Boolean)

    return blocks.join('\n\n')
}

function toolDefinitionChars(ctx: PromptContext): number {
    return JSON.stringify(ctx.availableTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
    }))).length
}

function workspaceContentChars(prompt: string): number {
    const start = prompt.lastIndexOf('<workspace_context_files>')
    if (start < 0) return 0
    const end = prompt.indexOf('</workspace_context_files>', start)
    if (end < 0) return 0
    const workspace = prompt.slice(start, end)
    let total = 0
    for (const match of workspace.matchAll(
        /--- BEGIN [^\n]+ ---\n([\s\S]*?)\n--- END [^\n]+ ---/g
    )) {
        total += match[1].length
    }
    return total
}

export function buildOrchestratorPrompt(ctx: PromptContext): string {
    // Materialize workspace templates before checking BOOT.md: on a fresh
    // install the boot script is created by this call. Idempotent and cheap
    // (existsSync checks); buildRuntimeContext calls it too, later.
    ensureWorkspaceTemplates()

    let budgetedCtx = ctx
    let prompt = assembleOrchestratorPrompt(budgetedCtx)
    const modelWindow = ctx.modelContextWindow
    if (!modelWindow || !Number.isFinite(modelWindow) || modelWindow <= 0) return prompt

    // Keep system prompt + tool schemas below a conservative share of the
    // model window. The remainder is for conversation history, attachment and
    // tool-result growth, reasoning, and the answer. We use a conservative
    // chars/token estimate because this planner must work without provider-
    // specific tokenizers in the hot request path.
    const maxSystemToolChars = Math.floor(
        modelWindow
        * PROMPT_BUDGET_CHARS_PER_TOKEN
        * PROMPT_SYSTEM_TOOL_MAX_FRACTION
    )
    const toolsChars = toolDefinitionChars(ctx)

    // Usually zero iterations for large-context models. A bounded loop handles
    // wrapper overhead disappearing as whole workspace blocks fall out.
    for (let pass = 0; pass < 3; pass++) {
        const overflow = prompt.length + toolsChars - maxSystemToolChars
        if (overflow <= 0) break
        const currentWorkspaceChars = workspaceContentChars(prompt)
        if (currentWorkspaceChars <= 0) break
        const nextWorkspaceBudget = Math.max(
            0,
            currentWorkspaceChars - overflow - 256
        )
        if (nextWorkspaceBudget === budgetedCtx.workspaceContextMaxChars) break
        budgetedCtx = { ...budgetedCtx, workspaceContextMaxChars: nextWorkspaceBudget }
        prompt = assembleOrchestratorPrompt(budgetedCtx)
    }

    return prompt
}
