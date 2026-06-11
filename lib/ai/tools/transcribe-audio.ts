import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import type { Attachment } from '@/lib/types'
// Type-only: the runtime `transcribeAudioAttachment` is imported lazily inside
// the executor. Eagerly importing @/lib/ai/audio-context here would pull the
// sub-agent runner (→ tools/registry → tool-catalog) into this module, which
// tool-catalog imports while ALL_TOOL_DEFS is still initializing → a TDZ cycle.
import type { AudioContextMode } from '@/lib/ai/audio-context'
import { listAllAttachments } from '@/lib/db'
import { sniffContentType } from '@/lib/file-sniff'
import { UPLOAD_MIME_MAP } from '@/lib/upload-mime'
import {
    MAX_UPLOAD_FILE_BYTES,
    classifyUploadMime,
    persistUploadBytes,
    resolveExistingUploadPath,
    uploadContentType,
} from '@/lib/uploads'
import { displayPath, isInsideProtectedAgentPath, protectedAgentPathError, resolveSandboxed } from './sandbox'

// ---------------------------------------------------------------------------
// TranscribeAudio — on-demand transcription of uploaded audio files.
//
// The app already runs an automatic audio pre-pass (lib/ai/audio-context.ts)
// when the main chat model cannot read audio natively. That covers exactly one
// case: audio on the CURRENT message + a non-audio model. This tool fills the
// gaps the pre-pass and inline listening do NOT cover:
//   - a written transcript wanted as a deliverable (to save/quote), even when
//     the model can hear the audio;
//   - audio the user sent in an EARLIER message (not in the model's window);
//   - a sub-agent (worker/researcher) that runs into audio mid-task.
// Transcript mode uses a transcript-only Gemini agent, while analysis mode uses
// the audio-context report agent. They share conversion/cache machinery but not
// system prompts.
// ---------------------------------------------------------------------------

const MAX_FILES = 5

export const transcribeAudioTool: ToolDef = {
    id: 'TranscribeAudio',
    name: 'TranscribeAudio',
    description: [
        'Transcribe one or more AUDIO files to text (Gemini under the hood; transcript mode honors the Audio Transcript Agent model set in Settings → Models).',
        'Pass upload_ids (from the current message or find_past_uploads) and/or workspace-relative paths (audio files you created or converted in the workspace, e.g. tmp/voice.mp3).',
        "When NOT to use: if the audio is attached to the CURRENT message AND your own model reads audio natively (e.g. Gemini), just listen to it directly — do not round-trip through this tool.",
        'Use it when you need a written transcript as a deliverable (to save in the Library or quote back), for audio the user sent in an EARLIER message that is not in front of you, or when your model cannot read audio.',
        'Gemini-incompatible audio containers such as m4a/x-m4a are converted to WAV automatically before transcription when ffmpeg can decode them. If automatic conversion fails, copy_upload_to_workspace the upload, convert it yourself with Bash ffmpeg to a Gemini-supported format (prefer 16 kHz mono WAV), then call this tool again with the converted path. Audio-only video containers (e.g. an MP4 "audio message" with no video track) are detected and transcribed directly. For audio inside a real VIDEO or a format this tool rejects: copy_upload_to_workspace the file, extract/convert with Bash ffmpeg (e.g. to mp3), then call this tool with the converted path.',
        "mode 'transcript' (default) uses the transcript-only agent and returns a clean verbatim transcript; mode 'analysis' uses the audio-context report agent and returns language/speaker/music/ambient detail. Results are cached per file.",
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            upload_ids: {
                type: 'array',
                items: { type: 'string' },
                description: `Upload ids of audio files to transcribe (from the current message or find_past_uploads). Max ${MAX_FILES} files per call including paths.`,
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Workspace-relative paths of audio files to transcribe — use for audio you converted/extracted in the workspace. Each file is registered as an upload (you get its upload_id back) and transcribed.',
            },
            mode: {
                type: 'string',
                enum: ['transcript', 'analysis'],
                description: "Default 'transcript' (verbatim text only). 'analysis' adds language/speaker/music/ambient detail.",
            },
            language: {
                type: 'string',
                description: 'Optional language hint (e.g. "ro", "en") when you already know the spoken language; improves accuracy. Omit to auto-detect.',
            },
        },
    },
    tags: ['audio', 'media', 'read'],
}

