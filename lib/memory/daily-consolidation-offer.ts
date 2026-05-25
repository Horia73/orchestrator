import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { AGENT_WORKSPACE_DIR, PRIVATE_STATE_DIR } from '@/lib/config'

const OFFER_STATE_PATH = path.join(PRIVATE_STATE_DIR, 'daily-memory-consolidation-offer.json')
const OFFER_VERSION = 'daily-memory-consolidation-offer-v1'
const OFFER_TITLE = 'Set up daily memory consolidation?'
const SETUP_TASK_ID = 'setup:daily-memory-consolidation'

interface OfferState {
    lastOfferedVersion?: string
}

function readOfferState(): OfferState {
    try {
        if (!fs.existsSync(OFFER_STATE_PATH)) return {}
        const parsed = JSON.parse(fs.readFileSync(OFFER_STATE_PATH, 'utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as OfferState
            : {}
    } catch {
        return {}
    }
}

function writeOfferState(state: OfferState): void {
    try {
        fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true })
        fs.writeFileSync(OFFER_STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
        console.warn('[memory-offer] failed to persist state', err)
    }
}

function readWorkspaceMarkdown(relativePath: string): string {
    const absolutePath = path.resolve(AGENT_WORKSPACE_DIR, relativePath)
    if (absolutePath !== AGENT_WORKSPACE_DIR && !absolutePath.startsWith(AGENT_WORKSPACE_DIR + path.sep)) {
        return ''
    }
    try {
        if (!fs.existsSync(absolutePath)) return ''
        const stat = fs.statSync(absolutePath)
        if (!stat.isFile() || stat.size <= 0) return ''
        return fs.readFileSync(absolutePath, 'utf8')
    } catch {
        return ''
    }
}

export function hasDailyMemoryConsolidationPreference(): boolean {
    const haystack = [
        readWorkspaceMarkdown('MONITORS.md'),
        readWorkspaceMarkdown('MEMORY.md'),
    ].join('\n').toLowerCase()

    return (
        haystack.includes('daily memory consolidation') ||
        (
            haystack.includes('memory_day') &&
            haystack.includes('consolidat') &&
            haystack.includes('midnight')
        )
    )
}

function offerBody(): string {
    return [
        'I can add a model-owned Smart Monitor maintenance watch: after local midnight, the consolidated Smart Monitor wake may review the daily working memory from the day that just ended and promote only durable facts into long-term memory.',
        '',
        'This would not create a separate scheduled task. The cadence and check instruction live in Smart Monitor and MONITORS.md; a suggested time like 00:30 is guidance for the consolidated wake.',
        '',
        'What it should promote:',
        '- stable user preferences and decision criteria',
        '- durable assistant operating rules',
        '- recurring monitor/digest/urgency preferences',
        '- long-running goals or setup facts that should matter later',
        '',
        'What it should ignore:',
        '- completed one-off tasks',
        '- low-level logs',
        '- transient implementation details',
        '- guesses, duplicates, and secrets',
    ].join('\n')
}

const OFFER_ACTIONS = [
    {
        id: 'enable_memory_consolidation',
        label: 'Enable',
        value: [
            'Enable model-owned daily memory consolidation.',
            'Create or update a Smart Monitor custom watch for this recurring maintenance; do not create a separate scheduled task. Store the check instruction in the watch rule as custom_prompt and document the durable spec in MONITORS.md with watchId, cadence/check timing, source/scope, notify rule, and silence rule. The watch may consolidate the just-ended MEMORY_DAY file into USER.md/MEMORY.md/MONITORS.md/IDENTITY.md only when there is durable signal; 00:30 is guidance, not a hard schedule; run at most once per local day; stay silent unless there is an error.',
        ].join(' '),
        style: 'primary' as const,
    },
    {
        id: 'explain_first',
        label: 'Explain first',
        value: 'Explain the model-owned daily memory consolidation preference, where you would store it, and what safeguards prevent noisy or sensitive memory.',
        style: 'secondary' as const,
    },
    {
        id: 'not_now',
        label: 'Not now',
        value: 'Do not enable daily memory consolidation right now. Do not write the preference unless I ask later.',
        style: 'secondary' as const,
    },
]

export async function maybeOfferDailyMemoryConsolidation(): Promise<{
    posted: boolean
    skipped?: string
    conversationId?: string
}> {
    if (hasDailyMemoryConsolidationPreference()) {
        return { posted: false, skipped: 'preference detected' }
    }

    const state = readOfferState()
    if (state.lastOfferedVersion === OFFER_VERSION) {
        return { posted: false, skipped: 'already offered' }
    }

    try {
        const { createInboxConversation, findInboxConversationByTaskAndTitle } =
            await import('@/lib/scheduling/store')

        const existing = findInboxConversationByTaskAndTitle(SETUP_TASK_ID, OFFER_TITLE)
        if (existing) {
            writeOfferState({ lastOfferedVersion: OFFER_VERSION })
            return {
                posted: false,
                skipped: 'existing inbox offer',
                conversationId: existing.id,
            }
        }

        const conversationId = createInboxConversation({
            taskId: SETUP_TASK_ID,
            title: OFFER_TITLE,
            messages: [
                {
                    id: `msg_${randomUUID()}`,
                    role: 'assistant',
                    content: offerBody(),
                    replyActions: OFFER_ACTIONS,
                    timestamp: Date.now(),
                },
            ],
        })

        const { sendInboxPushNotification } = await import('@/lib/push-notifications')
        void sendInboxPushNotification({
            conversationId,
            title: OFFER_TITLE,
            body: 'Daily memory consolidation can be enabled as a model-owned preference.',
        }).catch(() => {
            /* best-effort */
        })

        writeOfferState({ lastOfferedVersion: OFFER_VERSION })
        return { posted: true, conversationId }
    } catch (err) {
        console.warn('[memory-offer] check failed', err)
        return { posted: false, skipped: 'error' }
    }
}

export function _resetDailyMemoryConsolidationOfferForTesting(): void {
    try {
        if (fs.existsSync(OFFER_STATE_PATH)) fs.unlinkSync(OFFER_STATE_PATH)
    } catch {
        /* ignore */
    }
}
