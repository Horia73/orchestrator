import type { AgentConfig } from './types'
import { CLI_WORKSPACE_BUILTINS } from './builtins'

/**
 * Coder agent — pure Claude Code.
 *
 * No buildPrompt and no custom tools: the orchestrator hands it a task as the
 * prompt and Claude Code drives itself end to end with its own native system
 * prompt and tooling — exactly like a normal Claude Code session. `builtins`
 * stays set so the provider passes `--allowedTools <native> --permission-mode
 * bypassPermissions` (headless runs have no human to approve tool use); it
 * does NOT inject an MCP server or an `--append-system-prompt-file`.
 *
 * Consequences: the coder does not delegate (media etc. are coordinated by the
 * orchestrator, not the coder), and it never receives our orchestrator-style
 * prompt. This matches the provider's documented Plain coder mode.
 */
export const coder: AgentConfig = {
    id: 'coder',
    name: 'Coder',
    description: 'Coding specialist — pure Claude Code; give it a precise task, it drives itself.',
    kind: 'text',
    provider: 'claude-code',
    model: 'default',
    tools: [],
    builtins: CLI_WORKSPACE_BUILTINS,
}
