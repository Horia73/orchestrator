import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { exportWorkspaceMemory } from '@/lib/settings/workspace-files'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const bundle = exportWorkspaceMemory()
            const stamp = new Date().toISOString().slice(0, 10)
            return new NextResponse(JSON.stringify(bundle, null, 2) + '\n', {
                headers: {
                    'Cache-Control': 'no-store',
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Disposition': `attachment; filename="orchestrator-memory-${stamp}.json"`,
                },
            })
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to export memory.' },
                { status: 500, headers: { 'Cache-Control': 'no-store' } }
            )
        }
  })
}
