import fs from 'fs'
import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { resolveSandboxed, displayPath, isInsideProtectedAgentPath, protectedAgentPathError } from './sandbox'

/** Max characters to return to avoid blowing up context */
const MAX_CHARS = 100_000

export const readFileTool: ToolDef = {
    id: 'read_file',
    name: 'read_file',
    description: 'Reads the contents of a file inside the agent workspace and returns it as text. Can optionally read a specific line range. Paths are resolved relative to the workspace root ("/"); absolute paths outside the workspace are rejected.',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to the workspace root (e.g. "notes/todo.md").',
            },
            offset: {
                type: 'integer',
                description: 'The line number to start reading from (1-based). If not provided, reads from the beginning.',
            },
            limit: {
                type: 'integer',
                description: 'The number of lines to read. If not provided, reads the entire file (up to a size limit).',
            },
        },
        required: ['path'],
    },
    tags: ['read', 'filesystem'],
}

export function executeReadFile(args: Record<string, unknown>): ToolResult {
    const filePath = args.path as string
    if (!filePath) {
        return { success: false, error: 'Missing required parameter: path' }
    }

    const sandboxed = resolveSandboxed(filePath)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    const resolved = sandboxed.resolved
    if (isInsideProtectedAgentPath(resolved)) {
        return { success: false, error: protectedAgentPathError(resolved) }
    }

    try {
        if (!fs.existsSync(resolved)) {
            return { success: false, error: `File not found: ${displayPath(resolved)}` }
        }

        const stat = fs.statSync(resolved)
        if (!stat.isFile()) {
            return { success: false, error: `Not a file: ${displayPath(resolved)}` }
        }

        const raw = fs.readFileSync(resolved, 'utf-8')
        const allLines = raw.split('\n')

        const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1
        const limit = typeof args.limit === 'number' ? args.limit : allLines.length

        const startIdx = offset - 1
        const selectedLines = allLines.slice(startIdx, startIdx + limit)

        // Add line numbers (like cat -n)
        const numbered = selectedLines.map((line, i) => {
            const lineNum = startIdx + i + 1
            return `${String(lineNum).padStart(6)}  ${line}`
        })

        let content = numbered.join('\n')
        let truncated = false
        if (content.length > MAX_CHARS) {
            content = content.slice(0, MAX_CHARS)
            truncated = true
        }

        return {
            success: true,
            data: {
                path: displayPath(resolved),
                content,
                totalLines: allLines.length,
                linesReturned: selectedLines.length,
                startLine: offset,
                ...(truncated ? { truncated: true } : {}),
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error reading file',
        }
    }
}
