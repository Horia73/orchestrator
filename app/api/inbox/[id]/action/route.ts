import { NextResponse } from "next/server"
import { randomUUID } from "crypto"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  executeGmailArchive,
  executeGmailMarkRead,
  executeGmailMarkUnread,
} from "@/lib/ai/tools/gmail"
import {
  executeWhatsAppMarkChatRead,
  executeWhatsAppMarkChatUnread,
} from "@/lib/ai/tools/whatsapp"
import {
  appendInboxMessage,
  claimInboxDirectAction,
  getInboxConversation,
  logInboxDirectAction,
} from "@/lib/scheduling/store"
import type { InboxDirectAction, Message } from "@/lib/types"
import { runWithRequestProfile } from "@/lib/profiles/server"

interface ActionRequest {
  messageId: string
  actionId: string
}

function parseBody(value: unknown): ActionRequest | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const messageId =
    typeof raw.messageId === "string"
      ? raw.messageId.trim()
      : typeof raw.message_id === "string"
        ? (raw.message_id as string).trim()
        : ""
  const actionId =
    typeof raw.actionId === "string"
      ? raw.actionId.trim()
      : typeof raw.action_id === "string"
        ? (raw.action_id as string).trim()
        : ""
  if (!messageId || !actionId) return null
  return { messageId, actionId }
}

async function dispatch(direct: InboxDirectAction): Promise<{
  success: boolean
  data?: unknown
  error?: string
  label: string
}> {
  switch (direct.tool) {
    case "gmail.mark_read": {
      const r = await executeGmailMarkRead({
        target_type: "message",
        id: direct.messageId,
      })
      return { ...r, label: "Marked email as read" }
    }
    case "gmail.mark_unread": {
      const r = await executeGmailMarkUnread({
        target_type: "message",
        id: direct.messageId,
      })
      return { ...r, label: "Marked email as unread" }
    }
    case "gmail.archive": {
      const r = await executeGmailArchive({
        target_type: "message",
        id: direct.messageId,
      })
      return { ...r, label: "Archived email" }
    }
    case "whatsapp.mark_chat_read": {
      const r = await executeWhatsAppMarkChatRead({ chat_id: direct.chatId })
      return { ...r, label: "Marked WhatsApp chat as read" }
    }
    case "whatsapp.mark_chat_unread": {
      const r = await executeWhatsAppMarkChatUnread({ chat_id: direct.chatId })
      return { ...r, label: "Marked WhatsApp chat as unread on phone" }
    }
  }
}

function describeTarget(direct: InboxDirectAction): {
  sourceKind: "gmail" | "whatsapp"
  sourceTarget: string
} {
  switch (direct.tool) {
    case "gmail.mark_read":
    case "gmail.mark_unread":
    case "gmail.archive":
      return { sourceKind: "gmail", sourceTarget: direct.messageId }
    case "whatsapp.mark_chat_read":
    case "whatsapp.mark_chat_unread":
      return { sourceKind: "whatsapp", sourceTarget: direct.chatId }
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      try {
        const { id } = await params
        const raw = await request.text()
        const parsed = raw.trim() ? parseBody(JSON.parse(raw)) : null
        if (!parsed) {
          return NextResponse.json(
            { error: "messageId and actionId are required" },
            { status: 400 }
          )
        }

        const inbox = getInboxConversation(id)
        if (!inbox) {
          return NextResponse.json(
            { error: "Inbox item not found" },
            { status: 404 }
          )
        }

        const action = claimInboxDirectAction(id, parsed.messageId, parsed.actionId)
        if (!action || !action.directAction) {
          return NextResponse.json(
            { error: "Action is not available or already used" },
            { status: 409 }
          )
        }

        const direct = action.directAction
        const result = await dispatch(direct)
        const target = describeTarget(direct)

        const note: Message = {
          id: `msg_${randomUUID()}`,
          role: "assistant",
          content: result.success
            ? `${result.label}.`
            : `Could not ${result.label.toLowerCase()}: ${result.error ?? "unknown error"}`,
          status: result.success ? "ok" : "error",
          timestamp: Date.now(),
        }
        appendInboxMessage(id, note)

        logInboxDirectAction({
          conversationId: id,
          messageId: parsed.messageId,
          actionId: parsed.actionId,
          tool: direct.tool,
          params: { [target.sourceKind === "gmail" ? "messageId" : "chatId"]: target.sourceTarget },
          result: result.success ? "ok" : "error",
          sourceKind: target.sourceKind,
          sourceTarget: target.sourceTarget,
          errorMessage: result.success ? null : result.error ?? null,
        })

        return NextResponse.json({
          item: getInboxConversation(id),
          action: {
            id: parsed.actionId,
            label: result.label,
            success: result.success,
            error: result.success ? null : result.error ?? null,
          },
        })
      } catch (error) {
        console.error("Failed to execute inbox direct action", error)
        return NextResponse.json(
          { error: "Failed to execute inbox action" },
          { status: 500 }
        )
      }
  })
}
