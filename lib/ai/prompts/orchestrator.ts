import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildArtifactAuthoring,
    buildRuntimeContext,
    buildSafetyCore,
    buildToolsSection,
} from './shared'
import { ORCHESTRATOR_PROMPT } from './orchestrator/index'
import { buildSkillsIndex } from '@/lib/skills/prompt'

export function buildOrchestratorPrompt(ctx: PromptContext): string {
    // Order matters for prompt caching: static blocks first (core, safety,
    // authoring guides), volatile last (runtime context, tools, roster).
    const blocks = [
        ORCHESTRATOR_PROMPT,
        buildSafetyCore(),
        buildArtifactAuthoring(),
        buildRuntimeContext(ctx),
        buildSkillsIndex(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx), // Populated from orchestrator.canCallAgents via route.ts.
    ].filter(Boolean)

    return blocks.join('\n\n')
}
