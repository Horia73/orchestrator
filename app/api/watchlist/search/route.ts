import { NextResponse } from 'next/server'

import { searchWatchlistItems } from '@/lib/watchlist/provider'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        const q = url.searchParams.get('q') ?? ''
        const result = await searchWatchlistItems(q)
        return NextResponse.json(result, { headers: NO_STORE })
    } catch (error) {
        console.error('Failed to search watchlist instruments', error)
        return NextResponse.json({ error: 'Failed to search watchlist instruments' }, { status: 500, headers: NO_STORE })
    }
}
