import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { disconnectGoogleDrive } from '@/lib/integrations/google-drive'

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const googleDrive = await disconnectGoogleDrive()
        return NextResponse.json({ success: true, googleDrive })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Could not disconnect Google Drive' },
            { status: 500 }
        )
    }
}
