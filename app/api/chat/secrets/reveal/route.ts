import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getConversationMessage } from "@/lib/db"
import { runWithRequestProfile } from "@/lib/profiles/server"
import { revealMessageSecret } from "@/lib/secrets/store"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: {
      conversationId?: unknown
      messageId?: unknown
      secretId?: unknown
    }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      )
    }

    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : ""
    const messageId = typeof body.messageId === "string" ? body.messageId : ""
    const secretId = typeof body.secretId === "string" ? body.secretId : ""
    if (!conversationId || !messageId || !secretId) {
      return NextResponse.json(
        { error: "Missing conversationId, messageId, or secretId" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      )
    }

    const message = getConversationMessage(conversationId, messageId)
    const ref = message?.secretRefs?.find((item) => item.id === secretId)
    if (!message || message.role !== "user" || !ref) {
      return NextResponse.json(
        { error: "Secret not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    }

    const value = revealMessageSecret(messageId, secretId)
    if (value === null) {
      return NextResponse.json(
        { error: "Secret not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    }

    return NextResponse.json(
      { value },
      { headers: { "Cache-Control": "no-store, private" } }
    )
  })
}
