import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, isInsideProtectedAgentPath, protectedAgentPathError, resolveSandboxedWritable } from './sandbox'
import { booleanArg, stringArg } from './helpers'

export const editTool: ToolDef = {
    id: 'Edit',
    name: 'Edit',
    description: 'Replaces exact text in a file inside the writable agent workspace. By default old_string must match exactly once; set replace_all to replace every occurrence.',
    input_schema: {
        type: 'object',
        properties: {
            file_path: {
                type: 'string',
                description: 'Path to edit, relative to the writable workspace root.',
            },
            old_string: {
                type: 'string',
                description: 'Exact text to find. Must be non-empty.',
            },
            new_string: {
                type: 'string',
                description: 'Replacement text.',
            },
            replace_all: {
                type: 'boolean',
                description: 'When true, replace all exact occurrences. Defaults to false.',
            },
        },
        required: ['file_path', 'old_string', 'new_string'],
    },
    tags: ['write', 'filesystem'],
}

export function executeEdit(args: Record<string, unknown>): ToolResult {
    const filePath = stringArg(args, ['file_path', 'path'])
    const oldString = args.old_string
    const newString = args.new_string
    const replaceAll = booleanArg(args, ['replace_all'])

    if (!filePath) return { success: false, error: 'Missing required parameter: file_path' }
    if (typeof oldString !== 'string' || oldString.length === 0) {
        return { success: false, error: 'Missing required non-empty string parameter: old_string' }
    }
    if (typeof newString !== 'string') return { success: false, error: 'Missing required string parameter: new_string' }

    const sandboxed = resolveSandboxedWritable(filePath)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    if (isInsideProtectedAgentPath(sandboxed.resolved)) {
        return { success: false, error: protectedAgentPathError(sandboxed.resolved) }
    }

    try {
        if (!fs.existsSync(sandboxed.resolved)) {
            return { success: false, error: `File not found: ${displayPath(sandboxed.resolved)}` }
        }
        const stat = fs.statSync(sandboxed.resolved)
        if (!stat.isFile()) return { success: false, error: `Not a file: ${displayPath(sandboxed.resolved)}` }

        const content = fs.readFileSync(sandboxed.resolved, 'utf-8')
        const occurrences = countOccurrences(content, oldString)
        if (occurrences === 0) {
            return { success: false, error: `old_string was not found in ${displayPath(sandboxed.resolved)}` }
        }
        if (!replaceAll && occurrences > 1) {
            return {
                success: false,
                error: `old_string occurs ${occurrences} times in ${displayPath(sandboxed.resolved)}. Set replace_all=true or provide a more specific old_string.`,
            }
        }

        const updated = replaceAll
            ? content.split(oldString).join(newString)
            : content.replace(oldString, newString)
        fs.writeFileSync(sandboxed.resolved, updated, 'utf-8')

        return {
            success: true,
            data: {
                path: displayPath(sandboxed.resolved),
                replacements: replaceAll ? occurrences : 1,
                bytes: Buffer.byteLength(updated, 'utf-8'),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error editing file' }
    }
}

function countOccurrences(content: string, needle: string): number {
    let count = 0
    let index = 0
    for (;;) {
        const found = content.indexOf(needle, index)
        if (found === -1) return count
        count += 1
        index = found + needle.length
    }
}
