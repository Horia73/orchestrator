import { NextResponse } from 'next/server'
import { getBackgroundJob, killBackgroundJob } from '@/lib/ai/background-jobs'
import { serializeBackgroundJob } from '@/lib/background-jobs-api'
import { runWithRequestProfile } from '@/lib/profiles/server'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params
        // A user-initiated kill is deliberate — no completion wake (default).
        const result = await killBackgroundJob(id)
        if (!result.ok) {
            const job = getBackgroundJob(id)
            const status = job ? 409 : 404
            return NextResponse.json({ error: result.error || 'Could not stop the job' }, { status })
        }
        const job = getBackgroundJob(id)
        return NextResponse.json({ ok: true, job: job ? serializeBackgroundJob(job) : null })
    })
}
