import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { listAllAttachments } from '@/lib/db'
import { sniffContentType } from '@/lib/file-sniff'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { resolveExistingUploadPath, uploadContentType } from '@/lib/uploads'
import { ensureParentDir, stringArg } from './helpers'
import {
    displayPath,
    isInsideProtectedAgentPath,
    protectedAgentPathError,
    resolveSandboxedWritable,
} from './sandbox'

// ---------------------------------------------------------------------------
// copy_upload_to_workspace — stage an uploaded chat attachment inside the
// agent workspace.
//
// Uploads live in the global uploads dir (.orchestrator/uploads/), OUTSIDE the
// agent sandbox: the workspace Read/Write/Edit/Bash tools cannot touch them,
// and the upload file itself must never be modified in place (it backs the
// chat attachment and its previews). This tool copies the bytes into the
// workspace so the agent can edit, convert, resize, or extract from them —
// e.g. ffmpeg a voice note to mp3 and hand the result to TranscribeAudio.
//
// The copy also self-heals the file extension: legacy uploads stored as .bin
// (no usable extension at upload time) get a sniffed extension on the copy so
// command-line tools recognize the format.
// ---------------------------------------------------------------------------

const DEFAULT_DEST_DIR = 'tmp'
const SNIFF_HEAD_BYTES = 8192
const MAX_DEDUPE_ATTEMPTS = 50
const BARE_UPLOAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const copyUploadToWorkspaceTool: ToolDef = {
    id: 'copy_upload_to_workspace',
    name: 'copy_upload_to_workspace',
    description: [
        'Copy an uploaded chat attachment into the agent workspace so you can work on its bytes.',
        'Uploads live OUTSIDE the workspace sandbox — Read/Write/Edit/Bash cannot reach them, and the original upload must never be edited in place. Call this FIRST whenever you need to edit, convert, resize, extract from, or run commands against an uploaded file of any type (audio, video, image, PDF, Office, archive, …).',
        'Pass the upload_id from the current message or find_past_uploads. The copy lands at dest_path (default tmp/<filename>) with a corrected file extension when the original name was missing or wrong; the original upload stays untouched.',
        'The returned `path` is workspace-relative and can be used directly with Bash/Read/Write/Edit. `display_path` is only the UI-style display form.',
        'Files under tmp/ stay out of the Library; put a finished deliverable under files/ if the user should see it there.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            upload_id: {
                type: 'string',
                description: 'Upload id of the attachment to copy (from the current message or find_past_uploads).',
            },
            dest_path: {
                type: 'string',
                description: `Optional workspace-relative destination (e.g. "${DEFAULT_DEST_DIR}/voice.ogg", "files/report.pdf"). Default: ${DEFAULT_DEST_DIR}/<original filename>. If the path already exists, a numeric suffix is appended.`,
            },
        },
        required: ['upload_id'],
    },
    tags: ['uploads', 'filesystem', 'write'],
}

