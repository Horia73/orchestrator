import { getActiveChatStream } from '@/lib/chat-streams'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversationId')

    if (!conversationId) {
        return new Response(JSON.stringify({ error: 'Missing conversationId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const active = getActiveChatStream(conversationId)

    return new Response(
        JSON.stringify({
            active: !!active,
            messageId: active?.messageId,
            startedAt: active?.startedAt,
        }),
        {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            },
        }
    )
}
