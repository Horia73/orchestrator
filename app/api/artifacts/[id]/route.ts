import { NextResponse } from 'next/server'
import { getArtifactByIdWithConversationOrigin } from '@/lib/artifacts/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/** GET /api/artifacts/:id — fetch a single artifact row by its stable UUID. */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(_request, async () => {
        const { id } = await params
        const row = getArtifactByIdWithConversationOrigin(id)
        if (!row) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        return NextResponse.json(row)
  })
}
