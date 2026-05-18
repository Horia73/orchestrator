import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectWhatsApp } from '@/lib/integrations/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        await disconnectWhatsApp()
        return NextResponse.json({ success: true })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not disconnect WhatsApp.' },
            { status: 500 }
        )
    }
}
