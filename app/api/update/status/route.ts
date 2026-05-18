import { NextResponse } from 'next/server'

import { getUpdateStatus } from '@/lib/update/manager'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    const url = new URL(request.url)
    const refresh = url.searchParams.get('refresh') === '1'
    const status = await getUpdateStatus({ refresh })
    return NextResponse.json(status, {
        headers: { 'Cache-Control': 'no-store' },
    })
}
