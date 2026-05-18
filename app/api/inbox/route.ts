import { NextResponse } from 'next/server'
import { countUnreadInbox, listInboxConversations } from '@/lib/scheduling/store'

export async function GET() {
    try {
        return NextResponse.json({
            items: listInboxConversations(),
            unread: countUnreadInbox(),
        })
    } catch (error) {
        console.error('Failed to list inbox', error)
        return NextResponse.json({ error: 'Failed to list inbox' }, { status: 500 })
    }
}
