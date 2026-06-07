import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { applyBackupRestore } from '@/lib/settings/backup'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let buffer: Buffer
        try {
            const body = await request.arrayBuffer()
            buffer = Buffer.from(body)
        } catch {
            return NextResponse.json(
                { error: 'Could not read the uploaded backup.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }

        if (buffer.byteLength === 0) {
            return NextResponse.json(
                { error: 'The uploaded backup is empty.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }

        try {
            const result = await applyBackupRestore(buffer)
            return NextResponse.json(
                { success: true, ...result },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to restore backup.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }
  })
}
