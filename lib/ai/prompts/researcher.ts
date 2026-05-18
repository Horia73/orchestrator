import type { PromptContext } from '@/lib/ai/agents/types'
import { buildAgentsSection, buildRuntimeContext, buildSafetyCore, buildSubAgentCollaboration, buildToolsSection } from './shared'
import { RESEARCHER_PROMPT } from './researcher/index'

export function buildResearcherPrompt(ctx: PromptContext): string {
    return [
        RESEARCHER_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildRuntimeContext(ctx),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
    ].filter(Boolean).join('\n\n')
}
