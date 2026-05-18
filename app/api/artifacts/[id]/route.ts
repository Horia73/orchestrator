import { NextResponse } from 'next/server'
import { getArtifactById } from '@/lib/artifacts/store'

/** GET /api/artifacts/:id — fetch a single artifact row by its stable UUID. */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params
    const row = getArtifactById(id)
    if (!row) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(row)
}
