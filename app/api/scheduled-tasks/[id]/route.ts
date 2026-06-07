import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { deleteScheduledTask, getScheduledTask, updateScheduledTask } from '@/lib/scheduling/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

function isBadInput(err: unknown): boolean {
    const name = (err as { name?: string })?.name
    return name === 'ZodError' || name === 'InvalidScheduleError'
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(_request, async () => {
        try {
            const { id } = await params
            const task = getScheduledTask(id)
            if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
            return NextResponse.json({ task })
        } catch (error) {
            console.error('Failed to get scheduled task', error)
            return NextResponse.json({ error: 'Failed to get scheduled task' }, { status: 500 })
        }
  })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const { id } = await params
            const body = await request.json()
            const task = updateScheduledTask(id, body)
            if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
            return NextResponse.json({ task })
        } catch (error) {
            if (isBadInput(error)) {
                return NextResponse.json(
                    { error: error instanceof Error ? error.message : 'Invalid task' },
                    { status: 400 },
                )
            }
            console.error('Failed to update scheduled task', error)
            return NextResponse.json({ error: 'Failed to update scheduled task' }, { status: 500 })
        }
  })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        try {
            const { id } = await params
            const deleted = deleteScheduledTask(id)
            if (!deleted) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
            return NextResponse.json({ success: true })
        } catch (error) {
            console.error('Failed to delete scheduled task', error)
            return NextResponse.json({ error: 'Failed to delete scheduled task' }, { status: 500 })
        }
  })
}
