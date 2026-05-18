import { NextResponse } from 'next/server'
import { listTaskRuns } from '@/lib/scheduling/store'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        return NextResponse.json({ runs: listTaskRuns(id) })
    } catch (error) {
        console.error('Failed to list task runs', error)
        return NextResponse.json({ error: 'Failed to list task runs' }, { status: 500 })
    }
}
