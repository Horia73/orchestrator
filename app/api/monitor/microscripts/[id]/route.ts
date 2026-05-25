import { NextResponse } from 'next/server'
import {
    getMicroscript,
    listMicroscriptEvents,
    listMicroscriptRuns,
} from '@/lib/microscripts/store'
import type { Microscript } from '@/lib/microscripts/schema'

function fullView(script: Microscript) {
    return {
        id: script.id,
        title: script.title,
        enabled: script.enabled,
        status: script.status,
        description: script.manifest.description,
        schedule: script.manifest.schedule,
        permission_count: script.manifest.permissions.length,
        next_run_at: script.nextRunAt,
        last_run_at: script.lastRunAt,
        last_run_status: script.lastRunStatus,
        last_run_error: script.lastRunError,
        run_count: script.runCount,
        consecutive_failures: script.consecutiveFailures,
        expires_at: script.manifest.stop.expiresAt,
        created_by: script.createdBy,
        created_at: script.createdAt,
        updated_at: script.updatedAt,
        code: script.code,
        code_hash: script.codeHash,
        manifest: script.manifest,
        state: script.state,
        runs: listMicroscriptRuns(script.id, 20),
        events: listMicroscriptEvents(script.id, 40),
    }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        const script = getMicroscript(id)
        if (!script) return NextResponse.json({ error: 'Microscript not found' }, { status: 404 })
        return NextResponse.json({ script: fullView(script) })
    } catch (error) {
        console.error('Failed to get microscript', error)
        return NextResponse.json({ error: 'Failed to get microscript' }, { status: 500 })
    }
}
