import { NextResponse } from 'next/server'
import { listMicroscripts } from '@/lib/microscripts/store'
import type { Microscript } from '@/lib/microscripts/schema'
import { runWithCookieProfile } from "@/lib/profiles/server"

function compactRow(script: Microscript) {
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
    }
}

export async function GET() {
  return runWithCookieProfile(async () => {
        try {
            const scripts = listMicroscripts().map(compactRow)
            return NextResponse.json({ scripts })
        } catch (error) {
            console.error('Failed to list microscripts', error)
            return NextResponse.json({ error: 'Failed to list microscripts' }, { status: 500 })
        }
  })
}
