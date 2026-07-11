import type { BackgroundJobRow } from '@/lib/ai/background-jobs'

/** Wire shape for /api/background-jobs — shared by the routes and the client UI. */
export interface BackgroundJobApiRow {
    id: string
    conversationId: string | null
    command: string
    description: string | null
    status: BackgroundJobRow['status']
    exitCode: number | null
    runner: BackgroundJobRow['runner']
    wakeOnExit: boolean
    startedAt: number
    endedAt: number | null
}

export function serializeBackgroundJob(job: BackgroundJobRow): BackgroundJobApiRow {
    return {
        id: job.id,
        conversationId: job.conversationId,
        command: job.command,
        description: job.description,
        status: job.status,
        exitCode: job.exitCode,
        runner: job.runner,
        wakeOnExit: Boolean(job.wakeOnExit),
        startedAt: job.startedAt,
        endedAt: job.endedAt,
    }
}
