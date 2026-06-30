import { NextResponse } from 'next/server'

import { activeRuntimePaths } from '@/lib/runtime-paths'
import { ensureWorkspaceTemplates, listWorkspaceFiles } from '@/lib/settings/workspace-files'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        try {
            ensureWorkspaceTemplates()
            return NextResponse.json(
                { files: listWorkspaceFiles(), workspaceRoot: activeRuntimePaths().agentWorkspaceDir },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to list files' },
                { status: 500 }
            )
        }
  })
}
