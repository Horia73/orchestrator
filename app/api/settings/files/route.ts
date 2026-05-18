import { NextResponse } from 'next/server'

import { AGENT_WORKSPACE_DIR } from '@/lib/config'
import { ensureWorkspaceTemplates, listWorkspaceFiles } from '@/lib/settings/workspace-files'

export async function GET() {
    try {
        ensureWorkspaceTemplates()
        return NextResponse.json(
            { files: listWorkspaceFiles(), workspaceRoot: AGENT_WORKSPACE_DIR },
            { headers: { 'Cache-Control': 'no-store' } }
        )
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to list files' },
            { status: 500 }
        )
    }
}
