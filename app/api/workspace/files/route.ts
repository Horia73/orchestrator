import fs from 'fs'
import path from 'path'
import { PassThrough, Readable } from 'stream'
import { NextRequest } from 'next/server'
import archiver from 'archiver'

import {
    getSandboxRoots,
    isHiddenFromDiscovery,
    isInsideHiddenDiscoveryPath,
    isInsideProtectedAgentPath,
} from '@/lib/ai/tools/sandbox'
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    contentTypeFor,
    resolveServableWorkspaceTarget,
} from '@/lib/workspace-files-resolve'

const MAX_DIRECTORY_ARCHIVE_FILES = 20_000
const MAX_DIRECTORY_ARCHIVE_BYTES = 512 * 1024 * 1024
const SKIPPED_ARCHIVE_DIRECTORIES = new Set([
    '.git',
    '.next',
    '.turbo',
    'node_modules',
])
const SKIPPED_ARCHIVE_FILES = new Set(['.DS_Store'])

interface DirectoryArchiveEntry {
    absolutePath: string
    archiveName: string
    mode: number
}

class DirectoryArchiveLimitError extends Error {
    status = 413
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

function isInside(parent: string, child: string): boolean {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function archiveRootName(dirPath: string): string {
    return (
        path.basename(dirPath)
            .replace(/[^\w .@()-]+/g, '_')
            .replace(/^\.+$/, '')
            .trim() || 'workspace-files'
    )
}

function collectDirectoryArchiveEntries(dirPath: string): DirectoryArchiveEntry[] {
    const workspaceRoot = getSandboxRoots()[0]?.absolute
    if (!workspaceRoot) return []
    const workspaceRootReal = fs.realpathSync.native(/* turbopackIgnore: true */ workspaceRoot)
    const dirReal = fs.realpathSync.native(/* turbopackIgnore: true */ dirPath)
    const entries: DirectoryArchiveEntry[] = []
    let totalBytes = 0

    function walk(currentDir: string) {
        let children: fs.Dirent[]
        try {
            children = fs.readdirSync(/* turbopackIgnore: true */ currentDir, {
                withFileTypes: true,
            })
        } catch {
            return
        }

        for (const child of children) {
            if (isHiddenFromDiscovery(child.name)) continue
            if (SKIPPED_ARCHIVE_FILES.has(child.name)) continue
            if (child.isSymbolicLink()) continue
            if (child.isDirectory() && SKIPPED_ARCHIVE_DIRECTORIES.has(child.name)) {
                continue
            }

            const absolutePath = path.join(currentDir, child.name)
            let realPath: string
            let stat: fs.Stats
            try {
                realPath = fs.realpathSync.native(/* turbopackIgnore: true */ absolutePath)
                stat = fs.statSync(/* turbopackIgnore: true */ realPath)
            } catch {
                continue
            }

            if (!isInside(workspaceRootReal, realPath)) continue
            if (!isInside(dirReal, realPath)) continue
            if (isInsideHiddenDiscoveryPath(realPath)) continue
            if (isInsideProtectedAgentPath(realPath)) continue

            if (stat.isDirectory()) {
                walk(realPath)
                continue
            }
            if (!stat.isFile()) continue

            totalBytes += stat.size
            if (
                entries.length >= MAX_DIRECTORY_ARCHIVE_FILES ||
                totalBytes > MAX_DIRECTORY_ARCHIVE_BYTES
            ) {
                throw new DirectoryArchiveLimitError(
                    'Directory is too large to download as a zip.'
                )
            }

            const archiveName = [
                archiveRootName(dirReal),
                path.relative(dirReal, realPath).split(path.sep).join('/'),
            ].join('/')
            entries.push({
                absolutePath: realPath,
                archiveName,
                mode: stat.mode,
            })
        }
    }

    walk(dirReal)
    return entries
}

function zipDirectoryResponse(dirPath: string): Response {
    let entries: DirectoryArchiveEntry[]
    try {
        entries = collectDirectoryArchiveEntries(dirPath)
    } catch (err) {
        if (err instanceof DirectoryArchiveLimitError) {
            return new Response(err.message, { status: err.status })
        }
        return new Response('Could not prepare directory archive', { status: 500 })
    }

    const output = new PassThrough()
    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.on('warning', (warning) => {
        if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') {
            output.destroy(warning)
        }
    })
    archive.on('error', (err) => output.destroy(err))
    archive.pipe(output)
    for (const entry of entries) {
        archive.file(entry.absolutePath, {
            name: entry.archiveName,
            mode: entry.mode,
        })
    }
    void archive.finalize()

    const filename = `${archiveRootName(dirPath)}.zip`
    return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': contentDisposition(filename),
            'Cache-Control': 'private, no-store',
        },
    })
}

export async function GET(request: NextRequest) {
  return runWithRequestProfile(request, async () => {
        const rawPath = request.nextUrl.searchParams.get('path')
        if (!rawPath) {
            return new Response('Missing path', { status: 400 })
        }

        const target = resolveServableWorkspaceTarget(rawPath)
        if (!target) {
            return new Response('Not found', { status: 404 })
        }

        if (target.kind === 'directory') {
            return zipDirectoryResponse(target.path)
        }

        const filePath = target.path
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
