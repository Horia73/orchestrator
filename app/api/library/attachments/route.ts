import { NextResponse } from 'next/server'

import { listAllAttachments, type AttachmentLibraryEntry } from '@/lib/db'

/**
 * GET /api/library/attachments?type=image|video|audio|pdf|document|other|media|files
 *
 * `media` is an alias for image + video (rendered as a single grid in the UI).
 * `files` is an alias for pdf + document + other (everything that isn't a/v).
 *
 * Returns newest-first. Filters happen server-side so the response is small
 * even for power users with thousands of chats — no need to pull all
 * attachments to the client and filter there.
 */
const MEDIA_TYPES = new Set<AttachmentLibraryEntry['type']>(['image', 'video'])
const FILE_TYPES = new Set<AttachmentLibraryEntry['type']>(['pdf', 'document', 'other'])

export async function GET(request: Request) {
    const url = new URL(request.url)
    const typeParam = url.searchParams.get('type')

    const all = listAllAttachments()
    let filtered: AttachmentLibraryEntry[] = all
    if (typeParam === 'media') {
        filtered = all.filter((a) => MEDIA_TYPES.has(a.type))
    } else if (typeParam === 'files') {
        filtered = all.filter((a) => FILE_TYPES.has(a.type))
    } else if (typeParam === 'audio') {
        filtered = all.filter((a) => a.type === 'audio')
    } else if (typeParam && ['image', 'video', 'pdf', 'document', 'other'].includes(typeParam)) {
        filtered = all.filter((a) => a.type === typeParam)
    }

    return NextResponse.json({
        attachments: filtered,
        total: filtered.length,
    })
}
