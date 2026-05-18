import type { PromptContext } from '@/lib/ai/agents/types'
import {
    buildAgentsSection,
    buildRuntimeContext,
    buildSafetyCore,
    buildSubAgentCollaboration,
    buildToolsSection,
} from './shared'
import { MULTIPURPOSE_PROMPT } from './multipurpose/index'

export function buildMultipurposePrompt(ctx: PromptContext): string {
    return [
        MULTIPURPOSE_PROMPT,
        buildSafetyCore(),
        buildSubAgentCollaboration(),
        buildRuntimeContext(ctx),
        buildToolsSection(ctx),
        buildAgentsSection(ctx),
    ].filter(Boolean).join('\n\n')
}
