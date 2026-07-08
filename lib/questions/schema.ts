import { z } from 'zod'

/**
 * `application/vnd.ant.question` — a structured, tappable question card the
 * orchestrator poses to the user mid-conversation via the `ask_user` tool.
 *
 * The tool returns this as a `directEmit` artifact body; the chat route mounts
 * the card instantly (no model-authored <artifact> tag). The QuestionRenderer
 * turns it into one or more question blocks (single/multi-select chips + an
 * optional free-text "Other" field per question) with a single "Send" button.
 * When the user submits, the renderer persists `answered` back onto the artifact
 * (so a reload shows the resolved, locked card) and posts the chosen values as
 * the user's next message so the agent continues.
 *
 * A card carries 1–4 questions (modeled on Claude Code's native AskUserQuestion,
 * which batches questions). The internal shape is always the multi-question
 * form; `parseQuestionArtifact` up-converts the legacy single-question shape
 * (top-level `question`/`options`) so cards persisted before the multi-question
 * change keep rendering.
 */

export const QuestionOptionSchema = z.object({
    /** Concise choice text shown on the chip (1-5 words works best). */
    label: z.string().min(1).max(120),
    /** Optional one-line explanation of the trade-off / implication. */
    description: z.string().max(400).optional(),
})
export type QuestionOption = z.infer<typeof QuestionOptionSchema>

/** One question within a card. A card holds 1–4 of these. */
export const QuestionItemSchema = z.object({
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
})
export type QuestionItem = z.infer<typeof QuestionItemSchema>

/** One question's recorded response — index-aligned to `questions`. */
export const QuestionResponseSchema = z.object({
    /** Labels the user selected (one for single-select, many for multi). */
    selected: z.array(z.string()).default([]),
    /** Free-text answer when the user used the "Other" field. */
    other: z.string().max(2000).optional(),
})
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>

export const QuestionAnswerSchema = z.object({
    /** One response per question, index-aligned to `questions`. */
    responses: z.array(QuestionResponseSchema).min(1),
    /** ISO timestamp the card was submitted. */
    answeredAt: z.string().min(1),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>

export const QuestionArtifactSchema = z
    .object({
        /** 1–4 questions posed together on one card. */
        questions: z.array(QuestionItemSchema).min(1).max(4),
        /** Present once the user submitted — locks the card to a read-only state. */
        answered: QuestionAnswerSchema.optional(),
    })
    .refine(
        (v) => !v.answered || v.answered.responses.length === v.questions.length,
        { message: 'answered.responses must have one entry per question', path: ['answered', 'responses'] },
    )
export type QuestionArtifact = z.infer<typeof QuestionArtifactSchema>

/**
 * Up-convert the legacy single-question body (top-level `question`/`options`,
 * `answered: { selected, other, answeredAt }`) to the multi-question shape.
 * Bodies already in the multi-question shape (a `questions` array) pass through.
 */
function normalizeLegacyShape(json: Record<string, unknown>): unknown {
    if (Array.isArray(json.questions)) return json
    if (typeof json.question !== 'string') return json

    const item: Record<string, unknown> = {
        question: json.question,
        options: json.options,
    }
    if (typeof json.header === 'string') item.header = json.header
    if (json.multiSelect === true) item.multiSelect = true
    if (json.allowOther === true) item.allowOther = true

    const out: Record<string, unknown> = { questions: [item] }
    const legacyAnswered = json.answered
    if (legacyAnswered && typeof legacyAnswered === 'object' && !Array.isArray(legacyAnswered)) {
        const a = legacyAnswered as Record<string, unknown>
        out.answered = {
            responses: [
                {
                    selected: Array.isArray(a.selected) ? a.selected : [],
                    ...(typeof a.other === 'string' ? { other: a.other } : {}),
                },
            ],
            answeredAt: typeof a.answeredAt === 'string' && a.answeredAt ? a.answeredAt : new Date().toISOString(),
        }
    }
    return out
}

export function parseQuestionArtifact(
    source: string,
): { ok: true; value: QuestionArtifact } | { ok: false; error: string } {
    let json: unknown
    try {
        json = JSON.parse(source)
    } catch (e) {
        return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, error: '(root): expected an object' }
    }
    const normalized = normalizeLegacyShape(json as Record<string, unknown>)
    const parsed = QuestionArtifactSchema.safeParse(normalized)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `${path}: ${first.message}` }
    }
    return { ok: true, value: parsed.data }
}
