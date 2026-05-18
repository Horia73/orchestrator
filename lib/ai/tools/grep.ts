import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, hiddenDiscoveryRgArgs, isHiddenFromDiscovery, isInsideHiddenDiscoveryPath, isInsideProtectedAgentPath, protectedAgentPathError, resolveSandboxed } from './sandbox'
import { clamp, isProbablyBinary, numberArg, stringArg, truncateText } from './helpers'

const DEFAULT_MAX_RESULTS = 100
const HARD_MAX_RESULTS = 1000
const MAX_OUTPUT_CHARS = 120_000

export const grepTool: ToolDef = {
    id: 'Grep',
    name: 'Grep',
    description: 'Searches file contents inside the agent workspace using ripgrep-compatible regular expressions.',
    input_schema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Regular expression or literal text to search for.',
            },
            path: {
                type: 'string',
                description: 'File or directory to search, relative to workspace root. Defaults to workspace root.',
            },
            glob: {
                type: 'string',
                description: 'Optional glob filter such as "**/*.ts".',
            },
            type: {
                type: 'string',
                description: 'Optional ripgrep file type such as "ts", "tsx", "js", "json", "md".',
            },
            output_mode: {
                type: 'string',
                enum: ['content', 'files_with_matches', 'count'],
                description: 'Return matching lines, only filenames, or match counts. Defaults to content.',
            },
            before_context: {
                type: 'integer',
                description: 'Lines of context before each match.',
            },
            after_context: {
                type: 'integer',
                description: 'Lines of context after each match.',
            },
            context: {
                type: 'integer',
                description: 'Lines of context before and after each match.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum matching lines/files/count rows. Defaults to 100, capped at 1000.',
            },
        },
        required: ['pattern'],
    },
    tags: ['read', 'filesystem', 'search'],
}

export async function executeGrep(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = stringArg(args, ['pattern'])
    if (!pattern) return { success: false, error: 'Missing required parameter: pattern' }

    const sandboxed = resolveSandboxed(stringArg(args, ['path']))
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    if (isInsideProtectedAgentPath(sandboxed.resolved)) {
        return { success: false, error: protectedAgentPathError(sandboxed.resolved) }
    }
    if (!fs.existsSync(sandboxed.resolved)) {
        return { success: false, error: `Search path not found: ${displayPath(sandboxed.resolved)}` }
    }

    const mode = normalizeMode(stringArg(args, ['output_mode']))
    const maxResults = clamp(Math.floor(numberArg(args, ['max_results'], DEFAULT_MAX_RESULTS)), 1, HARD_MAX_RESULTS)
    const context = Math.floor(numberArg(args, ['context'], 0))
    const beforeContext = clamp(Math.floor(numberArg(args, ['before_context', '-B', 'B'], context)), 0, 20)
    const afterContext = clamp(Math.floor(numberArg(args, ['after_context', '-A', 'A'], context)), 0, 20)

    const includeHiddenMetadata = isInsideHiddenDiscoveryPath(sandboxed.resolved)
    const rg = await runRg({
        root: sandboxed.resolved,
        pattern,
        glob: stringArg(args, ['glob']),
        fileType: stringArg(args, ['type']),
        mode,
        beforeContext,
        afterContext,
        maxResults,
        includeHiddenMetadata,
    })

    if (rg.ok) return { success: true, data: rg.data }
    if (rg.error) return { success: false, error: rg.error }

    try {
        const fallback = fallbackGrep({
            root: sandboxed.resolved,
            pattern,
            glob: stringArg(args, ['glob']),
            fileType: stringArg(args, ['type']),
            mode,
            beforeContext,
            afterContext,
            maxResults,
            includeHiddenMetadata,
        })
        return { success: true, data: fallback }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown grep error' }
    }
}

type GrepMode = 'content' | 'files_with_matches' | 'count'

interface GrepOptions {
    root: string
    pattern: string
    glob: string
    fileType: string
    mode: GrepMode
    beforeContext: number
    afterContext: number
    maxResults: number
    includeHiddenMetadata: boolean
}

function normalizeMode(value: string): GrepMode {
    if (value === 'files_with_matches' || value === 'count') return value
    return 'content'
}

