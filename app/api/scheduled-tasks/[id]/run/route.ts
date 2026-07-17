import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { runWithRequestProfile } from "@/lib/profiles/server"
import { proxyToDurableAiWorker, shouldProxyToDurableAiWorker } from '@/lib/ai/durable-worker'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard
        if (shouldProxyToDurableAiWorker()) return proxyToDurableAiWorker(request)

        try {
            const { id } = await params
            const { runTaskNow } = await import('@/lib/scheduling/scheduler')
            const result = await runTaskNow(id)
            const status = result.ok || result.conversationId
                ? 200
                : result.error === 'Task not found.'
                    ? 404
                    : result.error === 'Task is already running.'
                        ? 409
                        : result.error === 'Smart Monitor runs automatically; manual checks are disabled.'
                            ? 400
                            : 500
            return NextResponse.json(result, { status })
        } catch (error) {
            console.error('Failed to run scheduled task', error)
            return NextResponse.json({ error: 'Failed to run scheduled task' }, { status: 500 })
        }
  })
}
