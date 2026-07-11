import { NextResponse } from 'next/server'
import { listBackgroundJobs } from '@/lib/ai/background-jobs'
import { serializeBackgroundJob } from '@/lib/background-jobs-api'
import { runWithRequestProfile } from '@/lib/profiles/server'

export async function GET(request: Request) {
    return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const conversationId = url.searchParams.get('conversationId') || undefined
        const runningOnly = url.searchParams.get('runningOnly') === '1'
        const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10)
        const jobs = listBackgroundJobs({
            conversationId,
            runningOnly,
            limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        })
        return NextResponse.json({ jobs: jobs.map(serializeBackgroundJob) })
    })
}
