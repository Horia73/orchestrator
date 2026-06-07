import { NextResponse } from 'next/server'
import { countUnreadInbox } from '@/lib/scheduling/store'
import { runWithCookieProfile } from "@/lib/profiles/server"

// Lightweight endpoint polled by the sidebar badge.
export async function GET() {
  return runWithCookieProfile(async () => {
        try {
            return NextResponse.json({ unread: countUnreadInbox() })
        } catch (error) {
            console.error('Failed to get inbox unread count', error)
            return NextResponse.json({ unread: 0 }, { status: 200 })
        }
  })
}
