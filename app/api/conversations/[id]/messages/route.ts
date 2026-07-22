import { NextResponse } from "next/server"
import {
  addMessage,
  getConversationMessagesPage,
  type MessagePageCursor,
} from "@/lib/db"
import type { Message } from "@/lib/types"
import { runWithRequestProfile } from "@/lib/profiles/server"
import { protectUserMessage } from "@/lib/secrets/store"

const DEFAULT_MESSAGE_PAGE_SIZE = 80
const MAX_MESSAGE_PAGE_SIZE = 200
const DEFAULT_FULL_TAIL_SIZE = 0
const MAX_FULL_TAIL_SIZE = 40

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, MAX_MESSAGE_PAGE_SIZE)
}

function parseBoundedInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function parseCursor(value: string | null): MessagePageCursor | null {
  if (!value) return null
  const [timestampValue, ...idParts] = value.split(":")
  const timestamp = Number.parseInt(timestampValue ?? "", 10)
  const id = idParts.join(":")
  if (!Number.isFinite(timestamp) || !id) return null
  return { timestamp, id }
}

function serializeCursor(cursor: MessagePageCursor | null): string | null {
  return cursor ? `${cursor.timestamp}:${cursor.id}` : null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
      try {
        const { id } = await params
        const { searchParams } = new URL(request.url)
        const limit = parsePositiveInt(
          searchParams.get("limit"),
          DEFAULT_MESSAGE_PAGE_SIZE
        )
        const before = parseCursor(searchParams.get("before"))
        const detail = searchParams.get("detail")
        const hydration =
          detail === "full" || detail === "mixed" ? detail : "slim"
        const fullTail = parseBoundedInt(
          searchParams.get("fullTail"),
          DEFAULT_FULL_TAIL_SIZE,
          MAX_FULL_TAIL_SIZE
        )
        const page = getConversationMessagesPage(id, {
          limit,
          before,
          hydration,
          fullTail,
        })

        return NextResponse.json({
          messages: page.messages,
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: serializeCursor(page.nextCursor),
        })
      } catch (error) {
        console.error("Failed to fetch messages", error)
        return NextResponse.json(
          { error: "Failed to fetch messages" },
          { status: 500 }
        )
      }
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
      try {
        const { id } = await params
        const message: Message = await request.json()
        const hasText =
          typeof message.content === "string" && message.content.length > 0
        const hasAttachments =
          Array.isArray(message.attachments) && message.attachments.length > 0
        if (!message.id || !message.role || (!hasText && !hasAttachments)) {
          return NextResponse.json(
            { error: "Invalid message data" },
            { status: 400 }
          )
        }

        const protectedMessage = protectUserMessage(message).message
        addMessage(id, protectedMessage)
        return NextResponse.json({ success: true, message: protectedMessage })
      } catch (error) {
        console.error("Failed to add message", error)
        return NextResponse.json(
          { error: "Failed to add message" },
          { status: 500 }
        )
      }
  })
}
