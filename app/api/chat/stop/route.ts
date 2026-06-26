import { stopChatStream } from '@/lib/chat-streams'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        let body: { conversationId?: string; messageId?: string }
        try {
            body = await request.json()
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid request body' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const conversationId = body.conversationId
        if (!conversationId) {
            return new Response(JSON.stringify({ error: 'Missing conversationId' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const messageId = typeof body.messageId === 'string' && body.messageId.trim()
            ? body.messageId.trim()
            : undefined
        const stopped = stopChatStream(conversationId, messageId)

        return new Response(JSON.stringify({ stopped }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            },
        })
  })
}
