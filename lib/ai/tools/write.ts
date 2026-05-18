import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, isInsideProtectedAgentPath, protectedAgentPathError, resolveSandboxedWritable } from './sandbox'
import { ensureParentDir, stringArg } from './helpers'

export const writeTool: ToolDef = {
    id: 'Write',
    name: 'Write',
    description: 'Creates or overwrites a text file inside the writable agent workspace.',
    input_schema: {
        type: 'object',
        properties: {
            file_path: {
                type: 'string',
                description: 'Path to write, relative to the writable workspace root.',
            },
            content: {
                type: 'string',
                description: 'Complete file content to write.',
            },
        },
        required: ['file_path', 'content'],
    },
    tags: ['write', 'filesystem'],
}

export function executeWrite(args: Record<string, unknown>): ToolResult {
    const filePath = stringArg(args, ['file_path', 'path'])
    const content = args.content
    if (!filePath) return { success: false, error: 'Missing required parameter: file_path' }
    if (typeof content !== 'string') return { success: false, error: 'Missing required string parameter: content' }

    const sandboxed = resolveSandboxedWritable(filePath)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    if (isInsideProtectedAgentPath(sandboxed.resolved)) {
        return { success: false, error: protectedAgentPathError(sandboxed.resolved) }
    }

    try {
        ensureParentDir(sandboxed.resolved)
        fs.writeFileSync(sandboxed.resolved, content, 'utf-8')
        return {
            success: true,
            data: {
                path: displayPath(sandboxed.resolved),
                bytes: Buffer.byteLength(content, 'utf-8'),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error writing file' }
    }
}
