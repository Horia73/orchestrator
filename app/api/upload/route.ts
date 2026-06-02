import fs from 'fs'
import crypto from 'crypto'
import type { Attachment } from '@/lib/types'
import { UPLOADS_DIR } from '@/lib/config'
import { transcodeAudioBufferToWav } from '@/lib/audio-transcode'
import {
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_TOTAL_BYTES,
    classifyUploadMime,
    resolveUploadPath,
    validateUploadBatch,
    validateUploadFileName,
} from '@/lib/uploads'
import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'

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

function baseMime(mimeType: string): string {
    return (mimeType || '').split(';')[0].trim().toLowerCase()
}

function normalizeUploadMimeType(mimeType: string, extension: string): string {
    const clean = baseMime(mimeType)
    if (extension === '.m4a' && (!clean || clean === 'audio/mp4')) return 'audio/m4a'
    return clean || UPLOAD_MIME_MAP[extension] || 'application/octet-stream'
}

function voiceUploadFilename(filename: string, extension: string): string {
    return filename.replace(/\.[^./\\]+$/, extension)
}

async function normalizeUploadBytes(args: {
    buffer: Buffer
    filename: string
    extension: string
    mimeType: string
}): Promise<{ buffer: Buffer; filename: string; extension: string; mimeType: string }> {
    const mimeType = normalizeUploadMimeType(args.mimeType, args.extension)
    if (mimeType !== 'audio/webm') {
        return { ...args, mimeType }
    }

    const wav = await transcodeAudioBufferToWav(args.buffer, args.extension)
    return {
        buffer: wav,
        filename: voiceUploadFilename(args.filename, '.wav'),
        extension: '.wav',
        mimeType: 'audio/wav',
    }
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
        let storedTotalBytes = 0

        for (const file of files) {
            const nameCheck = validateUploadFileName(file.name)
            if (!nameCheck.ok) return jsonResponse({ error: nameCheck.error }, 400)

            const buffer = Buffer.from(await file.arrayBuffer())
            const normalized = await normalizeUploadBytes({
                buffer,
                filename: nameCheck.filename,
                extension: nameCheck.extension,
                mimeType: file.type || 'application/octet-stream',
            })

            if (normalized.buffer.length > MAX_UPLOAD_FILE_BYTES) {
                return jsonResponse(
                    { error: `${normalized.filename} exceeds the per-file limit after audio conversion.` },
                    413
                )
            }
            storedTotalBytes += normalized.buffer.length
            if (storedTotalBytes > MAX_UPLOAD_TOTAL_BYTES) {
                return jsonResponse(
                    { error: 'Uploads exceed the total limit after audio conversion.' },
                    413
                )
            }

            const id = writeUpload(normalized.buffer, normalized.extension)

            attachments.push({
                id,
                filename: normalized.filename,
                mimeType: normalized.mimeType,
                size: normalized.buffer.length,
                type: classifyUploadMime(normalized.mimeType),
            })
        }

        return jsonResponse({ attachments })
    } catch (error) {
        console.error('Upload error:', error)
        return jsonResponse({ error: 'Upload failed' }, 500)
    }
}