export async function executeTranscribeAudio(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    if (!ctx) {
        return { success: false, error: 'TranscribeAudio requires an execution context.' }
    }

    const ids = stringList(args.upload_ids)
    const paths = stringList(args.paths)
    if (ids.length === 0 && paths.length === 0) {
        return { success: false, error: 'Provide at least one upload_id (from the current message or find_past_uploads) or a workspace-relative path of an audio file.' }
    }
    if (ids.length + paths.length > MAX_FILES) {
        return { success: false, error: `Too many files: ${ids.length + paths.length} (max ${MAX_FILES}).` }
    }

    const mode: AudioContextMode = args.mode === 'analysis' ? 'analysis' : 'transcript'
    const language = typeof args.language === 'string' && args.language.trim()
        ? args.language.trim()
        : undefined

    // Lazy to avoid a module-init cycle (see the type-only import note above).
    const { transcribeAudioAttachment } = await import('@/lib/ai/audio-context')

    const filenames = originalFilenames(ids)
    const transcripts: Array<Record<string, unknown>> = []

    const targets: Array<{ attachment: Attachment | null; sourcePath?: string; failure?: Record<string, unknown> }> = []
    for (const id of ids) {
        const attachment = attachmentFromUploadId(id, filenames.get(id))
        if (!attachment) {
            targets.push({ attachment: null, failure: { upload_id: id, status: 'unavailable', reason: 'Upload not found on disk — ask the user to re-attach it.' } })
            continue
        }
        if (!attachment.mimeType.toLowerCase().startsWith('audio/')) {
            const audioMime = await audioOnlyContainerMime(resolveExistingUploadPath(id), attachment.mimeType)
            if (!audioMime) {
                targets.push({
                    attachment: null,
                    failure: {
                        upload_id: id,
                        filename: attachment.filename,
                        status: 'unavailable',
                        reason: `Not an audio file (${attachment.mimeType}). If it contains audio (e.g. a video), copy_upload_to_workspace it, extract/convert the audio with Bash ffmpeg, then re-call TranscribeAudio with the converted path in \`paths\`.`,
                    },
                })
                continue
            }
            attachment.mimeType = audioMime
            attachment.type = 'audio'
        }
        targets.push({ attachment })
    }
    for (const p of paths) {
        targets.push(await attachmentFromWorkspacePath(p))
    }

    for (const target of targets) {
        if (!target.attachment) {
            transcripts.push(target.failure ?? { status: 'unavailable', reason: 'Unreadable file.' })
            continue
        }
        const attachment = target.attachment
        const sourceFields = target.sourcePath
            ? { path: target.sourcePath, upload_id: attachment.id }
            : { upload_id: attachment.id }

        const result = await transcribeAudioAttachment({ attachment, mode, language, parentCtx: ctx })
        if (result.status !== 'ok') {
            transcripts.push({ ...sourceFields, filename: attachment.filename, status: 'unavailable', reason: result.reason })
            continue
        }
        transcripts.push({
            ...sourceFields,
            filename: attachment.filename,
            mode,
            cache: result.cacheHit ? 'hit' : 'miss',
            transcribed_by: `${result.provider}:${result.model}`,
            text: result.content,
        })
    }

    const anyOk = transcripts.some((entry) => entry.status !== 'unavailable')
    if (!anyOk) {
        return {
            success: false,
            error: transcripts.map((entry) => `${entry.upload_id ?? entry.path ?? 'file'}: ${entry.reason}`).join('; '),
        }
    }

    return { success: true, data: { count: transcripts.length, transcripts } }
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
}

// ISO base-media containers that magic-byte sniffing types as video even when
// they hold nothing but an audio track ("audio message" MP4 exports).
const ISO_VIDEO_CONTAINER_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/3gpp'])

/**
 * When a "video" file is actually an audio-only ISO container, return the
 * audio MIME to transcribe it under; null means it really is video (or the
 * probe failed) and the caller should keep rejecting with the convert hint.
 */
async function audioOnlyContainerMime(filePath: string | null, mimeType: string): Promise<string | null> {
    if (!filePath || !ISO_VIDEO_CONTAINER_MIMES.has(mimeType.toLowerCase())) return null
    const { probeIsAudioOnly } = await import('@/lib/audio-transcode')
    return (await probeIsAudioOnly(filePath)) ? 'audio/mp4' : null
}

