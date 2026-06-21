import type { AgentConfig } from './types'
import { CLI_WORKSPACE_BUILTINS, SKILL_TOOL_IDS, WORKSPACE_TOOL_IDS } from './builtins'
import { buildCoderPrompt } from '@/lib/ai/prompts/coder'

const CLI_CODE_PROVIDERS = new Set(['claude-code', 'codex'])

export const API_CODER_TOOL_IDS: string[] = [
    ...WORKSPACE_TOOL_IDS,
    ...SKILL_TOOL_IDS,
]

export function isCliCodeProvider(providerId: string): boolean {
    return CLI_CODE_PROVIDERS.has(providerId)
}

export function resolveRuntimeAgentConfig(target: AgentConfig, providerId: string): AgentConfig {
    if (target.runtimeRole === 'artifact_repair') return target
    if (target.id !== 'coder' || isCliCodeProvider(providerId)) return target

    return {
        ...target,
        description: 'Coding specialist — API-backed coder with Orchestrator workspace tools and workflow skills.',
        buildPrompt: buildCoderPrompt,
        tools: API_CODER_TOOL_IDS,
        builtins: CLI_WORKSPACE_BUILTINS,
        canCallAgents: [],
    }
}
