/**
 * Claude Code model-name probe.
 *
 * Claude Code has no model-list API, cache, or `--list-models` flag, so we
 * combine two CLI surfaces to keep the picker in sync without hardcoding
 * model families:
 *
 *   - `claude --help` documents the current `--model` aliases (e.g. "Provide
 *     an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')").
 *     Anthropic keeps that example list current for headline models, which
 *     makes it a discovery surface for families we have never seen.
 *   - `claude -p --model <alias>` reports the concrete id the alias resolves
 *     to in the stream-json `system/init` event (e.g. `claude-fable-5`). We
 *     kill the process at init, before it generates a full turn.
 *
 * The CLI passes an unknown `--model` value through verbatim (init still
 * fires, echoing the raw string), so "resolved to a different, claude-prefixed
 * id" is the validation signal that an alias is real. `[1m]` suffixes are NOT
 * validated by the CLI (any alias accepts one), so we never invent [1m]
 * variants here — we only re-resolve aliases the caller already knows about.
 */
import { spawn } from 'child_process'

import { resolveBin, augmentedEnv } from './resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export interface ClaudeResolvedModel {
    id: string
    name: string
}

const PROBE_TIMEOUT_MS = 20_000
const PROBE_CONCURRENCY = 5
const HELP_TIMEOUT_MS = 10_000

const MODEL_ID_RE = /"model"\s*:\s*"(claude[^"]+)"/
const KNOWN_CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable'])

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
 * Pull the candidate `--model` aliases out of `claude --help` output. Pure so
 * the smoke test can pin the parse against a captured help snippet.
 */
export function parseClaudeModelAliasesFromHelp(helpText: string): string[] {
    const lines = helpText.split('\n')
    const start = lines.findIndex(line => /^\s*--model\b/.test(line))
    if (start === -1) return []

    const block: string[] = [lines[start]]
    for (let i = start + 1; i < lines.length; i++) {
        // The next option flag (or a section header) ends the description block;
        // wrapped description lines are indented far past the option column.
        if (/^\s{0,8}(-{1,2}[a-zA-Z]|[A-Z][A-Za-z ]+:)/.test(lines[i])) break
        block.push(lines[i])
    }

    const aliases = new Set<string>()
    for (const m of block.join(' ').matchAll(/'([^']+)'/g)) {
        const token = m[1].trim().toLowerCase()
        // Quoted full ids ("claude-fable-5") are examples of the other input
        // form the flag takes — aliases are short family names.
        if (!/^[a-z][a-z0-9.-]*$/.test(token)) continue
        if (token.startsWith('claude-')) continue
        aliases.add(token)
    }
    return [...aliases]
}

/** Ask the installed CLI which model aliases it currently documents. */
export async function discoverClaudeModelAliases(): Promise<string[]> {
    const bin = resolveBin('claude')
    if (bin === 'claude') return []

    const helpText = await new Promise<string>(resolve => {
        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn(bin, ['--help'], {
                stdio: ['ignore', 'pipe', 'ignore'],
                env: augmentedEnv(),
                cwd: activeRuntimePaths().agentWorkspaceDir,
            })
        } catch {
            resolve('')
            return
        }
        let settled = false
        let buf = ''
        const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { proc.kill('SIGKILL') } catch { /* gone */ }
            resolve(buf)
        }
        const timer = setTimeout(finish, HELP_TIMEOUT_MS)
        proc.stdout?.setEncoding('utf8')
        proc.stdout?.on('data', chunk => { buf += chunk.toString() })
        proc.on('error', finish)
        proc.on('exit', finish)
    })

    return parseClaudeModelAliasesFromHelp(helpText)
}

/**
 * Convert the concrete id reported by Claude Code into the selector label.
 *   claude-sonnet-5            → "Sonnet 5"
 *   claude-fable-5             → "Fable 5"
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
 * Probe the CLI's documented aliases (plus any caller-supplied ones — the
 * registry's existing claude-code entries) in bounded batches. Returns the
 * resolved model per alias, keyed by alias with `'default'` for the
 * no---model probe (null when claude is missing, not logged in, the alias
 * didn't resolve, or the CLI didn't answer in time).
 */
export async function probeClaudeCodeModels(extraAliases: string[] = []): Promise<Record<string, ClaudeResolvedModel | null>> {
    const discovered = await discoverClaudeModelAliases()
    const aliases = [...new Set(['default', ...discovered, ...extraAliases.map(alias => alias.toLowerCase())])]

    const out: Record<string, ClaudeResolvedModel | null> = {}
    for (let i = 0; i < aliases.length; i += PROBE_CONCURRENCY) {
        const batch = aliases.slice(i, i + PROBE_CONCURRENCY)
        await Promise.all(batch.map(async alias => {
            const id = await resolveClaudeModelId(alias === 'default' ? undefined : alias)
            // An unknown alias is echoed back verbatim by the init event — only
            // a real alias resolves to a different, claude-prefixed concrete id.
            const resolved = id && id !== alias ? id : null
            const name = resolved ? claudeModelNameFromId(resolved) : null
            out[alias] = resolved && name ? { id: resolved, name } : null
        }))
    }
    return out
}

function titleCaseToken(token: string): string {
    return token.slice(0, 1).toUpperCase() + token.slice(1)
}
