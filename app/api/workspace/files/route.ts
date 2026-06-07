import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { NextRequest } from 'next/server'

import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'
import { runWithRequestProfile } from "@/lib/profiles/server"
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

function normalizeWorkspacePath(input: string): string {
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

function contentTypeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return UPLOAD_MIME_MAP[ext] || 'application/octet-stream'
}

function encodeRfc5987(value: string): string {
    return encodeURIComponent(value).replace(/['()*]/g, (ch) =>
        `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
    )
}

function contentDisposition(filename: string): string {
    const fallback = filename
        .replace(/[^\x20-\x7E]+/g, '_')
        .replace(/["\\]/g, '_')
        .trim() || 'download'
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

function resolveDownloadPath(rawPath: string): string | null {
    const requestedPath = normalizeWorkspacePath(rawPath)
    const sandboxed = resolveSandboxed(requestedPath)
    if (!sandboxed.ok) return null

    let rootReal: string
    let fileReal: string
    try {
        const root = getSandboxRoots()[0]?.absolute
        if (!root) return null
        rootReal = fs.realpathSync.native(/* turbopackIgnore: true */ root)
        fileReal = fs.realpathSync.native(/* turbopackIgnore: true */ sandboxed.resolved)
    } catch {
        return null
    }

    if (!isInside(rootReal, fileReal)) return null
    if (isInsideProtectedAgentPath(fileReal)) return null

    try {
        const stat = fs.statSync(/* turbopackIgnore: true */ fileReal)
        if (!stat.isFile()) return null
    } catch {
        return null
    }

    return fileReal
}

export async function GET(request: NextRequest) {
  return runWithRequestProfile(request, async () => {
        const rawPath = request.nextUrl.searchParams.get('path')
        if (!rawPath) {
            return new Response('Missing path', { status: 400 })
        }

        const filePath = resolveDownloadPath(rawPath)
        if (!filePath) {
            return new Response('Not found', { status: 404 })
        }

        let stat: fs.Stats
        try {
            stat = fs.statSync(/* turbopackIgnore: true */ filePath)
        } catch {
            return new Response('Not found', { status: 404 })
        }

        const stream = Readable.toWeb(fs.createReadStream(/* turbopackIgnore: true */ filePath)) as ReadableStream<Uint8Array>

        return new Response(stream, {
            headers: {
                'Content-Type': contentTypeFor(filePath),
                'Content-Length': String(stat.size),
                'Content-Disposition': contentDisposition(path.basename(filePath)),
                'Cache-Control': 'private, no-store',
            },
        })
  })
}
