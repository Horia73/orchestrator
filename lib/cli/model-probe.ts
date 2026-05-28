/**
 * CLI model probe.
 *
 * Neither `claude` nor `codex` exposes a machine-readable model catalog
 * (`claude model` / `codex model list` don't exist), so "Refresh models" can't
 * list them the way it lists Google's API. What Claude Code *does* expose is
 * alias resolution: `claude --model opus` always runs the latest Opus, and the
 * stream-json `system/init` event reports the concrete model id it resolved to
 * (e.g. `claude-opus-4-8`).
 *
 * We exploit that: spawn `claude -p` per alias, read the resolved id from the
 * init event, then kill the process before it generates a full turn. The
 * result is written into the live registry keyed by the alias, so the picker
 * gains an "Opus 4.8" entry that (a) appears without a redeploy and (b)
 * auto-updates to whatever the alias resolves to on the next refresh.
 *
 * Codex has no "latest" alias mechanism (you pass explicit `gpt-5.x` ids) and
 * no list command, so it isn't probed here.
 */
import { spawn } from 'child_process'

import type { LiveModelEntry, LiveProviderEntry } from '@/lib/models/schema'
import { resolveBin, augmentedEnv } from './resolve-bin'
import { AGENT_WORKSPACE_DIR } from '@/lib/config'

const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'] as const
const PROBE_TIMEOUT_MS = 20_000

/** Pull `"model":"claude-…"` out of the stream-json the CLI emits. */
const MODEL_ID_RE = /"model"\s*:\s*"(claude[^"]+)"/

/**
 * Resolve a single Claude Code alias to its concrete model id by reading the
 * `system/init` event, then killing the process so we don't pay for a full
 * generation. Returns null when claude is missing, not logged in, or never
 * emits a model id within the timeout.
 */
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
                    // Don't load the user's MCP servers just to read a model id.
                    '--strict-mcp-config',
                    '--mcp-config', '{"mcpServers":{}}',
                ],
                {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    env: augmentedEnv(),
                    cwd: AGENT_WORKSPACE_DIR,
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
 * Turn a resolved model id into a picker-friendly display name.
 *   claude-opus-4-8            → "Opus 4.8"
 *   claude-haiku-4-5-20251001  → "Haiku 4.5"
 */
function friendlyClaudeName(id: string): string {
    const m = id.match(/^claude-([a-z0-9]+)-(\d+)-(\d+)/)
    if (!m) return id
    const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return `${tier} ${m[2]}.${m[3]}`
}

function claudeAliasEntry(alias: string, id: string): LiveModelEntry {
    return {
        name: friendlyClaudeName(id),
        kinds: ['text'],
        contextWindow: 200_000,
        maxOutputTokens: alias === 'haiku' ? 32_000 : 64_000,
        thinkingSupported: true,
        capabilities: ['text', 'function_calling'],
        rawDescription: `claude --model ${alias} → ${id}`,
        raw: { resolvedModelId: id, alias },
    }
}

/**
 * Probe Claude Code for its current alias→model resolutions. Returns a
 * LiveProviderEntry (or null when nothing resolved, e.g. claude isn't
 * installed/logged in). Probes run in parallel.
 */
export async function probeClaudeCodeModels(): Promise<LiveProviderEntry | null> {
    const resolved = await Promise.all(
        CLAUDE_ALIASES.map(async alias => [alias, await resolveClaudeAlias(alias)] as const)
    )

    const models: Record<string, LiveModelEntry> = {}
    for (const [alias, id] of resolved) {
        if (id) models[alias] = claudeAliasEntry(alias, id)
    }

    if (Object.keys(models).length === 0) return null
    return { fetchedAt: Date.now(), models }
}
