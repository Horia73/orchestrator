import { NextResponse } from 'next/server'
import { listVersionsForIdentifier } from '@/lib/artifacts/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * GET /api/artifacts/identifier/:conversationId/:identifier
 *
 * Returns every version of one artifact identifier in a conversation, oldest
 * first. Powers the side-panel version dropdown — the UI picks
 * versions[versions.length - 1] as the default but can show any.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ conversationId: string; identifier: string }> }
) {
  return runWithRequestProfile(_request, async () => {
        const { conversationId, identifier } = await params
        const versions = listVersionsForIdentifier(conversationId, identifier)
        return NextResponse.json({ versions })
  })
}
