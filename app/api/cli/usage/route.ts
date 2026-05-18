import { NextResponse } from 'next/server'
import { getAllCliQuotas } from '@/lib/cli/usage'

/** GET /api/cli/usage — 5-hour and weekly quota snapshots per CLI. */
export async function GET() {
    const snapshots = await getAllCliQuotas()
    return NextResponse.json(snapshots, {
        // Don't let Next.js cache this — both readers are live.
        headers: { 'Cache-Control': 'no-store' },
    })
}
