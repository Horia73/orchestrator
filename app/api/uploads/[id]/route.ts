import fs from 'fs'
import { Readable } from 'stream'
import { NextRequest } from 'next/server'
import { resolveExistingUploadPath, uploadContentType } from '@/lib/uploads'

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params
    const filePath = resolveExistingUploadPath(id)
    if (!filePath) {
        return new Response('Not found', { status: 404 })
    }

    let stat: fs.Stats
    try {
        stat = fs.statSync(filePath)
        if (!stat.isFile()) return new Response('Not found', { status: 404 })
    } catch {
        return new Response('Not found', { status: 404 })
    }

    const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>

    return new Response(stream, {
        headers: {
            'Content-Type': uploadContentType(id),
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=86400',
            // Uploads can now be any file type, so never let the browser sniff a
            // served file into a more dangerous type than we declared (e.g.
            // treating uploaded markup as executable HTML).
            'X-Content-Type-Options': 'nosniff',
        },
    })
}
