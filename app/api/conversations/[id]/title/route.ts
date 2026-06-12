import { NextResponse } from 'next/server'

import { getConversation, setConversationTitle } from '@/lib/db'
import { runWithRequestProfile } from "@/lib/profiles/server"
import { generateConversationTitleFromSeed } from '@/lib/ai/conversation-auto-title'

export const runtime = 'nodejs'

/**
 * Auto-name a conversation. The client posts the naming material (first user
 * message, optional assistant reply, attachment names) plus the title it
 * currently shows. We run the Conversation Namer agent and persist the result
 * only if the stored title still matches `currentTitle` — so we never clobber a
 * title the user already changed. Falls back to the existing title when there
 * is no usable naming material.
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

            try {
                const title = await generateConversationTitleFromSeed({
                    conversationId: id,
                    seed: { userText, assistantText, attachmentNames },
                })
                if (!title) {
                    return NextResponse.json({ title: conversation.title, changed: false })
                }

                const stored = setConversationTitle(id, title, currentTitle)
                return NextResponse.json({ title: stored ?? title, changed: stored === title })
            } catch (error) {
                return NextResponse.json(
                    { error: 'Naming failed', detail: error instanceof Error ? error.message : 'unknown error' },
                    { status: 502 }
                )
            }
        } catch (error) {
            console.error('Failed to auto-name conversation', error)
            return NextResponse.json({ error: 'Failed to auto-name conversation' }, { status: 500 })
        }
  })
}
