import { z } from 'zod'

/**
 * `application/vnd.ant.question` — a structured, tappable question the
 * orchestrator poses to the user mid-conversation via the `ask_user` tool.
 *
 * The tool returns this as a `directEmit` artifact body; the chat route mounts
 * the card instantly (no model-authored <artifact> tag). The QuestionRenderer
 * turns it into single/multi-select chips + an optional free-text "Other"
 * field. When the user answers, the renderer persists `answered` back onto the
 * artifact (so a reload shows the resolved, locked card) and posts the chosen
 * value as the user's next message so the agent continues.
 */

export const QuestionOptionSchema = z.object({
    /** Concise choice text shown on the chip (1-5 words works best). */
    label: z.string().min(1).max(120),
    /** Optional one-line explanation of the trade-off / implication. */
    description: z.string().max(400).optional(),
})
export type QuestionOption = z.infer<typeof QuestionOptionSchema>

export const QuestionAnswerSchema = z.object({
    /** Labels the user selected (one for single-select, many for multi). */
    selected: z.array(z.string()).default([]),
    /** Free-text answer when the user chose the "Other" field. */
    other: z.string().max(2000).optional(),
    /** ISO timestamp the answer was recorded. */
    answeredAt: z.string().min(1),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>

export const QuestionArtifactSchema = z.object({
    /** The question itself. */
    question: z.string().min(1).max(800),
    /** Optional very short category chip, e.g. "Auth method". */
    header: z.string().max(24).optional(),
    /** 1-8 choices. 2-4 is the sweet spot; keep them distinct. */
    options: z.array(QuestionOptionSchema).min(1).max(8),
    /** Allow selecting multiple options. Default (absent) = single-select. */
    multiSelect: z.boolean().optional(),
    /** Show a free-text "Other" field so the user can answer off-menu. */
    allowOther: z.boolean().optional(),
    /** Present once the user has answered — locks the card to a read-only state. */
    answered: QuestionAnswerSchema.optional(),
})
export type QuestionArtifact = z.infer<typeof QuestionArtifactSchema>

export function parseQuestionArtifact(
    source: string,
): { ok: true; value: QuestionArtifact } | { ok: false; error: string } {
    let json: unknown
    try {
        json = JSON.parse(source)
    } catch (e) {
        return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
    }
    const parsed = QuestionArtifactSchema.safeParse(json)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `${path}: ${first.message}` }
    }
    return { ok: true, value: parsed.data }
}
