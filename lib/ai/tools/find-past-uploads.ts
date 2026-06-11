import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { listAllAttachments } from '@/lib/db'
import { resolveExistingUploadPath } from '@/lib/uploads'
import { kickLibrarySync } from '@/lib/memory/library'

// ---------------------------------------------------------------------------
// find_past_uploads — locate a file the user uploaded in a PAST conversation.
//
// Chat attachments live in one global uploads dir (.orchestrator/uploads/),
// but the per-message attachment context (lib/ai/attachment-context.ts) only
// injects the files attached to the CURRENT message. So when the user says
// "the photo I sent you last week" from a fresh conversation, the agent has no
// way to see it. This tool bridges that gap: it searches every user
// conversation's attachments (via listAllAttachments) by filename, source
// conversation title, type and recency, resolves the on-disk path, and hands
// back files still present on disk. CLI-backed agents can
// open the returned path directly; sandboxed workspace tools cannot (uploads
// live outside the workspace) — those callers stage a copy with
// copy_upload_to_workspace first, or pass the upload_id to tools that take it.
//
// Intentionally simple: substring/keyword match only. There is no content,
// OCR, or visual search here (see the embeddings follow-up if that's needed).
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25

export const findPastUploadsTool: ToolDef = {
    id: 'find_past_uploads',
    name: 'find_past_uploads',
    description: [
        'Find a file the user uploaded in an EARLIER conversation (or earlier in this one).',
        'Attachments on the CURRENT message are already given to you inline — only reach for this when the user refers to a photo/PDF/file they sent before that is NOT in front of you (e.g. "the image I sent last week", "that PDF from yesterday").',
        'Matches on filename, source conversation title, type and recency only — there is no content/OCR/visual search, so a vague query may miss. With no query it returns the most recent uploads.',
        'Returns matches newest-first (only files still present on disk), each with its upload_id and on-disk `path`.',
        'Use the upload_id with tools that accept one (TranscribeAudio, delegation attachment_ids, copy_upload_to_workspace). The `path` lies OUTSIDE the agent workspace: open it directly only if you are a CLI-backed agent; the sandboxed Read cannot — call copy_upload_to_workspace to stage an editable copy instead.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Optional. Space-separated keywords; ALL must appear (case-insensitive) in the filename or source conversation title. Omit to list the most recent uploads.',
            },
            type: {
                type: 'string',
                enum: ['image', 'pdf', 'document', 'audio', 'video', 'other', 'any'],
                description: 'Optional filter by attachment kind. Default "any".',
            },
            limit: {
                type: 'integer',
                description: `Optional max results. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
            },
        },
    },
    tags: ['read', 'uploads', 'attachments'],
}

function humanSize(bytes: number): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown size'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${Math.round(kb)} KB`
    return `${(kb / 1024).toFixed(1)} MB`
}

export function executeFindPastUploads(args: Record<string, unknown>): ToolResult {
    const rawQuery = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const tokens = rawQuery ? rawQuery.split(/\s+/).filter(Boolean) : []
    const typeFilter = typeof args.type === 'string' && args.type !== 'any' ? args.type : null
    const limit = Math.max(1, Math.min(
        typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT,
        MAX_LIMIT,
    ))

    let entries: ReturnType<typeof listAllAttachments>
    try {
        entries = listAllAttachments() // already ordered newest-first
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to read uploads.' }
    }

    // The user is in "find a file I sent before" mode. This keyword lookup's
    // natural follow-up is library_search (content/visual search over the same
    // assets), so warm its multimodal index in the background now — debounced,
    // and a no-op unless a multimodal embedding model is active.
    kickLibrarySync()

    const seen = new Set<string>()
    const matches: Array<Record<string, unknown>> = []
    for (const entry of entries) {
        if (typeFilter && entry.type !== typeFilter) continue
        if (tokens.length) {
            const haystack = `${entry.filename ?? ''} ${entry.conversationTitle ?? ''}`.toLowerCase()
            if (!tokens.every(token => haystack.includes(token))) continue
        }
        if (seen.has(entry.id)) continue
        const path = resolveExistingUploadPath(entry.id)
        if (!path) continue // file was deleted / cleaned up — don't offer a dead path
        seen.add(entry.id)
        matches.push({
            filename: entry.filename,
            type: entry.type,
            size: humanSize(entry.size),
            uploaded_at: new Date(entry.messageTimestamp).toISOString(),
            conversation: entry.conversationTitle,
            upload_id: entry.id,
            path,
        })
        if (matches.length >= limit) break
    }

    if (matches.length === 0) {
        return {
            success: true,
            data: {
                count: 0,
                matches: [],
                hint: tokens.length || typeFilter
                    ? 'No uploads matched. Try fewer/different keywords or drop the type filter; otherwise ask the user for the filename or to re-attach the file.'
                    : 'No uploads found on disk.',
            },
        }
    }

    return { success: true, data: { count: matches.length, matches } }
}
