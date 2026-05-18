import { NextResponse } from 'next/server'

import { getWatchlistWithQuotes } from '@/lib/watchlist/provider'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        const result = await getWatchlistWithQuotes({ force: url.searchParams.get('force') === '1' })
        return NextResponse.json(result, { headers: NO_STORE })
    } catch (error) {
        console.error('Failed to load watchlist quotes', error)
        return NextResponse.json({ error: 'Failed to load watchlist quotes' }, { status: 500, headers: NO_STORE })
    }
}
