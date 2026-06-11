import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildArtifactAuthoring,
    buildClockContext,
    buildRuntimeContext,
    buildSafetyCore,
    buildToolsSection,
    workspaceFileExists,
} from './shared'
import { buildOrchestratorStaticPrompt } from './orchestrator/index'
import { buildSkillsIndex } from '@/lib/skills/prompt'
import { ensureWorkspaceTemplates } from '@/lib/settings/workspace-files'

export function buildOrchestratorPrompt(ctx: PromptContext): string {
    // Materialize workspace templates before checking BOOT.md: on a fresh
    // install the boot script is created by this call. Idempotent and cheap
    // (existsSync checks); buildRuntimeContext calls it too, later.
    ensureWorkspaceTemplates()

    // Order matters for prompt caching: most-stable first, most-volatile last.
    // Static policy → per-agent stable surfaces (skills index, tools menu,
    // roster) → per-conversation semi-stable state (runtime context, menus,
    // workspace files) → the per-minute clock dead last, so a turn-to-turn
    // cache miss starts at the clock instead of at runtime_context.
    const blocks = [
        buildOrchestratorStaticPrompt({ bootActive: workspaceFileExists('BOOT.md') }),
        buildSafetyCore(),
        buildArtifactAuthoring(),
        buildSkillsIndex(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx), // Populated from orchestrator.canCallAgents via route.ts.
        buildRuntimeContext(ctx),
        buildClockContext(),
    ].filter(Boolean)

    return blocks.join('\n\n')
}
