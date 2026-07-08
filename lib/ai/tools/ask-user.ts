import { randomUUID } from 'crypto'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    QuestionArtifactSchema,
    type QuestionArtifact,
    type QuestionItem,
    type QuestionOption,
} from '@/lib/questions/schema'

// ---------------------------------------------------------------------------
// ask_user — pose one or more structured, tappable questions to the user.
//
// Modeled on Claude Code's native AskUserQuestion, but built as a first-class
// orchestrator tool so it renders in our own web/PWA chat (the native tool is
// TUI-only and never surfaces in headless `-p` runs). Success returns a
// `directEmit` question artifact: the chat route mounts the card instantly, the
// QuestionRenderer shows the choices for every question with a single Send
// button, and the user's submission posts their selections as the next message
// so this same conversation continues.
//
// This is the LAST thing to do in a turn: after calling it, stop and wait.
// ---------------------------------------------------------------------------

export const ASK_USER_TOOL_ID = 'ask_user'

const KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
const MAX_QUESTIONS = 4

export const askUserTool: ToolDef = {
    id: ASK_USER_TOOL_ID,
    name: ASK_USER_TOOL_ID,
    description: [
        'Ask the user 1-4 structured questions with tappable options, rendered as a single card in the chat. The user answers each question then taps one Send button; their submission continues this turn.',
        'Use this ONLY for a decision that is genuinely the user\'s to make and that you cannot resolve from the request, memory, context, or a sensible default — a real fork where the answer changes what you do next (e.g. which approach, which account, which scope). Do NOT use it for choices with an obvious default, for facts you can look up yourself, or to ask "should I proceed?" when the intent is already clear; just proceed and mention what you did.',
        'Pass a `questions` array (1-4 items). Batch questions only when they are all genuinely decision-blocking; if one answer would change the others, ask the single most important one first. Each question has 2-4 distinct options (up to 8), each a short label with an optional one-line description of the trade-off. Set multiSelect:true on a question only when several of its answers can be picked together. allowOther defaults to true so the user can answer off-menu with free text; set it false only when a question\'s options are genuinely exhaustive.',
        'On success the card mounts INSTANTLY (do NOT emit an <artifact> tag yourself). After this call, STOP: end your turn without writing more prose and without calling more tools. The user\'s next message is their answer — for each question, one or more of the option labels you supplied, or free text if they chose Other. Treat it as the answer and continue.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                description: '1-4 questions to ask together on one card. The user answers all of them and taps Send once.',
                items: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: 'The complete question. Clear, specific, ends with a question mark.',
                        },
                        header: {
                            type: 'string',
                            description: 'Optional very short category chip (<= 24 chars), e.g. "Auth method", "Scope".',
                        },
                        options: {
                            type: 'array',
                            description: '2-4 distinct choices (up to 8). Mutually exclusive unless multiSelect is true.',
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string', description: 'Concise choice text (1-5 words).' },
                                    description: {
                                        type: 'string',
                                        description: 'Optional one-line explanation of what this option means or its trade-off.',
                                    },
                                },
                                required: ['label'],
                            },
                        },
                        multiSelect: {
                            type: 'boolean',
                            description: 'Allow selecting more than one option for this question. Default false (single choice).',
                        },
                        allowOther: {
                            type: 'boolean',
                            description: 'Show a free-text "Other" field for an off-menu answer. Default true; set false only when options are exhaustive.',
                        },
                    },
                    required: ['question', 'options'],
                },
            },
            title: {
                type: 'string',
                description: 'Optional card title. Defaults to "Quick question".',
            },
            identifier: {
                type: 'string',
                description: 'Optional stable kebab-case handle for the question card. A unique one is generated when omitted.',
            },
        },
        required: ['questions'],
    },
    tags: ['ask-user'],
}

function slugifyQuestion(question: string): string {
    return question
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '') || 'question'
}

