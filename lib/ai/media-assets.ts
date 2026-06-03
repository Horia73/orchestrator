import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import type { GeneratedMediaAsset } from '@/lib/ai/agents/types'
import { UPLOADS_DIR } from '@/lib/config'
import type { Attachment } from '@/lib/types'
import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'

export function mimeExtension(mimeType: string): string {
    const clean = mimeType.split(';')[0].toLowerCase()
    if (clean === 'image/jpeg') return '.jpg'
    if (clean === 'image/png') return '.png'
    if (clean === 'image/webp') return '.webp'
    if (clean === 'image/gif') return '.gif'
    if (clean === 'audio/mpeg' || clean === 'audio/mp3') return '.mp3'
    if (clean === 'audio/wav' || clean === 'audio/wave') return '.wav'
    if (clean === 'audio/ogg') return '.ogg'
    if (clean === 'video/webm') return '.webm'
    if (clean === 'video/mp4') return '.mp4'
    return '.bin'
}

export function attachmentType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('video/')) return 'video'
    if (mimeType === 'application/pdf') return 'pdf'
    return 'other'
}

export function saveGeneratedAsset(data: Buffer, mimeType: string, baseName: string): GeneratedMediaAsset {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true })
    const ext = mimeExtension(mimeType)
    const id = `${randomUUID()}${ext}`
    const filePath = path.join(UPLOADS_DIR, id)
    fs.writeFileSync(filePath, data)
    const filename = `${baseName}${ext}`
    const attachment: Attachment = {
        id,
        filename,
        mimeType: mimeType.split(';')[0],
        size: data.length,
        type: attachmentType(mimeType),
    }
    return {
        attachment,
        filePath,
        url: `/api/uploads/${id}`,
    }
}

export function formatAssetSummary(label: string, assets: GeneratedMediaAsset[]): string {
    return assets
        .map((asset, index) => `${assets.length > 1 ? `${label} ${index + 1}` : label}: ${formatAssetReference(asset)}`)
        .join('\n')
}

export function formatAssetReference(asset: GeneratedMediaAsset): string {
    const label = escapeMarkdownLabel(asset.attachment.filename)
    if (asset.attachment.type === 'image' || asset.attachment.mimeType.startsWith('image/')) {
        return `![${label}](${asset.url})`
    }
    return `[${label}](${asset.url})`
}

function escapeMarkdownLabel(value: string): string {
    return value.replace(/([\\\]])/g, '\\$1')
}

const UPLOAD_REF_RE = /\/api\/uploads\/([A-Za-z0-9._%-]+)/g
const MARKDOWN_UPLOAD_REF_RE =
    /!?\[([^\]]*)\]\([^)]*?\/api\/uploads\/([A-Za-z0-9._%-]+)[^)]*\)/g

/**
 * Scan rendered assistant content for inline references to saved upload assets
 * (`/api/uploads/<id>`) and reconstruct Attachment records for any that still
 * exist on disk. Used at persist time so media an agent embeds inline as
 * markdown — e.g. a browser sub-agent screenshot re-emitted by the orchestrator,
 * whose own provider runs with attachmentMode 'none' — still becomes a
 * first-class attachment. Without this such files are invisible to the Library
 * (listAllAttachments only reads messages.attachments, and uploads/ is not a
 * LIBRARY_SOURCE_DIR) and cannot be opened in the file preview lightbox.
 *
 * Markdown labels are used as friendly filenames when present so the Library
 * shows e.g. "screenshot.png" instead of the UUID.
 */
export function extractUploadAttachmentsFromContent(content: string): Attachment[] {
    if (!content) return []

    const labels = new Map<string, string>()
    for (const match of content.matchAll(MARKDOWN_UPLOAD_REF_RE)) {
        const id = decodeURIComponent(match[2])
        const label = match[1]?.replace(/\\([\\\]])/g, '$1').trim()
        if (label && !labels.has(id)) labels.set(id, label)
    }

    const out: Attachment[] = []
    const seen = new Set<string>()
    for (const match of content.matchAll(UPLOAD_REF_RE)) {
        const id = decodeURIComponent(match[1])
        if (seen.has(id)) continue
        seen.add(id)
        let size: number
        try {
            const stat = fs.statSync(path.join(UPLOADS_DIR, id))
            if (!stat.isFile()) continue
            size = stat.size
        } catch {
            continue
        }
        const ext = path.extname(id).toLowerCase()
        const mimeType = UPLOAD_MIME_MAP[ext] ?? 'application/octet-stream'
        out.push({
            id,
            filename: labels.get(id) ?? id,
            mimeType,
            size,
            type: attachmentType(mimeType),
        })
    }
    return out
}
