import type { PromptContext } from '@/lib/ai/agents/types'
import { buildAgentsSection, buildRuntimeContext, buildSafetyCore, buildSubAgentCollaboration, buildToolsSection } from './shared'
import { WORKER_PROMPT } from './worker/index'
import { buildSkillsIndex } from '@/lib/skills/prompt'

export function buildWorkerPrompt(ctx: PromptContext): string {
    return [
        WORKER_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildRuntimeContext(ctx),
        buildSkillsIndex(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
    ].filter(Boolean).join('\n\n')
}
