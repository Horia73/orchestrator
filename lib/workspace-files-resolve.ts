import fs from 'fs'
import path from 'path'

import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'
import {
    getSandboxRoots,
    isInsideProtectedAgentPath,
    resolveSandboxed,
} from '@/lib/ai/tools/sandbox'

const WORKSPACE_MARKER = `${path.sep}.orchestrator${path.sep}workspace${path.sep}`

function isInside(parent: string, child: string): boolean {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function normalizeWorkspacePath(input: string): string {
    let raw = input.trim()
    if (raw.startsWith('file://')) {
        try {
            raw = new URL(raw).pathname
        } catch {
            // Fall through and let the sandbox resolver reject malformed input.
        }
    }

    try {
        raw = decodeURIComponent(raw)
    } catch {
        // Keep the original if it is not valid percent-encoded text.
    }

    const platformPath = raw.replace(/[\\/]+/g, path.sep)
    const markerIndex = platformPath.indexOf(WORKSPACE_MARKER)
    if (markerIndex >= 0) {
        return platformPath.slice(markerIndex + WORKSPACE_MARKER.length)
    }

    return raw
}

export function contentTypeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return UPLOAD_MIME_MAP[ext] || 'application/octet-stream'
}

export type ServableWorkspaceTarget =
    | { kind: 'file'; path: string; stat: fs.Stats }
    | { kind: 'directory'; path: string; stat: fs.Stats }

/**
 * Resolve a user/agent-supplied workspace path to a real, servable filesystem
 * target, or return null if it escapes the sandbox, points at a protected agent
 * path, or is neither a regular file nor a directory.
 */
export function resolveServableWorkspaceTarget(rawPath: string): ServableWorkspaceTarget | null {
    const requestedPath = normalizeWorkspacePath(rawPath)
    const sandboxed = resolveSandboxed(requestedPath)
    if (!sandboxed.ok) return null

    let rootReal: string
    let targetReal: string
    try {
        const root = getSandboxRoots()[0]?.absolute
        if (!root) return null
        rootReal = fs.realpathSync.native(/* turbopackIgnore: true */ root)
        targetReal = fs.realpathSync.native(/* turbopackIgnore: true */ sandboxed.resolved)
    } catch {
        return null
    }

    if (!isInside(rootReal, targetReal)) return null
    if (isInsideProtectedAgentPath(targetReal)) return null

    try {
        const stat = fs.statSync(/* turbopackIgnore: true */ targetReal)
        if (stat.isFile()) return { kind: 'file', path: targetReal, stat }
        if (stat.isDirectory()) return { kind: 'directory', path: targetReal, stat }
    } catch {
        return null
    }

    return null
}

/**
 * Resolve a user/agent-supplied workspace path to a real, servable file on disk,
 * or return null if it escapes the sandbox, points at a protected agent path, or
 * is not a regular file. Shared by the raw download route and the PPTX preview
 * route so both enforce the SAME sandbox boundary.
 */
export function resolveServableWorkspaceFile(rawPath: string): string | null {
    const target = resolveServableWorkspaceTarget(rawPath)
    return target?.kind === 'file' ? target.path : null
}
