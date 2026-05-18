import fs from 'fs'
import path from 'path'
import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { resolveSandboxed, displayPath, isHiddenFromDiscovery } from './sandbox'

export const listDirTool: ToolDef = {
    id: 'list_dir',
    name: 'list_dir',
    description: 'Lists the contents of a directory inside the agent workspace. Returns file and subdirectory names with their types and sizes. Paths are resolved relative to the workspace root ("/"); absolute paths outside the workspace are rejected.',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to the workspace root (e.g. "." for the root or "notes/" for a subdir). Defaults to the workspace root.',
            },
        },
    },
    tags: ['read', 'filesystem'],
}

export function executeListDir(args: Record<string, unknown>): ToolResult {
    const sandboxed = resolveSandboxed(args.path as string | undefined)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    const resolved = sandboxed.resolved

    try {
        if (!fs.existsSync(resolved)) {
            return { success: false, error: `Directory not found: ${displayPath(resolved)}` }
        }

        const stat = fs.statSync(resolved)
        if (!stat.isDirectory()) {
            return { success: false, error: `Not a directory: ${displayPath(resolved)}` }
        }

        const entries = fs
            .readdirSync(resolved, { withFileTypes: true })
            .filter(entry => !isHiddenFromDiscovery(entry.name))
        const items: Array<{ name: string; type: 'directory' | 'file'; size?: number }> =
            entries.map(entry => {
                const entryPath = path.join(resolved, entry.name)
                let size: number | undefined
                try {
                    if (entry.isFile()) {
                        size = fs.statSync(entryPath).size
                    }
                } catch { /* skip stats errors */ }

                return {
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    ...(size !== undefined ? { size } : {}),
                }
            })

        return {
            success: true,
            data: {
                path: displayPath(resolved),
                entries: items,
                count: items.length,
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error listing directory',
        }
    }
}
