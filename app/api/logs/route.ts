import { NextResponse } from 'next/server'
import { LogsQuerySchema } from '@/lib/observability/schema'
import {
    clearAllLogsAcrossProfiles,
    getFilterOptionsAcrossProfiles,
    queryLogsAcrossProfiles,
} from '@/lib/observability/profile-store'
import { runWithAdminCookieProfile, runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const parsed = LogsQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
            return NextResponse.json({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 })
        }
        const page = queryLogsAcrossProfiles(parsed.data)
        const filters = getFilterOptionsAcrossProfiles()
        return NextResponse.json({ ...page, filters })
  })
}

export async function DELETE() {
  return runWithAdminCookieProfile(async () => {
        const result = clearAllLogsAcrossProfiles()
        return NextResponse.json(result)
  })
}
