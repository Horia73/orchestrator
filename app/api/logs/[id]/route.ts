import { NextResponse } from 'next/server'
import { getRequestLog, getToolLogsForRequest } from '@/lib/observability/store'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const log = getRequestLog(id)
    if (!log) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const toolLogs = getToolLogsForRequest(id)
    return NextResponse.json({ log, toolLogs })
}
