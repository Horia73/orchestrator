import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildClockContext,
    buildRuntimeContext,
    buildSafetyCore,
    buildSubAgentCollaboration,
    buildToolsSection,
} from './shared'
import { CONCIERGE_PROMPT } from './concierge/index'

export function buildConciergePrompt(ctx: PromptContext): string {
    // Stable blocks first, per-conversation state next, the clock dead last
    // (cache-prefix friendly — see buildClockContext).
    return [
        CONCIERGE_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
        buildRuntimeContext(ctx),
        buildClockContext(),
    ].filter(Boolean).join('\n\n')
}
