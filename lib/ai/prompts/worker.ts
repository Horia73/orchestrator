import type { PromptContext } from '@/lib/ai/agents/types'
import { buildAgentsSection, buildClockContext, buildRuntimeContext, buildSafetyCore, buildSubAgentCollaboration, buildToolsSection } from './shared'
import { WORKER_PROMPT } from './worker/index'
import { buildSkillsIndex } from '@/lib/skills/prompt'

export function buildWorkerPrompt(ctx: PromptContext): string {
    // Stable blocks first, per-conversation state next, the clock dead last
    // (cache-prefix friendly — see buildClockContext).
    return [
        WORKER_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildSkillsIndex(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
        buildRuntimeContext(ctx),
        buildClockContext(),
    ].filter(Boolean).join('\n\n')
}
