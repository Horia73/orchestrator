import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { NextRequest } from 'next/server'

import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    contentTypeFor,
    resolveServableWorkspaceFile,
} from '@/lib/workspace-files-resolve'

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

export async function GET(request: NextRequest) {
  return runWithRequestProfile(request, async () => {
        const rawPath = request.nextUrl.searchParams.get('path')
        if (!rawPath) {
            return new Response('Missing path', { status: 400 })
        }

        const filePath = resolveServableWorkspaceFile(rawPath)
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
