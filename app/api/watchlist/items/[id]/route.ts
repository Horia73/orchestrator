import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getWatchlistItem, removeWatchlistItem, updateWatchlistItem } from '@/lib/watchlist/store'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const item = getWatchlistItem(decodeURIComponent(id))
    if (!item) {
        return NextResponse.json({ error: 'Watchlist item not found' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ item }, { headers: NO_STORE })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { id } = await params
    try {
        const body = await request.json()
        const item = updateWatchlistItem(decodeURIComponent(id), {
            name: typeof body.name === 'string' ? body.name : undefined,
            tradingViewSymbol: typeof body.tradingViewSymbol === 'string' ? body.tradingViewSymbol : undefined,
            notes: typeof body.notes === 'string' ? body.notes : undefined,
            sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
        })
        if (!item) {
            return NextResponse.json({ error: 'Watchlist item not found' }, { status: 404, headers: NO_STORE })
        }
        return NextResponse.json({ item }, { headers: NO_STORE })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update watchlist item'
        return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE })
    }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { id } = await params
    const deleted = removeWatchlistItem(decodeURIComponent(id))
    if (!deleted) {
        return NextResponse.json({ error: 'Watchlist item not found' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ deleted: true }, { headers: NO_STORE })
}
