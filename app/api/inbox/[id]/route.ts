import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  deleteInboxConversation,
  getInboxConversation,
  markInboxRead,
} from "@/lib/scheduling/store"

// Opening an inbox item marks it read.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const { id } = await params
    const item = getInboxConversation(id)
    if (!item)
      return NextResponse.json(
        { error: "Inbox item not found" },
        { status: 404 }
      )
    const readAt = markInboxRead(id)
    return NextResponse.json({
      item: { ...item, readAt: readAt ?? item.readAt ?? Date.now() },
    })
  } catch (error) {
    console.error("Failed to get inbox item", error)
    return NextResponse.json(
      { error: "Failed to get inbox item" },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const { id } = await params
    const deleted = deleteInboxConversation(id)
    if (!deleted)
      return NextResponse.json(
        { error: "Inbox item not found" },
        { status: 404 }
      )
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to delete inbox item", error)
    return NextResponse.json(
      { error: "Failed to delete inbox item" },
      { status: 500 }
    )
  }
}
