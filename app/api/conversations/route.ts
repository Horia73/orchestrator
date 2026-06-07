import { NextResponse } from "next/server"
import {
  getConversationsWithMessages,
  getConversationSummaries,
  createConversation,
} from "@/lib/db"
import type { Conversation } from "@/lib/types"
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      try {
        const { searchParams } = new URL(request.url)
        const summary = searchParams.get("summary") === "1"
        const q = searchParams.get("q") ?? undefined
        const archived = searchParams.get("archived") === "1"
        const conversations = summary
          ? getConversationSummaries(q, archived)
          : getConversationsWithMessages()
        return NextResponse.json(conversations)
      } catch (error) {
        console.error("Failed to fetch conversations", error)
        return NextResponse.json(
          { error: "Failed to fetch conversations" },
          { status: 500 }
        )
      }
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      try {
        const conversation: Conversation = await request.json()
        if (!conversation.id || !conversation.title) {
          return NextResponse.json(
            { error: "Invalid conversation data" },
            { status: 400 }
          )
        }
        createConversation(conversation)
        return NextResponse.json({ success: true, conversation })
      } catch (error) {
        console.error("Failed to create conversation", error)
        return NextResponse.json(
          { error: "Failed to create conversation" },
          { status: 500 }
        )
      }
  })
}
