import { stopChatStream } from '@/lib/chat-streams'
import { clearFollowUps } from '@/lib/chat-followups'
import { runWithRequestProfile } from "@/lib/profiles/server"
import { proxyToDurableAiWorker, shouldProxyToDurableAiWorker } from '@/lib/ai/durable-worker'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        if (shouldProxyToDurableAiWorker()) return proxyToDurableAiWorker(request)
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
        // Stop means stop: queued steering follow-ups are dropped too. Their
        // user messages stay in the conversation and ride along as history on
        // the next manual send.
        clearFollowUps(conversationId)

        return new Response(JSON.stringify({ stopped }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            },
        })
  })
}
