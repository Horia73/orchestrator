import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { forkInboxToConversation } from '@/lib/scheduling/store'

// "Reply" forks the read-only inbox transcript into a normal, continuable chat.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const { id } = await params
        const conversationId = forkInboxToConversation(id)
        if (!conversationId) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        return NextResponse.json({ conversationId })
    } catch (error) {
        console.error('Failed to reply to inbox item', error)
        return NextResponse.json({ error: 'Failed to reply to inbox item' }, { status: 500 })
    }
}
