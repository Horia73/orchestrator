import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectWhatsApp } from '@/lib/integrations/whatsapp'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
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
  })
}
