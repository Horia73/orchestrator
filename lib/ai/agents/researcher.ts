import type { AgentConfig } from './types'
import { buildResearcherPrompt } from '@/lib/ai/prompts/researcher'
import { CLI_WORKSPACE_BUILTINS, DELEGATING_WORKSPACE_TOOLS } from './builtins'

export const researcher: AgentConfig = {
    id: 'researcher',
    name: 'Researcher',
    description: 'Web research specialist with sourced reports.',
    kind: 'text',
    buildPrompt: buildResearcherPrompt,
    tools: DELEGATING_WORKSPACE_TOOLS,
    builtins: CLI_WORKSPACE_BUILTINS,
    // Allow self-delegation for parallel sub-research; depth cap prevents blow-up.
    canCallAgents: ['researcher'],
}
