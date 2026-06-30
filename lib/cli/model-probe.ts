/**
 * Claude Code model-name probe.
 *
 * Claude Code has no model-list API, cache, or `--list-models` flag, so the
 * only way to learn what model an alias currently resolves to is to ask the
 * CLI: `claude --model opus` always runs the latest Opus, and the stream-json
 * `system/init` event reports the concrete id (e.g. `claude-opus-4-8`).
 *
 * We spawn `claude -p` per selector entry, read that id from the init event,
 * then kill the process before it generates a full turn. Callers use those
 * concrete ids to keep the picker's *existing* claude-code entries labelled
 * correctly — we do NOT invent new models here.
 */
import { spawn } from 'child_process'

import { resolveBin, augmentedEnv } from './resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export type ClaudeModelProbeKey = 'default' | 'opus[1m]' | 'sonnet' | 'sonnet[1m]' | 'haiku'
export interface ClaudeResolvedModel {
    id: string
    name: string
}

const CLAUDE_MODEL_PROBES: Array<{ key: ClaudeModelProbeKey; modelArg?: string }> = [
    { key: 'default' },
    { key: 'opus[1m]', modelArg: 'opus[1m]' },
    { key: 'sonnet', modelArg: 'sonnet' },
    { key: 'sonnet[1m]', modelArg: 'sonnet[1m]' },
    { key: 'haiku', modelArg: 'haiku' },
]
const PROBE_TIMEOUT_MS = 20_000

const MODEL_ID_RE = /"model"\s*:\s*"(claude[^"]+)"/
const KNOWN_CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku'])

/** Resolve one selector entry to its concrete model id, killing the process at init. */
function resolveClaudeModelId(modelArg?: string): Promise<string | null> {
    return new Promise(resolve => {
        const bin = resolveBin('claude')
        if (bin === 'claude') {
            resolve(null)
            return
        }

        let proc: ReturnType<typeof spawn>
        try {
            const args = [
                '-p', 'hi',
                ...(modelArg ? ['--model', modelArg] : []),
                '--output-format', 'stream-json',
                '--verbose',
                '--strict-mcp-config',
                '--mcp-config', '{"mcpServers":{}}',
            ]
            proc = spawn(
                bin,
                args,
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

        proc.stdout?.setEncoding('utf8')
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
 * Convert the concrete id reported by Claude Code into the selector label.
 *   claude-sonnet-5            → "Sonnet 5"
 *   claude-opus-4-8[1m]        → "Opus 4.8 (1M context)"
 *   claude-haiku-4-5-20251001  → "Haiku 4.5"
 */
export function claudeModelNameFromId(id: string): string | null {
    const contextSuffix = id.endsWith('[1m]') ? ' (1M context)' : ''
    const baseId = id.replace(/\[[^\]]+\]$/, '')
    if (!baseId.startsWith('claude-')) return null

    const tokens = baseId.slice('claude-'.length).split('-').filter(Boolean)
    if (tokens.length === 0) return null
    if (/^\d{8}$/.test(tokens[tokens.length - 1])) tokens.pop()
    if (tokens.length === 0) return null

    const familyIndex = tokens.findIndex(token => KNOWN_CLAUDE_FAMILIES.has(token))
    const numeric = (token: string) => /^\d+$/.test(token)
    let familyTokens: string[]
    let versionTokens: string[]

    if (familyIndex >= 0) {
        familyTokens = [tokens[familyIndex]]
        const afterFamily = tokens.slice(familyIndex + 1).filter(numeric)
        const beforeFamily = tokens.slice(0, familyIndex).filter(numeric)
        versionTokens = afterFamily.length ? afterFamily : beforeFamily
    } else {
        familyTokens = tokens.filter(token => !numeric(token))
        versionTokens = tokens.filter(numeric)
    }

    const family = familyTokens.map(titleCaseToken).join(' ')
    const version = versionTokens.join('.')
    const label = [family, version].filter(Boolean).join(' ')
    return label ? `${label}${contextSuffix}` : null
}

/**
 * Probe selector entries in parallel. Returns the resolved model per entry
 * (null when claude is missing, not logged in, or didn't answer in time).
 */
export async function probeClaudeCodeModels(): Promise<Record<ClaudeModelProbeKey, ClaudeResolvedModel | null>> {
    const entries = await Promise.all(
        CLAUDE_MODEL_PROBES.map(async probe => {
            const id = await resolveClaudeModelId(probe.modelArg)
            const name = id ? claudeModelNameFromId(id) : null
            return [probe.key, id && name ? { id, name } : null] as const
        })
    )
    return Object.fromEntries(entries) as Record<ClaudeModelProbeKey, ClaudeResolvedModel | null>
}

function titleCaseToken(token: string): string {
    return token.slice(0, 1).toUpperCase() + token.slice(1)
}
