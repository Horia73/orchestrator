import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { saveGoogleCalendarOAuthConfig } from '@/lib/integrations/google-calendar'

const ConfigBodySchema = z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().optional(),
    rawEnv: z.string().optional(),
})

export async function PUT(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = ConfigBodySchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid Google Calendar config', issues: parsed.error.issues }, { status: 400 })
    }

    try {
        const origin = new URL(request.url).origin
        const googleCalendar = await saveGoogleCalendarOAuthConfig(origin, parsed.data)
        return NextResponse.json({ success: true, googleCalendar })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not save Google Calendar OAuth config' },
            { status: 400 }
        )
    }
}
