import { NextResponse } from "next/server"

import { addMessage, getConversation } from "@/lib/db"
import type { Message } from "@/lib/types"
import { getActiveChatStream } from "@/lib/chat-streams"
import { enqueueFollowUp, peekFollowUps } from "@/lib/chat-followups"
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * Steering: accept a follow-up user message while a turn is still streaming.
 *
 * The message is persisted immediately (so it renders in the conversation in
 * order) and queued; it runs as the NEXT turn as soon as the in-flight one
 * finishes — drained by the connected client (live streaming) or by the
 * server-side sweep if the client vanished mid-run.
 *
 * If no stream is active by the time the request lands (the run finished in
 * the meantime), nothing is persisted or queued: the client falls back to a
 * normal send, which persists the message through the regular path.
 */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
    let body: { conversationId?: unknown; message?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
    }

    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : ""
    const message = (body.message ?? null) as Message | null
    const hasText =
      typeof message?.content === "string" && message.content.trim().length > 0
    const hasAttachments =
      Array.isArray(message?.attachments) && message.attachments.length > 0
    if (
      !conversationId ||
      !message?.id ||
      message.role !== "user" ||
      (!hasText && !hasAttachments)
    ) {
      return NextResponse.json({ error: "Invalid steer payload" }, { status: 400 })
    }
    if (!getConversation(conversationId)) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
    }

    const active = getActiveChatStream(conversationId)
    if (!active) {
      // Turn already finished — client should send normally instead.
      return NextResponse.json({ queued: false, active: false })
    }

    // Idempotent for flaky-mobile retries: the same message id re-queued is a
    // no-op that reports the existing entry.
    const existing = peekFollowUps(conversationId).find(
      (entry) => entry.userMessageId === message.id
    )
    if (existing) {
      return NextResponse.json({
        queued: true,
        active: true,
        followUpId: existing.id,
      })
    }

    addMessage(conversationId, {
      ...message,
      timestamp:
        typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    })
    enqueueFollowUp(conversationId, {
      id: message.id,
      userMessageId: message.id,
      content: typeof message.content === "string" ? message.content : "",
      attachments: Array.isArray(message.attachments)
        ? message.attachments
        : undefined,
      source: "user",
      queuedAt: Date.now(),
    })

    return NextResponse.json({ queued: true, active: true, followUpId: message.id })
  })
}
