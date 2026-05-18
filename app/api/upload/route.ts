import fs from 'fs'
import crypto from 'crypto'
import type { Attachment } from '@/lib/types'
import { UPLOADS_DIR } from '@/lib/config'
import {
    classifyUploadMime,
    resolveUploadPath,
    validateUploadBatch,
    validateUploadFileName,
} from '@/lib/uploads'

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

function isFileEntry(value: FormDataEntryValue): value is File {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as File).arrayBuffer === 'function' &&
        typeof (value as File).name === 'string' &&
        typeof (value as File).size === 'number'
    )
}

function writeUpload(buffer: Buffer, extension: string): string {
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = `${crypto.randomUUID()}${extension}`
        const filePath = resolveUploadPath(id)
        if (!filePath) continue

        try {
            fs.writeFileSync(filePath, buffer, { flag: 'wx' })
            return id
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'EEXIST'
            ) {
                continue
            }
            throw error
        }
    }

    throw new Error('Failed to allocate upload filename')
}

export async function POST(request: Request) {
    try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true })

        const formData = await request.formData()
        const entries = formData.getAll('files')
        const files = entries.filter(isFileEntry)
        if (files.length !== entries.length) {
            return jsonResponse({ error: 'Invalid files provided' }, 400)
        }

        const batchCheck = validateUploadBatch(files)
        if (!batchCheck.ok) return jsonResponse({ error: batchCheck.error }, batchCheck.status)

        const attachments: Attachment[] = []

        for (const file of files) {
            const nameCheck = validateUploadFileName(file.name)
            if (!nameCheck.ok) return jsonResponse({ error: nameCheck.error }, 400)

            const buffer = Buffer.from(await file.arrayBuffer())
            const id = writeUpload(buffer, nameCheck.extension)
            const mimeType = file.type || 'application/octet-stream'

            attachments.push({
                id,
                filename: nameCheck.filename,
                mimeType,
                size: file.size,
                type: classifyUploadMime(mimeType),
            })
        }

        return jsonResponse({ attachments })
    } catch (error) {
        console.error('Upload error:', error)
        return jsonResponse({ error: 'Upload failed' }, 500)
    }
}
