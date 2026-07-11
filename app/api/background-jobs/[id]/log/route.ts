import { NextResponse } from 'next/server'
import { getBackgroundJob, readBackgroundJobLogTail } from '@/lib/ai/background-jobs'
import { serializeBackgroundJob } from '@/lib/background-jobs-api'
import { runWithRequestProfile } from '@/lib/profiles/server'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params
        const job = getBackgroundJob(id)
        if (!job) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        const url = new URL(request.url)
        const charsRaw = Number.parseInt(url.searchParams.get('chars') || '', 10)
        const chars = Number.isFinite(charsRaw)
            ? Math.min(Math.max(charsRaw, 200), 200_000)
            : 20_000
        return NextResponse.json({
            job: serializeBackgroundJob(job),
            tail: readBackgroundJobLogTail(job, chars),
        })
    })
}
