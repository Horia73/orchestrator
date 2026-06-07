import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { importWorkspaceMemoryBundle } from '@/lib/settings/workspace-files'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json(
                { error: 'Invalid JSON body.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }

        try {
            const result = importWorkspaceMemoryBundle(body)
            return NextResponse.json(
                { success: true, ...result },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to import memory.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }
  })
}
