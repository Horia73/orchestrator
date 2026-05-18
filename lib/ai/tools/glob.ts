import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, hiddenDiscoveryRgArgs, isHiddenFromDiscovery, isInsideHiddenDiscoveryPath, isInsideProtectedAgentPath, protectedAgentPathError, resolveSandboxed } from './sandbox'
import { clamp, numberArg, stringArg } from './helpers'

const DEFAULT_MAX_RESULTS = 200
const HARD_MAX_RESULTS = 1000

export const globTool: ToolDef = {
    id: 'Glob',
    name: 'Glob',
    description: 'Finds files by glob pattern inside the agent workspace. Supports patterns such as "*.ts", "**/*.tsx", and "src/**/route.ts".',
    input_schema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Glob pattern to match.',
            },
            path: {
                type: 'string',
                description: 'Directory to search, relative to workspace root. Defaults to workspace root.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum number of matches to return. Defaults to 200, capped at 1000.',
            },
        },
        required: ['pattern'],
    },
    tags: ['read', 'filesystem', 'search'],
}

export async function executeGlob(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = stringArg(args, ['pattern'])
    if (!pattern.trim()) return { success: false, error: 'Missing required parameter: pattern' }

    const sandboxed = resolveSandboxed(stringArg(args, ['path']))
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    if (isInsideProtectedAgentPath(sandboxed.resolved)) {
        return { success: false, error: protectedAgentPathError(sandboxed.resolved) }
    }
    if (!fs.existsSync(sandboxed.resolved)) {
        return { success: false, error: `Search path not found: ${displayPath(sandboxed.resolved)}` }
    }
    if (!fs.statSync(sandboxed.resolved).isDirectory()) {
        return { success: false, error: `Search path is not a directory: ${displayPath(sandboxed.resolved)}` }
    }

    const maxResults = clamp(Math.floor(numberArg(args, ['max_results'], DEFAULT_MAX_RESULTS)), 1, HARD_MAX_RESULTS)
    const includeHiddenMetadata = isInsideHiddenDiscoveryPath(sandboxed.resolved)
    const rgResult = await runRgFiles(sandboxed.resolved, pattern, maxResults, includeHiddenMetadata)
    if (rgResult.ok) {
        return {
            success: true,
            data: {
                path: displayPath(sandboxed.resolved),
                pattern,
                matches: rgResult.matches,
                count: rgResult.matches.length,
                truncated: rgResult.truncated,
                engine: 'rg',
            },
        }
    }

    const fallback = walkAndMatch(sandboxed.resolved, pattern, maxResults, includeHiddenMetadata)
    return {
        success: true,
        data: {
            path: displayPath(sandboxed.resolved),
            pattern,
            matches: fallback.matches,
            count: fallback.matches.length,
            truncated: fallback.truncated,
            engine: 'node-fallback',
        },
    }
}

function runRgFiles(root: string, pattern: string, maxResults: number, includeHiddenMetadata: boolean): Promise<{ ok: true; matches: string[]; truncated: boolean } | { ok: false }> {
    return new Promise(resolve => {
        const proc = spawn('rg', [
            '--files',
            '--hidden',
            '--glob', pattern,
            '--glob', '!.git/**',
            '--glob', '!node_modules/**',
            ...(includeHiddenMetadata ? [] : hiddenDiscoveryRgArgs()),
            '.',
        ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })

        let output = ''
        proc.stdout?.on('data', chunk => {
            output += chunk.toString()
        })
        proc.on('error', () => resolve({ ok: false }))
        proc.on('exit', code => {
            if (code !== 0 && code !== 1) {
                resolve({ ok: false })
                return
            }
            const raw = output.split('\n').map(line => line.trim()).filter(Boolean)
            const matches = raw.slice(0, maxResults).map(line => displayPath(path.isAbsolute(line) ? line : path.resolve(root, line)))
            resolve({ ok: true, matches, truncated: raw.length > maxResults })
        })
    })
}

function walkAndMatch(root: string, pattern: string, maxResults: number, includeHiddenMetadata: boolean): { matches: string[]; truncated: boolean } {
    const regex = globToRegExp(pattern)
    const matches: string[] = []
    let truncated = false

    const walk = (dir: string) => {
        if (matches.length >= maxResults) {
            truncated = true
            return
        }
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue
            if (!includeHiddenMetadata && isHiddenFromDiscovery(entry.name)) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (!entry.isFile()) continue
            const rel = path.relative(root, full).split(path.sep).join('/')
            if (regex.test(rel)) matches.push(displayPath(full))
            if (matches.length >= maxResults) {
                truncated = true
                return
            }
        }
    }

    walk(root)
    return { matches, truncated }
}

function globToRegExp(pattern: string): RegExp {
    let out = '^'
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]
        const next = pattern[i + 1]
        if (char === '*' && next === '*') {
            out += '.*'
            i += 1
        } else if (char === '*') {
            out += '[^/]*'
        } else if (char === '?') {
            out += '[^/]'
        } else {
            out += escapeRegExp(char)
        }
    }
    return new RegExp(out + '$')
}

function escapeRegExp(char: string): string {
    return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
}
