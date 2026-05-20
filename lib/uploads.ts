import fs from 'fs'
import path from 'path'
import type { Attachment } from '@/lib/types'
import { UPLOADS_DIR } from '@/lib/config'
import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'

export { UPLOAD_MIME_MAP } from '@/lib/upload-mime'

export const MAX_UPLOAD_FILES = 10
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9][a-z0-9-]{0,15}$/i
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR)

const SAFE_UPLOAD_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.heic',
    '.heif',
    '.pdf',
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.xml',
    '.log',
    '.rtf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.mp3',
    '.wav',
    '.m4a',
    '.aac',
    '.aiff',
    '.flac',
    '.ogg',
    '.mp4',
    '.webm',
    '.mov',
    '.mpeg',
    '.mpg',
    '.avi',
    '.wmv',
    '.3gp',
])

export interface UploadFileLike {
    name: string
    size: number
}

export type UploadFileNameValidation =
    | { ok: true; filename: string; extension: string }
    | { ok: false; error: string }

function formatBytes(bytes: number): string {
    const mb = bytes / (1024 * 1024)
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

function isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function classifyUploadMime(mime: string): Attachment['type'] {
    if (mime.startsWith('image/')) return 'image'
    if (mime === 'application/pdf') return 'pdf'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('csv')) return 'document'
    return 'other'
}

export function validateUploadFileName(name: string): UploadFileNameValidation {
    if (typeof name !== 'string') return { ok: false, error: 'Invalid file name' }
    if (name.includes('\0')) return { ok: false, error: 'File name contains a NUL byte' }

    const filename = name.trim()
    if (!filename || filename === '.' || filename === '..') {
        return { ok: false, error: 'Invalid file name' }
    }
    if (/[\x00-\x1f\x7f]/.test(filename)) {
        return { ok: false, error: 'File name contains control characters' }
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes(':')) {
        return { ok: false, error: 'File name must not contain path separators' }
    }
    if (path.basename(filename) !== filename || path.win32.basename(filename) !== filename) {
        return { ok: false, error: 'File name must not contain path components' }
    }
    if (Buffer.byteLength(filename, 'utf8') > 255) {
        return { ok: false, error: 'File name is too long' }
    }

    const extension = path.extname(filename).toLowerCase()
    if (!extension || !SAFE_UPLOAD_EXTENSIONS.has(extension)) {
        return { ok: false, error: `Unsupported or unsafe file extension: ${extension || '(none)'}` }
    }

    return { ok: true, filename, extension }
}

export function validateUploadBatch(files: UploadFileLike[]): { ok: true } | { ok: false; status: number; error: string } {
    if (!files.length) return { ok: false, status: 400, error: 'No files provided' }
    if (files.length > MAX_UPLOAD_FILES) {
        return { ok: false, status: 413, error: `Too many files. Maximum is ${MAX_UPLOAD_FILES}.` }
    }

    let totalSize = 0
    for (const file of files) {
        const nameCheck = validateUploadFileName(file.name)
        if (!nameCheck.ok) return { ok: false, status: 400, error: nameCheck.error }

        if (!Number.isFinite(file.size) || file.size < 0) {
            return { ok: false, status: 400, error: `Invalid file size for ${nameCheck.filename}` }
        }
        if (file.size > MAX_UPLOAD_FILE_BYTES) {
            return {
                ok: false,
                status: 413,
                error: `${nameCheck.filename} exceeds the per-file limit of ${formatBytes(MAX_UPLOAD_FILE_BYTES)}.`,
            }
        }

        totalSize += file.size
        if (totalSize > MAX_UPLOAD_TOTAL_BYTES) {
            return {
                ok: false,
                status: 413,
                error: `Uploads exceed the total limit of ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}.`,
            }
        }
    }

    return { ok: true }
}

export function isSafeUploadId(id: string): boolean {
    return typeof id === 'string' && UPLOAD_ID_RE.test(id)
}

export function resolveUploadPath(id: string): string | null {
    if (!isSafeUploadId(id)) return null

    const filePath = path.resolve(UPLOADS_ROOT, id)
    if (!isPathInside(UPLOADS_ROOT, filePath)) return null
    return filePath
}

export function resolveExistingUploadPath(id: string): string | null {
    const filePath = resolveUploadPath(id)
    if (!filePath) return null

    try {
        const linkStat = fs.lstatSync(filePath)
        if (!linkStat.isFile()) return null

        const rootReal = fs.realpathSync.native(UPLOADS_ROOT)
        const fileReal = fs.realpathSync.native(filePath)
        if (!isPathInside(rootReal, fileReal)) return null
        return fileReal
    } catch {
        return null
    }
}

export function uploadContentType(id: string): string {
    const ext = path.extname(id).toLowerCase()
    return UPLOAD_MIME_MAP[ext] || 'application/octet-stream'
}
