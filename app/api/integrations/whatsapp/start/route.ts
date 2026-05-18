import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { startWhatsApp } from '@/lib/integrations/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const origin = new URL(request.url).origin
        const result = await startWhatsApp(origin)
        return NextResponse.json(result)
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not start WhatsApp.' },
            { status: 400 }
        )
    }
}