/** Build a validated QuestionItem from raw tool args, or a reason it's invalid. */
function buildQuestionItem(raw: unknown): { ok: true; item: QuestionItem } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'each question must be an object' }
    }
    const q = raw as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!question) return { ok: false, error: 'each question needs a non-empty `question`' }

    const rawOptions = Array.isArray(q.options) ? q.options : []
    const options: QuestionOption[] = []
    const seen = new Set<string>()
    for (const rawOpt of rawOptions) {
        if (!rawOpt || typeof rawOpt !== 'object' || Array.isArray(rawOpt)) continue
        const item = rawOpt as Record<string, unknown>
        const label = typeof item.label === 'string' ? item.label.trim() : ''
        if (!label) continue
        const key = label.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const description = typeof item.description === 'string' && item.description.trim()
            ? item.description.trim().slice(0, 400)
            : undefined
        options.push({ label: label.slice(0, 120), ...(description ? { description } : {}) })
        if (options.length >= 8) break
    }
    if (options.length < 1) {
        return { ok: false, error: `question "${question.slice(0, 40)}" needs at least one option with a non-empty label` }
    }

    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim().slice(0, 24) : undefined
    return {
        ok: true,
        item: {
            question: question.slice(0, 800),
            ...(header ? { header } : {}),
            options,
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
            ...(q.allowOther !== false ? { allowOther: true } : {}),
        },
    }
}

export async function executeAskUser(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    void ctx

    // Canonical input is a `questions` array; also accept the legacy flat
    // single-question shape (top-level `question`/`options`) so a model that
    // still calls the old schema doesn't hard-fail.
    let rawQuestions: unknown[]
    if (Array.isArray(args.questions)) {
        rawQuestions = args.questions
    } else if (typeof args.question === 'string') {
        rawQuestions = [{
            question: args.question,
            options: args.options,
            header: args.header,
            multiSelect: args.multiSelect,
            allowOther: args.allowOther,
        }]
    } else {
        return { success: false, error: 'ask_user requires a `questions` array (1-4 items), each with a `question` and `options`.' }
    }

    if (rawQuestions.length === 0) {
        return { success: false, error: 'ask_user requires at least one question.' }
    }

    const questions: QuestionItem[] = []
    for (const raw of rawQuestions.slice(0, MAX_QUESTIONS)) {
        const built = buildQuestionItem(raw)
        if (!built.ok) return { success: false, error: `ask_user: ${built.error}.` }
        questions.push(built.item)
    }

    const title = typeof args.title === 'string' && args.title.trim()
        ? args.title.trim().slice(0, 120)
        : 'Quick question'
    const identifierArg = typeof args.identifier === 'string' && args.identifier.trim()
        ? args.identifier.trim()
        : ''
    if (identifierArg && !KEBAB_RE.test(identifierArg)) {
        return {
            success: false,
            error: `ask_user identifier "${identifierArg}" must be kebab-case (lowercase letters, digits, hyphens; start with a letter or digit).`,
        }
    }

    const artifact: QuestionArtifact = { questions }
    const parsed = QuestionArtifactSchema.safeParse(artifact)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `ask_user validation failed at ${path}: ${first.message}` }
    }

    // A fresh identifier per card keeps each its own (conversationId,
    // identifier) version chain — two cards in one conversation must not
    // collapse into versions of each other.
    const identifier = identifierArg || `${slugifyQuestion(questions[0].question)}-${randomUUID().slice(0, 8)}`

    const stopNote = questions.length > 1
        ? 'The user\'s next message answers all of the questions.'
        : 'The user\'s next message will be their selection (one or more option labels, or free text if they chose Other).'

    return {
        success: true,
        data: {
            directEmit: true,
            identifier,
            title,
            type: 'application/vnd.ant.question',
            display: 'inline',
            body: JSON.stringify(parsed.data),
            usage: `The question card is now visible to the user with tappable options and a Send button — do NOT emit an <artifact> tag. STOP here: end your turn without writing more text and without calling more tools. ${stopNote} Do not answer your own question or assume a choice.`,
        },
    }
}