function runRg(opts: GrepOptions): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error?: string }> {
    return new Promise(resolve => {
        const rgArgs = ['--hidden', '--color', 'never', '--glob', '!.git/**', '--glob', '!node_modules/**']
        if (!opts.includeHiddenMetadata) rgArgs.push(...hiddenDiscoveryRgArgs())
        if (opts.glob) rgArgs.push('--glob', opts.glob)
        if (opts.fileType) rgArgs.push('--type', opts.fileType)
        if (opts.mode === 'files_with_matches') rgArgs.push('--files-with-matches')
        if (opts.mode === 'count') rgArgs.push('--count-matches')
        if (opts.mode === 'content') {
            rgArgs.push('--line-number', '--column', '--no-heading')
            if (opts.beforeContext > 0) rgArgs.push('-B', String(opts.beforeContext))
            if (opts.afterContext > 0) rgArgs.push('-A', String(opts.afterContext))
        }
        rgArgs.push(opts.pattern, '.')

        const proc = spawn('rg', rgArgs, { cwd: opts.root, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        proc.stdout?.on('data', chunk => { stdout += chunk.toString() })
        proc.stderr?.on('data', chunk => { stderr += chunk.toString() })
        proc.on('error', () => resolve({ ok: false }))
        proc.on('exit', code => {
            if (code === 1) {
                resolve({
                    ok: true,
                    data: {
                        path: displayPath(opts.root),
                        pattern: opts.pattern,
                        output_mode: opts.mode,
                        content: '',
                        matches: [],
                        count: 0,
                        engine: 'rg',
                    },
                })
                return
            }
            if (code !== 0) {
                resolve({ ok: false, error: stderr.trim() || `rg exited with code ${code}` })
                return
            }

            const lines = stdout.split('\n').filter(Boolean)
            const limited = lines.slice(0, opts.maxResults)
            const truncated = lines.length > opts.maxResults
            if (opts.mode === 'files_with_matches') {
                resolve({
                    ok: true,
                    data: {
                        path: displayPath(opts.root),
                        pattern: opts.pattern,
                        output_mode: opts.mode,
                        matches: limited.map(line => displayPath(path.isAbsolute(line) ? line : path.resolve(opts.root, stripDotSlash(line)))),
                        count: limited.length,
                        truncated,
                        engine: 'rg',
                    },
                })
                return
            }

            const text = truncateText(limited.map(line => normalizeRgLine(opts.root, line)).join('\n'), MAX_OUTPUT_CHARS)
            resolve({
                ok: true,
                data: {
                    path: displayPath(opts.root),
                    pattern: opts.pattern,
                    output_mode: opts.mode,
                    content: text.text,
                    count: limited.length,
                    truncated: truncated || text.truncated,
                    engine: 'rg',
                },
            })
        })
    })
}

function stripDotSlash(line: string): string {
    return line.startsWith('./') ? line.slice(2) : line
}

function normalizeRgLine(root: string, line: string): string {
    if (path.isAbsolute(line)) return line.replace(root + path.sep, '')
    return stripDotSlash(line)
}

function fallbackGrep(opts: GrepOptions): Record<string, unknown> {
    const regex = new RegExp(opts.pattern)
    const files = collectFiles(opts.root, opts.glob, opts.fileType, opts.includeHiddenMetadata)
    const matchedFiles = new Set<string>()
    const rows: string[] = []

    for (const file of files) {
        const buffer = fs.readFileSync(file)
        if (isProbablyBinary(buffer)) continue
        const lines = buffer.toString('utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
            const match = regex.exec(lines[i])
            regex.lastIndex = 0
            if (!match) continue
            matchedFiles.add(file)
            if (opts.mode === 'files_with_matches') break
            if (opts.mode === 'count') {
                rows.push(`${displayPath(file)}:${i + 1}`)
            } else {
                const start = Math.max(0, i - opts.beforeContext)
                const end = Math.min(lines.length - 1, i + opts.afterContext)
                for (let n = start; n <= end; n++) {
                    const col = n === i ? lines[n].indexOf(match[0]) + 1 : 1
                    rows.push(`${displayPath(file)}:${n + 1}:${col}:${lines[n]}`)
                }
            }
            if (rows.length >= opts.maxResults) break
        }
        if (rows.length >= opts.maxResults) break
    }

    if (opts.mode === 'files_with_matches') {
        const matches = Array.from(matchedFiles).slice(0, opts.maxResults).map(displayPath)
        return {
            path: displayPath(opts.root),
            pattern: opts.pattern,
            output_mode: opts.mode,
            matches,
            count: matches.length,
            truncated: matchedFiles.size > opts.maxResults,
            engine: 'node-fallback',
        }
    }

    const text = truncateText(rows.slice(0, opts.maxResults).join('\n'), MAX_OUTPUT_CHARS)
    return {
        path: displayPath(opts.root),
        pattern: opts.pattern,
        output_mode: opts.mode,
        content: text.text,
        count: Math.min(rows.length, opts.maxResults),
        truncated: rows.length > opts.maxResults || text.truncated,
        engine: 'node-fallback',
    }
}

function collectFiles(root: string, glob: string, fileType: string, includeHiddenMetadata: boolean): string[] {
    const rootStat = fs.statSync(root)
    if (rootStat.isFile()) return [root]

    const globRegex = glob ? globToRegExp(glob) : null
    const exts = typeToExtensions(fileType)
    const files: string[] = []
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue
            if (!includeHiddenMetadata && isHiddenFromDiscovery(entry.name)) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile()) {
                const rel = path.relative(root, full).split(path.sep).join('/')
                if (globRegex && !globRegex.test(rel)) continue
                if (exts && !exts.includes(path.extname(full).slice(1))) continue
                files.push(full)
            }
        }
    }
    walk(root)
    return files
}

function typeToExtensions(type: string): string[] | null {
    const map: Record<string, string[]> = {
        ts: ['ts'],
        tsx: ['tsx'],
        js: ['js', 'mjs', 'cjs'],
        jsx: ['jsx'],
        json: ['json'],
        md: ['md', 'mdx'],
        css: ['css'],
        html: ['html', 'htm'],
    }
    return map[type] ?? null
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
            out += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
        }
    }
    return new RegExp(out + '$')
}
