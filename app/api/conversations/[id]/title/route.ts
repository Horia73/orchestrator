import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

import { getConversation, setConversationTitle } from '@/lib/db'
import { runTextSubAgent } from '@/lib/ai/agents/runner'
import { conversationNamer } from '@/lib/ai/agents/conversation-namer'
import type { ToolExecutionContext } from '@/lib/ai/agents/types'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'

const NAME_TIMEOUT_MS = 15_000
const MAX_INPUT_CHARS = 4_000

function clip(value: string, max: number): string {
    const trimmed = (value ?? '').trim()
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

// Models occasionally wrap titles in quotes, prefix them with "Title:", or end
// with a period. Strip that decoration down to a bare phrase.
function sanitizeTitle(raw: string): string {
    let title = (raw ?? '').replace(/\r?\n/g, ' ').trim()
    title = title.replace(/^["'`*_]+/, '').replace(/["'`*_]+$/, '').trim()
    title = title.replace(/^(title|titlu)\s*[:\-–]\s*/i, '').trim()
    title = title.replace(/\s+/g, ' ').replace(/[\s.,;:!?]+$/, '').trim()
    return title.slice(0, 120)
}

/**
 * Auto-name a conversation. The client posts the naming material (first user
 * message, optional assistant reply, attachment names) plus the title it
 * currently shows. We run the Conversation Namer agent and persist the result
 * only if the stored title still matches `currentTitle` — so we never clobber a
 * title the user already changed. Falls back silently to the existing title on
 * any failure.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        try {
            const { id } = await params
            const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

            const userText = typeof body.userText === 'string' ? body.userText : ''
            const assistantText = typeof body.assistantText === 'string' ? body.assistantText : ''
            const attachmentNames = Array.isArray(body.attachmentNames)
                ? (body.attachmentNames as unknown[])
                      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
                      .slice(0, 10)
                : []
            const currentTitle = typeof body.currentTitle === 'string' ? body.currentTitle : undefined

            const conversation = getConversation(id)
            if (!conversation) {
                return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
            }

            // Already renamed (manually or by an earlier run) — leave it alone.
            if (currentTitle !== undefined && conversation.title !== currentTitle) {
                return NextResponse.json({ title: conversation.title, changed: false })
            }

            const sections: string[] = []
            if (userText.trim()) {
                sections.push(`First user message:\n${clip(userText, MAX_INPUT_CHARS)}`)
            }
            if (attachmentNames.length) {
                sections.push(`Attached files: ${attachmentNames.join(', ')}`)
            }
            if (assistantText.trim()) {
                sections.push(`Assistant reply:\n${clip(assistantText, MAX_INPUT_CHARS)}`)
            }
            if (sections.length === 0) {
                return NextResponse.json({ title: conversation.title, changed: false })
            }

            const prompt = [
                'Generate a title for this conversation.',
                '',
                sections.join('\n\n'),
                '',
                'Return ONLY the title.',
            ].join('\n')

            const abort = new AbortController()
            const timer = setTimeout(() => abort.abort(), NAME_TIMEOUT_MS)
            const parentCtx: ToolExecutionContext = {
                callerAgentId: 'system',
                depth: 0,
                conversationId: id,
                parentRequestId: `title_${randomUUID()}`,
                signal: abort.signal,
            }

            let result
            try {
                result = await runTextSubAgent({ target: conversationNamer, prompt, parentCtx })
            } finally {
                clearTimeout(timer)
            }

            if (!result?.success) {
                return NextResponse.json(
                    { error: 'Naming failed', detail: result?.error ?? 'unknown error' },
                    { status: 502 }
                )
            }

            const data = result.data as { output?: unknown } | undefined
            const rawOutput =
                typeof data?.output === 'string'
                    ? data.output
                    : typeof result.data === 'string'
                      ? result.data
                      : ''
            const title = sanitizeTitle(rawOutput)
            if (!title) {
                return NextResponse.json({ title: conversation.title, changed: false })
            }

            const stored = setConversationTitle(id, title, currentTitle)
            return NextResponse.json({ title: stored ?? title, changed: stored === title })
        } catch (error) {
            console.error('Failed to auto-name conversation', error)
            return NextResponse.json({ error: 'Failed to auto-name conversation' }, { status: 500 })
        }
  })
}
