import { NextResponse } from 'next/server'
import { countUnreadInbox } from '@/lib/scheduling/store'

// Lightweight endpoint polled by the sidebar badge.
export async function GET() {
    try {
        return NextResponse.json({ unread: countUnreadInbox() })
    } catch (error) {
        console.error('Failed to get inbox unread count', error)
        return NextResponse.json({ unread: 0 }, { status: 200 })
    }
}
