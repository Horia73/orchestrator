import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import type { GeneratedMediaAsset } from '@/lib/ai/agents/types'
import { UPLOADS_DIR } from '@/lib/config'
import type { Attachment } from '@/lib/types'

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
