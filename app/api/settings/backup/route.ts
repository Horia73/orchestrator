import fs from 'fs'
import { Readable } from 'stream'

import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { createBackupArchive } from '@/lib/settings/backup'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const archive = await createBackupArchive()
        const nodeStream = fs.createReadStream(archive.archivePath)
        nodeStream.on('close', archive.cleanup)
        nodeStream.on('error', archive.cleanup)

        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
        return new NextResponse(webStream, {
            headers: {
                'Cache-Control': 'no-store',
                'Content-Type': 'application/gzip',
                'Content-Length': String(archive.bytes),
                'Content-Disposition': `attachment; filename="${archive.fileName}"`,
            },
        })
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to create backup.' },
            { status: 500, headers: { 'Cache-Control': 'no-store' } }
        )
    }
}
