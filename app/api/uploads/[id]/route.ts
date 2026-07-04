import fs from 'fs'
import { Readable } from 'stream'
import { NextRequest } from 'next/server'
import { resolveExistingUploadPath, uploadContentType } from '@/lib/uploads'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return serveUpload(_request, params, true)
}

export async function HEAD(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return serveUpload(_request, params, false)
}

async function serveUpload(
    request: NextRequest,
    params: Promise<{ id: string }>,
    includeBody: boolean
) {
  return runWithRequestProfile(request, async () => {
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

        // Upload ids are content-addressed-ish (UUID, written once), so
        // size+mtime is a stable validator. The ETag lets clients revalidate
        // with a cheap 304 once max-age lapses instead of refetching bytes.
        const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`

        const headers: Record<string, string> = {
            'Content-Type': uploadContentType(id),
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=86400',
            'ETag': etag,
            // Uploads can now be any file type, so never let the browser sniff a
            // served file into a more dangerous type than we declared (e.g.
            // treating uploaded markup as executable HTML).
            'X-Content-Type-Options': 'nosniff',
        }

        // Stored filenames are opaque UUIDs; callers that know the human name
        // (chat file links) pass it along so plain navigations and "Save as"
        // don't produce UUID-named downloads.
        const requestedName = new URL(request.url).searchParams.get('filename')?.trim()
        if (requestedName) {
            const safeName = requestedName.replace(/[\r\n"\\]/g, '_').slice(0, 200)
            const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_')
            headers['Content-Disposition'] =
                `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
        }

        if (request.headers.get('if-none-match') === etag) {
            return new Response(null, {
                status: 304,
                headers: {
                    'Cache-Control': headers['Cache-Control']!,
                    'ETag': etag,
                },
            })
        }

        if (!includeBody) {
            return new Response(null, { headers })
        }

        const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>
        return new Response(stream, {
            headers,
        })
  })
}
