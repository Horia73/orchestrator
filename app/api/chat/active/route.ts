import { getActiveChatStream, listActiveChatStreams } from '@/lib/chat-streams'
import { peekFollowUpSnapshots } from '@/lib/chat-followups'
import { runWithRequestProfile } from "@/lib/profiles/server"
import { durableAiFleetActiveChatResponse, shouldProxyToDurableAiWorker } from '@/lib/ai/durable-worker'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        if (shouldProxyToDurableAiWorker()) return durableAiFleetActiveChatResponse(request)
        const { searchParams } = new URL(request.url)
        const conversationId = searchParams.get('conversationId')

        if (!conversationId) {
            const streams = listActiveChatStreams()

            return new Response(
                JSON.stringify({
                    active: streams.length > 0,
                    streams,
                    conversationIds: streams.map(stream => stream.conversationId),
                }),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store',
                    },
                }
            )
        }

        const active = getActiveChatStream(conversationId)
        const followUps = peekFollowUpSnapshots(conversationId).filter(
            entry => entry.source === 'user',
        )

        return new Response(
            JSON.stringify({
                active: !!active,
                messageId: active?.messageId,
                startedAt: active?.startedAt,
                followUps,
            }),
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                },
            }
        )
  })
}
