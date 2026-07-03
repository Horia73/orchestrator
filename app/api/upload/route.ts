import fs from 'fs'
import crypto from 'crypto'
import type { Attachment } from '@/lib/types'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { transcodeAudioBufferToWav } from '@/lib/audio-transcode'
import {
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_TOTAL_BYTES,
    classifyUploadMime,
    resolveUploadPath,
    resolveUploadStorageType,
    validateUploadBatch,
    validateUploadFileName,
} from '@/lib/uploads'
import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { runWithRequestProfile } from "@/lib/profiles/server"

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
    if (extension === '.m4a' && (!clean || clean === 'audio/mp4' || clean === 'audio/x-m4a')) return 'audio/m4a'
    // For source/text files, trust our mapping over a browser-reported type:
    // browsers may label them text/x-python, text/javascript, etc., which model
    // APIs don't accept — normalizing to text/plain keeps them ingestible.
    if (UPLOAD_MIME_MAP[extension] === 'text/plain') return 'text/plain'
    // A browser that doesn't recognize the extension reports an empty or generic
    // octet-stream type (common for .opus, .flac, .oga, …). Trust our extension
    // map in that case so the file still classifies into the right viewer bucket
    // (audio/video/image) — it's the same map /api/uploads uses to serve it.
    const generic = !clean || clean === 'application/octet-stream'
    if (generic && UPLOAD_MIME_MAP[extension]) return UPLOAD_MIME_MAP[extension]
    return clean || UPLOAD_MIME_MAP[extension] || 'application/octet-stream'
}

function uploadOriginFromForm(formData: FormData): NonNullable<Attachment['origin']> {
    const raw = formData.get('attachmentSource') ?? formData.get('source')
    return raw === 'voice_recording' ? 'voice_recording' : 'file_upload'
}

function voiceUploadFilename(filename: string, extension: string): string {
    return filename.replace(/\.[^./\\]+$/, extension)
}

async function normalizeUploadBytes(args: {
    buffer: Buffer
    filename: string
    mimeType: string
}): Promise<{ buffer: Buffer; filename: string; extension: string; mimeType: string }> {
    // Recover a real stored type when the filename does not pin one down (no
    // extension, or one we don't know): reverse-map the browser-declared MIME,
    // else sniff the leading bytes. Without this, an extension-less audio file
    // lands as .bin / application/octet-stream and nothing downstream (player,
    // audio pre-pass, TranscribeAudio) recognizes it as audio.
    const storage = resolveUploadStorageType(args.buffer, args.mimeType, args.filename)
    const extension = storage.extension
    const mimeType = normalizeUploadMimeType(storage.mimeType, extension)
    if (mimeType !== 'audio/webm') {
        return { buffer: args.buffer, filename: args.filename, extension, mimeType }
    }

    const wav = await transcodeAudioBufferToWav(args.buffer, extension)
    return {
        buffer: wav,
        filename: voiceUploadFilename(args.filename, '.wav'),
        extension: '.wav',
        mimeType: 'audio/wav',
    }
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            fs.mkdirSync(activeRuntimePaths().uploadsDir, { recursive: true })

            const formData = await request.formData()
            const entries = formData.getAll('files')
            const files = entries.filter(isFileEntry)
            if (files.length !== entries.length) {
                return jsonResponse({ error: 'Invalid files provided' }, 400)
            }
            const origin = uploadOriginFromForm(formData)

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
                    mimeType: file.type || 'application/octet-stream',
                })

                if (MAX_UPLOAD_FILE_BYTES !== null && normalized.buffer.length > MAX_UPLOAD_FILE_BYTES) {
                    return jsonResponse(
                        { error: `${normalized.filename} exceeds the per-file limit after audio conversion.` },
                        413
                    )
                }
                storedTotalBytes += normalized.buffer.length
                if (MAX_UPLOAD_TOTAL_BYTES !== null && storedTotalBytes > MAX_UPLOAD_TOTAL_BYTES) {
                    return jsonResponse(
                        { error: 'Uploads exceed the total limit after audio conversion.' },
                        413
                    )
                }

                const id = writeUpload(normalized.buffer, normalized.extension)

                // Photo geotags feed the opt-in location journal. Best-effort
                // and fully async — the upload response never waits on EXIF.
                // Dynamic import keeps the journal graph out of this route's
                // module graph (and avoids upload<->scheduling import cycles).
                void import('@/lib/location-intelligence/photo-points').then((mod) =>
                    mod.recordPhotoJournalPoint({
                        buffer: normalized.buffer,
                        mimeType: normalized.mimeType,
                        uploadId: id,
                        filename: normalized.filename,
                    })
                )

                attachments.push({
                    id,
                    filename: normalized.filename,
                    mimeType: normalized.mimeType,
                    size: normalized.buffer.length,
                    type: classifyUploadMime(normalized.mimeType),
                    origin,
                })
            }

            return jsonResponse({ attachments })
        } catch (error) {
            console.error('Upload error:', error)
            return jsonResponse({ error: 'Upload failed' }, 500)
        }
  })
}
