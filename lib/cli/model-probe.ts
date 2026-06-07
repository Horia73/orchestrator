/**
 * Claude Code model-version probe.
 *
 * Claude Code has no model-list API, cache, or `--list-models` flag, so the
 * only way to learn what version an alias currently resolves to is to ask the
 * CLI: `claude --model opus` always runs the latest Opus, and the stream-json
 * `system/init` event reports the concrete id (e.g. `claude-opus-4-8`).
 *
 * We spawn `claude -p` per alias, read that id from the init event, then kill
 * the process before it generates a full turn. Callers use the versions to
 * keep the picker's *existing* claude-code entries labelled correctly — we do
 * NOT invent new models here.
 */
import { spawn } from 'child_process'

import { resolveBin, augmentedEnv } from './resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export type ClaudeAlias = 'opus' | 'sonnet' | 'haiku'
const CLAUDE_ALIASES: ClaudeAlias[] = ['opus', 'sonnet', 'haiku']
const PROBE_TIMEOUT_MS = 20_000

const MODEL_ID_RE = /"model"\s*:\s*"(claude[^"]+)"/

/** Resolve one alias to its concrete model id, killing the process at init. */
function resolveClaudeAlias(alias: string): Promise<string | null> {
    return new Promise(resolve => {
        const bin = resolveBin('claude')
        if (bin === 'claude') {
            resolve(null)
            return
        }

        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn(
                bin,
                [
                    '-p', 'hi',
                    '--model', alias,
                    '--output-format', 'stream-json',
                    '--verbose',
                    '--strict-mcp-config',
                    '--mcp-config', '{"mcpServers":{}}',
                ],
                {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    env: augmentedEnv(),
                    cwd: activeRuntimePaths().agentWorkspaceDir,
                }
            )
        } catch {
            resolve(null)
            return
        }

        let settled = false
        let buf = ''
        const finish = (value: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { proc.kill('SIGKILL') } catch { /* gone */ }
            resolve(value)
        }
        const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS)

        proc.stdout?.on('data', chunk => {
            buf += chunk.toString()
            const m = buf.match(MODEL_ID_RE)
            if (m) finish(m[1])
        })
        proc.on('error', () => finish(null))
        proc.on('exit', () => finish(buf.match(MODEL_ID_RE)?.[1] ?? null))
    })
}

/**
 * Extract the marketing version from a resolved id.
 *   claude-opus-4-8            → "4.8"
 *   claude-haiku-4-5-20251001  → "4.5"
 */
export function claudeVersionFromId(id: string): string | null {
    const m = id.match(/^claude-[a-z0-9]+-(\d+)-(\d+)/)
    return m ? `${m[1]}.${m[2]}` : null
}

/**
 * Probe opus/sonnet/haiku in parallel. Returns the resolved version per alias
 * (null when claude is missing, not logged in, or didn't answer in time).
 */
export async function probeClaudeAliasVersions(): Promise<Record<ClaudeAlias, string | null>> {
    const entries = await Promise.all(
        CLAUDE_ALIASES.map(async alias => {
            const id = await resolveClaudeAlias(alias)
            return [alias, id ? claudeVersionFromId(id) : null] as const
        })
    )
    return Object.fromEntries(entries) as Record<ClaudeAlias, string | null>
}
