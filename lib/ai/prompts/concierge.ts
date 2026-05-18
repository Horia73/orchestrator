import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildRuntimeContext,
    buildSafetyCore,
    buildSubAgentCollaboration,
    buildToolsSection,
} from './shared'
import { CONCIERGE_PROMPT } from './concierge/index'

export function buildConciergePrompt(ctx: PromptContext): string {
    return [
        CONCIERGE_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildRuntimeContext(ctx),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
    ].filter(Boolean).join('\n\n')
}
