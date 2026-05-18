import { NextResponse } from 'next/server'
import { LogsQuerySchema } from '@/lib/observability/schema'
import { queryLogs, clearAllLogs, getFilterOptions } from '@/lib/observability/store'

export async function GET(request: Request) {
    const url = new URL(request.url)
    const parsed = LogsQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 })
    }
    const page = queryLogs(parsed.data)
    const filters = getFilterOptions()
    return NextResponse.json({ ...page, filters })
}

export async function DELETE() {
    const result = clearAllLogs()
    return NextResponse.json(result)
}
