import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getWhatsAppQrPng } from '@/lib/integrations/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const png = await getWhatsAppQrPng()
    if (!png) {
        return NextResponse.json({ error: 'No WhatsApp QR is currently available.' }, { status: 404 })
    }

    return new NextResponse(new Uint8Array(png), {
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
        },
    })
}
