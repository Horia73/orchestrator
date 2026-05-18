import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { startGoogleDriveOAuth } from '@/lib/integrations/google-drive'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const origin = resolveRequestOrigin(request)
        return NextResponse.json(startGoogleDriveOAuth(origin))
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not start Google Drive OAuth' },
            { status: 400 }
        )
    }
}
