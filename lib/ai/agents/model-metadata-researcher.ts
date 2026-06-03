import type { AgentConfig } from './types'
import { buildModelMetadataResearcherPrompt } from '@/lib/ai/prompts/model-metadata-researcher'

// ---------------------------------------------------------------------------
// Dedicated agent for AI model registry metadata research.
//
// Purpose-built for the Settings "research models" flow: it loads a slim
// system prompt and an intentionally narrow toolset (web_fetch + web_search).
// No Bash/Read/Write/Edit/Glob/Grep, no delegation, no shell — those are
// distractions for a task that is "fetch official pages, extract JSON".
// ---------------------------------------------------------------------------

export const modelMetadataResearcher: AgentConfig = {
    id: 'model-metadata-researcher',
    name: 'Model Metadata Researcher',
    description: 'Researches official AI model metadata (pricing, context, capabilities) for the registry.',
    kind: 'text',
    tier: 'system',
    buildPrompt: buildModelMetadataResearcherPrompt,
    tools: ['WebFetch'],
    builtins: ['web_fetch', 'web_search'],
    canCallAgents: [],
}