export function executeCopyUploadToWorkspace(args: Record<string, unknown>): ToolResult {
    const rawUploadId = stringArg(args, ['upload_id', 'id']).trim()
    if (!rawUploadId) return { success: false, error: 'Missing required parameter: upload_id' }

    const resolvedUpload = resolveUploadReference(rawUploadId)
    if (!resolvedUpload.ok) {
        return {
            success: false,
            error: resolvedUpload.error,
        }
    }
    const { uploadId, sourcePath } = resolvedUpload

    const typing = resolveUploadTyping(uploadId, sourcePath)
    const destArg = stringArg(args, ['dest_path', 'path'])
    const destRelative = destArg || path.posix.join(DEFAULT_DEST_DIR, defaultCopyName(uploadId, typing.extension))

    const sandboxed = resolveSandboxedWritable(destRelative)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }
    if (isInsideProtectedAgentPath(sandboxed.resolved)) {
        return { success: false, error: protectedAgentPathError(sandboxed.resolved) }
    }

    try {
        const dest = dedupeDestination(sandboxed.resolved)
        if (!dest) {
            return { success: false, error: `Destination already exists and could not be deduplicated: ${displayPath(sandboxed.resolved)}. Pass a different dest_path.` }
        }
        ensureParentDir(dest)
        fs.copyFileSync(sourcePath, dest, fs.constants.COPYFILE_EXCL)
        const size = fs.statSync(dest).size
        const workspacePath = workspaceRelativePath(dest)
        return {
            success: true,
            data: {
                path: workspacePath,
                workspace_path: workspacePath,
                display_path: displayPath(dest),
                upload_id: uploadId,
                mimeType: typing.mimeType,
                size,
                note: 'This is a working copy; the original upload is untouched and still serves the chat attachment.',
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error copying upload' }
    }
}

function resolveUploadReference(input: string):
    | { ok: true; uploadId: string; sourcePath: string }
    | { ok: false; error: string } {
    const exact = resolveExistingUploadPath(input)
    if (exact) return { ok: true, uploadId: input, sourcePath: exact }

    if (!BARE_UPLOAD_UUID_RE.test(input)) {
        return {
            ok: false,
            error: `Upload not found on disk: ${input}. Use the exact upload_id from the current message or find_past_uploads, including the file extension, or ask the user to re-attach the file.`,
        }
    }

    let names: string[]
    try {
        names = fs.readdirSync(activeRuntimePaths().uploadsDir)
    } catch {
        return {
            ok: false,
            error: `Upload not found on disk: ${input}. Use the exact upload_id from the current message or find_past_uploads, including the file extension, or ask the user to re-attach the file.`,
        }
    }

    const prefix = `${input}.`
    const matches = names
        .filter(name => name.startsWith(prefix))
        .map(name => ({ uploadId: name, sourcePath: resolveExistingUploadPath(name) }))
        .filter((entry): entry is { uploadId: string; sourcePath: string } => Boolean(entry.sourcePath))

    if (matches.length === 1) return { ok: true, ...matches[0] }
    if (matches.length > 1) {
        return {
            ok: false,
            error: `Multiple uploads match ${input}: ${matches.map(match => match.uploadId).join(', ')}. Use the exact upload_id including the file extension.`,
        }
    }
    return {
        ok: false,
        error: `Upload not found on disk: ${input}. Use the exact upload_id from the current message or find_past_uploads, including the file extension, or ask the user to re-attach the file.`,
    }
}

/**
 * Best-effort MIME + extension for the copy. The stored id extension is
 * authoritative when known; otherwise (legacy .bin uploads) sniff the leading
 * bytes so the workspace copy gets an extension tools can act on.
 */
function resolveUploadTyping(uploadId: string, sourcePath: string): { mimeType: string; extension: string } {
    const storedExt = path.extname(uploadId).toLowerCase()
    const mapped = uploadContentType(uploadId)
    if (mapped !== 'application/octet-stream') {
        return { mimeType: mapped, extension: storedExt }
    }
    const sniffed = sniffContentType(readHead(sourcePath))
    if (sniffed) return { mimeType: sniffed.mime, extension: sniffed.ext }
    return { mimeType: 'application/octet-stream', extension: storedExt || '.bin' }
}

function readHead(filePath: string): Buffer {
    const fd = fs.openSync(filePath, 'r')
    try {
        const buf = Buffer.alloc(SNIFF_HEAD_BYTES)
        const read = fs.readSync(fd, buf, 0, buf.length, 0)
        return buf.subarray(0, read)
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * Default copy name: the original chat filename when we have it, with the
 * extension corrected to the resolved one; otherwise the upload id re-typed.
 */
function defaultCopyName(uploadId: string, extension: string): string {
    const original = originalFilename(uploadId)
    const stem = (original ?? uploadId).replace(/\.[^./\\]+$/, '')
    const cleaned = path.basename(stem).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim()
    return `${cleaned || 'upload'}${extension}`
}

function originalFilename(uploadId: string): string | null {
    try {
        for (const entry of listAllAttachments()) {
            if (entry.id === uploadId && entry.filename) return entry.filename
        }
    } catch {
        // Metadata unavailable — fall back to the upload id.
    }
    return null
}

function dedupeDestination(resolved: string): string | null {
    if (!fs.existsSync(resolved)) return resolved
    const dir = path.dirname(resolved)
    const ext = path.extname(resolved)
    const stem = path.basename(resolved, ext)
    for (let i = 1; i <= MAX_DEDUPE_ATTEMPTS; i++) {
        const candidate = path.join(dir, `${stem}-${i}${ext}`)
        if (!fs.existsSync(candidate)) return candidate
    }
    return null
}

function workspaceRelativePath(resolved: string): string {
    const root = path.resolve(/* turbopackIgnore: true */ activeRuntimePaths().agentWorkspaceDir)
    const rel = path.relative(root, resolved)
    return rel.split(path.sep).join('/')
}
