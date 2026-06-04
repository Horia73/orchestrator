import type { PromptContext } from '@/lib/ai/agents/types'
import { buildAgentsSection, buildRuntimeContext, buildSafetyCore, buildSubAgentCollaboration, buildToolsSection } from './shared'
import { WORKER_PROMPT } from './worker/index'

export function buildWorkerPrompt(ctx: PromptContext): string {
    return [
        WORKER_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildRuntimeContext(ctx),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
    ].filter(Boolean).join('\n\n')
}
