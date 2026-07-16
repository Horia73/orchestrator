import { NextResponse } from "next/server"
import {
  getConversationMessage,
  getConversationMessageToolCall,
  getConversationMessageToolSummary,
} from "@/lib/db"
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  return runWithRequestProfile(request, async () => {
      try {
        const { id, messageId } = await params
        const url = new URL(request.url)
        const toolCallId = url.searchParams.get("toolCallId")
        if (toolCallId) {
          const toolCall = getConversationMessageToolCall(id, messageId, toolCallId)
          if (!toolCall) {
            return NextResponse.json({ error: "Tool call not found" }, { status: 404 })
          }
          return NextResponse.json({ toolCall })
        }

        const message = url.searchParams.get("detail") === "tool-summary"
          ? getConversationMessageToolSummary(id, messageId)
          : getConversationMessage(id, messageId)
        if (!message) {
          return NextResponse.json(
            { error: "Message not found" },
            { status: 404 }
          )
        }
        return NextResponse.json({ message })
      } catch (error) {
        console.error("Failed to fetch message details", error)
        return NextResponse.json(
          { error: "Failed to fetch message details" },
          { status: 500 }
        )
      }
  })
}