function attachmentFromUploadId(id: string, filename?: string): Attachment | null {
    const filePath = resolveExistingUploadPath(id)
    if (!filePath) return null
    let mimeType = uploadContentType(id)
    // Legacy/mis-typed uploads (extension-less files stored as .bin before the
    // upload route learned to sniff) serve as octet-stream even when the bytes
    // are real audio. Sniff the head so they stay transcribable.
    if (mimeType === 'application/octet-stream') {
        const sniffed = sniffContentType(readFileHead(filePath))
        if (sniffed) mimeType = sniffed.mime
    }
    let size = 0
    try {
        size = fs.statSync(filePath).size
    } catch {
        // Path resolved above; a stat race just leaves size 0 (display-only).
    }
    return { id, filename: filename || id, mimeType, size, type: classifyUploadMime(mimeType) }
}

/**
 * Turn a workspace audio file (e.g. converted with ffmpeg after
 * copy_upload_to_workspace) into a transcribable upload. The sub-agent runner
 * only forwards files that live in the uploads dir, so the bytes are persisted
 * as a new upload first; the returned upload_id is surfaced to the caller so a
 * repeat call can reuse it (and hit the transcript cache).
 */
async function attachmentFromWorkspacePath(
    workspacePath: string,
): Promise<{ attachment: Attachment | null; sourcePath?: string; failure?: Record<string, unknown> }> {
    const fail = (reason: string) => ({ attachment: null, failure: { path: workspacePath, status: 'unavailable', reason } })

    const sandboxed = resolveSandboxed(workspacePath)
    if (!sandboxed.ok) return fail(sandboxed.error)
    if (isInsideProtectedAgentPath(sandboxed.resolved)) return fail(protectedAgentPathError(sandboxed.resolved))

    let stat: fs.Stats
    try {
        stat = fs.statSync(sandboxed.resolved)
    } catch {
        return fail(`File not found: ${displayPath(sandboxed.resolved)}`)
    }
    if (!stat.isFile()) return fail(`Not a file: ${displayPath(sandboxed.resolved)}`)
    if (stat.size > MAX_UPLOAD_FILE_BYTES) {
        return fail(`File is too large to transcribe (${Math.round(stat.size / (1024 * 1024))} MB; max ${Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))} MB). Split or compress it first (e.g. ffmpeg to a lower-bitrate mp3).`)
    }

    const ext = path.extname(sandboxed.resolved).toLowerCase()
    let bytes: Buffer
    try {
        bytes = fs.readFileSync(sandboxed.resolved)
    } catch (err) {
        return fail(err instanceof Error ? err.message : 'Could not read file.')
    }

    let mimeType = UPLOAD_MIME_MAP[ext] || ''
    if (!mimeType.startsWith('audio/')) {
        const sniffed = sniffContentType(bytes)
        if (sniffed) mimeType = sniffed.mime
    }
    if (!mimeType.toLowerCase().startsWith('audio/')) {
        const audioMime = await audioOnlyContainerMime(sandboxed.resolved, mimeType)
        if (!audioMime) {
            return fail(`Not an audio file (${mimeType || 'unknown type'}). Convert it to audio first (Bash ffmpeg, e.g. to mp3), then pass the converted path.`)
        }
        mimeType = audioMime
    }

    try {
        const saved = persistUploadBytes(bytes, mimeType, path.basename(sandboxed.resolved))
        return { attachment: saved.attachment, sourcePath: displayPath(sandboxed.resolved) }
    } catch (err) {
        return fail(err instanceof Error ? err.message : 'Could not register the file for transcription.')
    }
}

function readFileHead(filePath: string, bytes = 8192): Buffer {
    try {
        const fd = fs.openSync(filePath, 'r')
        try {
            const buf = Buffer.alloc(bytes)
            const read = fs.readSync(fd, buf, 0, buf.length, 0)
            return buf.subarray(0, read)
        } finally {
            fs.closeSync(fd)
        }
    } catch {
        return Buffer.alloc(0)
    }
}

// Best-effort original filename lookup so the result reads nicely (the upload id
// on disk is a uuid.ext). One DB scan for the whole batch; absent metadata just
// falls back to the id.
function originalFilenames(ids: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const wanted = new Set(ids)
    try {
        for (const entry of listAllAttachments()) {
            if (wanted.has(entry.id) && entry.filename && !out.has(entry.id)) {
                out.set(entry.id, entry.filename)
            }
        }
    } catch {
        // Metadata unavailable — callers fall back to the upload id.
    }
    return out
}
