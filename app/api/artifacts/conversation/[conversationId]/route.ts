import { NextResponse } from 'next/server'
import { listArtifactsForConversation, listLatestArtifactsForConversation } from '@/lib/artifacts/store'

/**
 * GET /api/artifacts/conversation/:conversationId
 *
 * Returns the artifact set for a conversation. Two modes:
 *   - default: all versions of every artifact (oldest → newest per identifier),
 *     for the panel's version dropdown
 *   - ?latest=1: only the latest version of each identifier, for the inline
 *     renderer's quick lookup
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ conversationId: string }> }
) {
    const { conversationId } = await params
    const url = new URL(request.url)
    const onlyLatest = url.searchParams.get('latest') === '1'

    const rows = onlyLatest
        ? listLatestArtifactsForConversation(conversationId)
        : listArtifactsForConversation(conversationId)

    return NextResponse.json({ artifacts: rows })
}
