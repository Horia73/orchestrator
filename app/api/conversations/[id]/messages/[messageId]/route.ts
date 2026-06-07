import { NextResponse } from "next/server"
import { getConversationMessage } from "@/lib/db"
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  return runWithRequestProfile(request, async () => {
      try {
        const { id, messageId } = await params
        const message = getConversationMessage(id, messageId)
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
