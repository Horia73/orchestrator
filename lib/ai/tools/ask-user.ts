import { randomUUID } from 'crypto'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    QuestionArtifactSchema,
    type QuestionArtifact,
    type QuestionOption,
} from '@/lib/questions/schema'

// ---------------------------------------------------------------------------
// ask_user — pose a structured, tappable question to the user.
//
// Modeled on Claude Code's native AskUserQuestion, but built as a first-class
// orchestrator tool so it renders in our own web/PWA chat (the native tool is
// TUI-only and never surfaces in headless `-p` runs). Success returns a
// `directEmit` question artifact: the chat route mounts the card instantly, the
// QuestionRenderer shows the choices, and the user's tap posts their selection
// as the next message so this same conversation continues.
//
// This is the LAST thing to do in a turn: after calling it, stop and wait.
// ---------------------------------------------------------------------------

export const ASK_USER_TOOL_ID = 'ask_user'

const KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export const askUserTool: ToolDef = {
    id: ASK_USER_TOOL_ID,
    name: ASK_USER_TOOL_ID,
    description: [
        'Ask the user ONE structured question with tappable options, rendered as a card in the chat.',
        'Use this ONLY for a decision that is genuinely the user\'s to make and that you cannot resolve from the request, memory, context, or a sensible default — a real fork where the answer changes what you do next (e.g. which approach, which account, which scope). Do NOT use it for choices with an obvious default, for facts you can look up yourself, or to ask "should I proceed?" when the intent is already clear; just proceed and mention what you did.',
        'Provide 2-4 distinct options (up to 8), each a short label with an optional one-line description of the trade-off. Set multiSelect:true only when several answers can be picked together. allowOther defaults to true so the user can answer off-menu with free text; set it false only when the options are genuinely exhaustive.',
        'On success the card mounts INSTANTLY (do NOT emit an <artifact> tag yourself). After this call, STOP: end your turn without writing more prose and without calling more tools. The user\'s next message is their answer — one or more of the option labels you supplied, or free text if they chose Other. Treat it as the answer to this question and continue.',
        'Ask one question per call. If you truly need several answers, ask the single most decision-blocking one first.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: 'The complete question to ask. Clear, specific, ends with a question mark.',
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
                description: 'Allow selecting more than one option. Default false (single choice).',
            },
            allowOther: {
                type: 'boolean',
                description: 'Show a free-text "Other" field for an off-menu answer. Default true; set false only when options are exhaustive.',
            },
            header: {
                type: 'string',
                description: 'Optional very short category chip (<= 24 chars), e.g. "Auth method", "Scope".',
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
        required: ['question', 'options'],
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

export async function executeAskUser(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    void ctx
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    if (!question) {
        return { success: false, error: 'ask_user requires a non-empty `question`.' }
    }

    const rawOptions = Array.isArray(args.options) ? args.options : []
    const options: QuestionOption[] = []
    const seen = new Set<string>()
    for (const raw of rawOptions) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const item = raw as Record<string, unknown>
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
        return { success: false, error: 'ask_user requires at least one option with a non-empty label.' }
    }

    const multiSelect = args.multiSelect === true
    const allowOther = args.allowOther !== false
    const header = typeof args.header === 'string' && args.header.trim()
        ? args.header.trim().slice(0, 24)
        : undefined
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

    const artifact: QuestionArtifact = {
        question: question.slice(0, 800),
        ...(header ? { header } : {}),
        options,
        ...(multiSelect ? { multiSelect: true } : {}),
        ...(allowOther ? { allowOther: true } : {}),
    }
    const parsed = QuestionArtifactSchema.safeParse(artifact)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { success: false, error: `ask_user validation failed at ${path}: ${first.message}` }
    }

    // A fresh identifier per question keeps each card its own (conversationId,
    // identifier) version chain — two questions in one conversation must not
    // collapse into versions of each other.
    const identifier = identifierArg || `${slugifyQuestion(question)}-${randomUUID().slice(0, 8)}`

    return {
        success: true,
        data: {
            directEmit: true,
            identifier,
            title,
            type: 'application/vnd.ant.question',
            display: 'inline',
            body: JSON.stringify(parsed.data),
            usage: 'The question card is now visible to the user with tappable options — do NOT emit an <artifact> tag. STOP here: end your turn without writing more text and without calling more tools. The user\'s next message will be their selection (one or more option labels, or free text if they chose Other). Do not answer your own question or assume a choice.',
        },
    }
}
