import type { AgentConfig } from './types'
import { CLI_WORKSPACE_BUILTINS } from './builtins'

/**
 * Coder agent — pure CLI coding runtime.
 *
 * No buildPrompt and no custom tools: the orchestrator hands it a task as the
 * prompt and the selected CLI provider drives itself end to end with its own
 * native system prompt and tooling. Claude Code is the default provider, but
 * Settings can override this agent to Codex or another compatible CLI.
 * `builtins`
 * stays set so the provider passes `--allowedTools <native> --permission-mode
 * bypassPermissions` (headless runs have no human to approve tool use); it
 * does NOT inject an MCP server or an `--append-system-prompt-file`.
 *
 * Consequences: the coder does not delegate (media etc. are coordinated by the
 * orchestrator, not the coder), and it never receives our orchestrator-style
 * prompt. This matches the CLI providers' plain coder mode.
 *
 * API-backed coder runs are upgraded at runtime by
 * resolveRuntimeAgentConfig(): they receive Orchestrator workspace tools,
 * workflow skill tools, and a small coding prompt. Keeping the registered
 * config CLI-pure preserves Claude Code/Codex native behavior.
 */
export const coder: AgentConfig = {
    id: 'coder',
    name: 'Coder',
    description: 'Code/repo changes ONLY — writes/edits code in a repository. NOT for drafting, analysis, synthesis, docs/decks/sheets, or automations/integrations that touch no repo (those → worker). Pure CLI coder by default; API-backed runs receive Orchestrator tools and skills.',
    kind: 'text',
    provider: 'claude-code',
    model: 'default',
    tools: [],
    builtins: CLI_WORKSPACE_BUILTINS,
}
