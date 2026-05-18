import { z } from 'zod'

/**
 * Render target chosen by the model:
 *   - 'inline' — render inside the chat message bubble
 *   - 'panel'  — render in the dedicated side panel
 *
 * New prompts ask the model to always emit this as `display="..."` on the
 * artifact tag. The schema still allows it to be absent so older saved
 * messages and malformed outputs remain renderable.
 */
const ArtifactDisplaySchema = z.enum(['inline', 'panel'])
export type ArtifactDisplay = z.infer<typeof ArtifactDisplaySchema>

/**
 * Persisted artifact row. `id` is a stable UUID we mint at insert time;
 * `identifier` is the model-chosen handle (e.g. "bolognese-recipe") that ties
 * versions together. (conversationId, identifier) is the version chain.
 */
export interface ArtifactRow {
    id: string
    conversationId: string
    messageId: string
    /** Model-chosen kebab-case handle. Stable across versions. */
    identifier: string
    /** 1-based monotone version inside (conversationId, identifier). */
    version: number
    /** MIME type. First-class renderers handle known artifact types; unknown types fall back to code. */
    type: string
    title: string
    /** Optional language hint for code/text artifacts (e.g. "tsx", "python"). */
    language: string | null
    /** Model-chosen render target. null = compatibility fallback. */
    display: ArtifactDisplay | null
    /** Absolute path to the real file backing this artifact version, when persisted. */
    filePath?: string | null
    content: string
    createdAt: number
}

/**
 * Attributes parsed out of an opening artifact tag.
 *
 * `identifier`, `type`, and `title` are parser-required — if any is missing
 * the parser emits an error event and treats the block as prose so the user
 * isn't stuck staring at a half-rendered card. `display` is prompt-required
 * for new output, but parser-optional for compatibility.
 */
export const ArtifactOpenAttrsSchema = z.object({
    identifier: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    language: z.string().optional(),
    display: ArtifactDisplaySchema.optional(),
})
export type ArtifactOpenAttrs = z.infer<typeof ArtifactOpenAttrsSchema>

// ---------------------------------------------------------------------------
// Streaming events emitted by the parser.
// ---------------------------------------------------------------------------

export type ArtifactStreamEvent =
    | { kind: 'prose'; text: string }
    | { kind: 'artifact_start'; attrs: ArtifactOpenAttrs; clientToken: string }
    | { kind: 'artifact_chunk'; clientToken: string; text: string }
    | { kind: 'artifact_end'; clientToken: string }
    /** Emitted when an opening tag is malformed; the malformed text is fed to prose. */
    | { kind: 'artifact_error'; message: string; raw: string }
