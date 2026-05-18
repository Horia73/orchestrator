import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { createScheduledTask, listScheduledTasks } from '@/lib/scheduling/store'

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || name === 'InvalidScheduleError'
}

export async function GET() {
    try {
        return NextResponse.json({ tasks: listScheduledTasks() })
    } catch (error) {
        console.error('Failed to list scheduled tasks', error)
        return NextResponse.json({ error: 'Failed to list scheduled tasks' }, { status: 500 })
    }
}

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const body = await request.json()
        const task = createScheduledTask(body)
        return NextResponse.json({ task })
    } catch (error) {
        if (isBadInput(error)) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Invalid task' },
                { status: 400 },
            )
        }
        console.error('Failed to create scheduled task', error)
        return NextResponse.json({ error: 'Failed to create scheduled task' }, { status: 500 })
    }
}
