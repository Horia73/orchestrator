import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { getConversation } from '@/lib/db'
import {
    type WhatsAppOutgoingAttachment,
    whatsappDeleteMessageForEveryone,
    getWhatsAppIntegrationStatus,
    startWhatsApp,
    whatsappListChats,
    whatsappMarkChatRead,
    whatsappMarkChatUnread,
    whatsappReadChat,
    whatsappSearchMessages,
    whatsappSendMedia,
    whatsappSendMessage,
    whatsappUnreadSummary,
} from '@/lib/integrations/whatsapp'
import type { Attachment } from '@/lib/types'
import { resolveExistingUploadPath } from '@/lib/uploads'
import { booleanArg, clamp, numberArg, stringArg } from './helpers'
import { displayPath, isInsideProtectedAgentPath, resolveSandboxed } from './sandbox'

const MAX_WHATSAPP_MESSAGE_CHARS = 20_000
const MAX_WHATSAPP_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_WHATSAPP_TOTAL_ATTACHMENT_BYTES = 75 * 1024 * 1024

export const whatsappStatusTool: ToolDef = {
    id: 'WhatsAppStatus',
    name: 'WhatsAppStatus',
    description: 'Checks the local WhatsApp Web integration status, including whether a QR code is currently available and which confirmed write capabilities are enabled.',
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['read', 'whatsapp', 'setup'],
}

export const whatsappConnectTool: ToolDef = {
    id: 'WhatsAppConnect',
    name: 'WhatsAppConnect',
    description: [
        'Starts the local WhatsApp Web session and returns a QR image URL/markdown when login is needed.',
        'Use this when the user asks to configure, connect, reconnect, or scan WhatsApp.',
        'If qrMarkdown is present, show it directly in the final answer so the user can scan it from their phone.',
        'This setup tool never sends messages.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['read', 'whatsapp', 'setup'],
}

export const whatsappListChatsTool: ToolDef = {
    id: 'WhatsAppListChats',
    name: 'WhatsAppListChats',
    description: 'Lists recent WhatsApp chats from the connected local WhatsApp Web session. Does not send or mark chats handled.',
    input_schema: {
        type: 'object',
        properties: {
            max_results: {
                type: 'integer',
                description: 'Maximum chats to return. Defaults to 10 and is capped at 50.',
            },
        },
    },
    tags: ['read', 'whatsapp', 'messages'],
}

export const whatsappUnreadSummaryTool: ToolDef = {
    id: 'WhatsAppUnreadSummary',
    name: 'WhatsAppUnreadSummary',
    description: 'Returns the total unread WhatsApp count and unread chats from the connected local WhatsApp Web session. Does not read message bodies, send, or mark chats handled.',
    input_schema: {
        type: 'object',
        properties: {
            max_results: {
                type: 'integer',
                description: 'Maximum unread chats to return. Defaults to 50 and is capped at 50. The total unread count scans all chats returned by WhatsApp Web.',
            },
        },
    },
    tags: ['read', 'whatsapp', 'messages'],
}

export const whatsappReadChatTool: ToolDef = {
    id: 'WhatsAppReadChat',
    name: 'WhatsAppReadChat',
    description: [
        'Reads recent messages from one WhatsApp chat by chat_id returned by WhatsAppListChats.',
        'Each returned message includes authorName (sender display name for group messages; falls back to +phone, null for 1:1 or your own messages), isForwarded, and forwardingScore.',
        'Does not send or mark chats handled.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            chat_id: {
                type: 'string',
                description: 'WhatsApp chat ID, usually returned by WhatsAppListChats.',
            },
            max_messages: {
                type: 'integer',
                description: 'Maximum recent messages to return. Defaults to 30 and is capped at 100.',
            },
            max_chars: {
                type: 'integer',
                description: 'Maximum body characters across returned messages. Defaults to 30000.',
            },
        },
        required: ['chat_id'],
    },
    tags: ['read', 'whatsapp', 'messages'],
}

export const whatsappSearchMessagesTool: ToolDef = {
    id: 'WhatsAppSearchMessages',
    name: 'WhatsAppSearchMessages',
    description: 'Searches recent WhatsApp message bodies by scanning recent chats from the connected local WhatsApp Web session. This is not full account history search.',
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Case-insensitive text to search for in recent WhatsApp messages.',
            },
            chat_id: {
                type: 'string',
                description: 'Optional chat ID to restrict search to one chat.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum matching messages to return. Defaults to 10 and is capped at 50.',
            },
            max_chats: {
                type: 'integer',
                description: 'Maximum recent chats to scan when chat_id is omitted. Defaults to 20 and is capped at 50.',
            },
            per_chat_limit: {
                type: 'integer',
                description: 'Maximum recent messages to scan per chat. Defaults to 50 and is capped at 150.',
            },
        },
        required: ['query'],
    },
    tags: ['read', 'whatsapp', 'messages'],
}

export const whatsappSendMessageTool: ToolDef = {
    id: 'WhatsAppSendMessage',
    name: 'WhatsAppSendMessage',
    description: 'Sends a WhatsApp text message to a specific chat. Use only after the user explicitly approved the exact recipient/chat and exact message body.',
    input_schema: {
        type: 'object',
        properties: {
            chat_id: {
                type: 'string',
                description: 'WhatsApp chat ID, usually returned by WhatsAppListChats.',
            },
            body: {
                type: 'string',
                description: 'Exact text message body approved by the user.',
            },
            quoted_message_id: {
                type: 'string',
                description: 'Optional WhatsApp message ID to reply to.',
            },
            link_preview: {
                type: 'boolean',
                description: 'Optional link preview setting. Defaults to WhatsApp Web behavior.',
            },
            confirmed_by_user: {
                type: 'boolean',
                description: 'Must be true only after the user explicitly approves the exact chat and message body.',
            },
        },
        required: ['chat_id', 'body', 'confirmed_by_user'],
    },
    tags: ['write', 'whatsapp', 'messages', 'external_action'],
}

export const whatsappSendMediaTool: ToolDef = {
    id: 'WhatsAppSendMedia',
    name: 'WhatsAppSendMedia',
    description: 'Sends one or more workspace files or uploaded conversation attachments as WhatsApp media/documents. Use only after the user explicitly approved the exact recipient/chat, files, and caption.',
    input_schema: {
        type: 'object',
        properties: {
            chat_id: {
                type: 'string',
                description: 'WhatsApp chat ID, usually returned by WhatsAppListChats.',
            },
            attachments: {
                type: 'array',
                description: 'Files to attach. Each item may be a workspace path string, an uploaded attachment id string, or an object with path or upload_id. Each file is sent as a separate WhatsApp message; caption is applied to the first file only.',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace file path to attach.' },
                        upload_id: { type: 'string', description: 'Uploaded conversation attachment id, usually shown in the prompt as upload_id.' },
                        filename: { type: 'string', description: 'Optional filename shown to recipients.' },
                        content_type: { type: 'string', description: 'Optional MIME type. Defaults from file extension.' },
                        send_as_document: { type: 'boolean', description: 'Force sending as a document instead of inline media.' },
                    },
                },
            },
            caption: {
                type: 'string',
                description: 'Optional exact caption approved by the user. For multiple files, this caption is sent on the first file only.',
            },
            quoted_message_id: {
                type: 'string',
                description: 'Optional WhatsApp message ID to reply to.',
            },
            confirmed_by_user: {
                type: 'boolean',
                description: 'Must be true only after the user explicitly approves the exact chat, files, and caption.',
            },
        },
        required: ['chat_id', 'attachments', 'confirmed_by_user'],
    },
    tags: ['write', 'whatsapp', 'messages', 'filesystem', 'external_action'],
}

export const whatsappDeleteMessageTool: ToolDef = {
    id: 'WhatsAppDeleteMessageForEveryone',
    name: 'WhatsAppDeleteMessageForEveryone',
    description: 'Deletes a WhatsApp message for everyone. This is the only WhatsApp delete mode exposed. Use only after the user explicitly approved deleting that exact message for everyone.',
    input_schema: {
        type: 'object',
        properties: {
            message_id: {
                type: 'string',
                description: 'Exact WhatsApp message ID to delete for everyone.',
            },
            confirmed_by_user: {
                type: 'boolean',
                description: 'Must be true only after the user explicitly approves deleting this exact message for everyone.',
            },
        },
        required: ['message_id', 'confirmed_by_user'],
    },
    tags: ['write', 'whatsapp', 'messages', 'destructive', 'external_action'],
}

export const whatsappMarkChatReadTool: ToolDef = {
    id: 'WhatsAppMarkChatRead',
    name: 'WhatsAppMarkChatRead',
    description: [
        'Marks a WhatsApp chat as read on the connected device (clears the unread badge for that chat on the user\'s phone).',
        'Use only when the user explicitly asks to mark a chat as read, or when an Inbox quick-action requests it.',
        'Reading messages programmatically with WhatsAppReadChat does NOT mark them read — this tool is the only way to clear unread on WhatsApp.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            chat_id: {
                type: 'string',
                description: 'WhatsApp chat ID, usually returned by WhatsAppListChats or carried in monitor candidate details.',
            },
        },
        required: ['chat_id'],
    },
    tags: ['write', 'whatsapp', 'messages', 'external_action'],
}

export const whatsappMarkChatUnreadTool: ToolDef = {
    id: 'WhatsAppMarkChatUnread',
    name: 'WhatsAppMarkChatUnread',
    description: [
        'Marks a WhatsApp chat as unread on the connected device (restores the unread badge so the user sees it again on their phone).',
        'Use when the user wants a chat to remain visibly unread after the assistant has surfaced or summarized it, or when an Inbox quick-action requests it.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            chat_id: {
                type: 'string',
                description: 'WhatsApp chat ID, usually returned by WhatsAppListChats or carried in monitor candidate details.',
            },
        },
        required: ['chat_id'],
    },
    tags: ['write', 'whatsapp', 'messages', 'external_action'],
}

export const whatsappTools: ToolDef[] = [
    whatsappStatusTool,
    whatsappConnectTool,
    whatsappListChatsTool,
    whatsappUnreadSummaryTool,
    whatsappReadChatTool,
    whatsappSearchMessagesTool,
    whatsappSendMessageTool,
    whatsappSendMediaTool,
    whatsappDeleteMessageTool,
    whatsappMarkChatReadTool,
    whatsappMarkChatUnreadTool,
]

export async function executeWhatsAppStatus(
    _args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const status = await getWhatsAppIntegrationStatus(ctx?.appOrigin)
    return { success: true, data: status }
}

export async function executeWhatsAppConnect(
    _args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const result = await startWhatsApp(ctx?.appOrigin)
    return {
        success: true,
        data: {
            ...result,
            instruction: result.qrMarkdown
                ? 'Show qrMarkdown directly to the user and ask them to scan it from WhatsApp > Linked devices.'
                : result.status.connected
                    ? 'WhatsApp is connected.'
                    : 'WhatsApp is starting; call WhatsAppStatus again if no QR is visible yet.',
        },
    }
}

export async function executeWhatsAppListChats(args: Record<string, unknown>): Promise<ToolResult> {
    const maxResults = clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 10)), 1, 50)
    const result = await whatsappListChats(maxResults)
    return { success: true, data: result }
}

export async function executeWhatsAppUnreadSummary(args: Record<string, unknown>): Promise<ToolResult> {
    const maxResults = clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 50)), 1, 50)
    const result = await whatsappUnreadSummary(maxResults)
    return { success: true, data: result }
}

export async function executeWhatsAppReadChat(args: Record<string, unknown>): Promise<ToolResult> {
    const chatId = stringArg(args, ['chat_id', 'chatId'])
    if (!chatId) return { success: false, error: 'Missing required parameter: chat_id' }

    const maxMessages = clamp(Math.floor(numberArg(args, ['max_messages', 'maxMessages'], 30)), 1, 100)
    const maxChars = clamp(Math.floor(numberArg(args, ['max_chars', 'maxChars'], 30_000)), 2_000, 80_000)
    const result = await whatsappReadChat(chatId, maxMessages, maxChars)
    return { success: true, data: result }
}

export async function executeWhatsAppSearchMessages(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return { success: false, error: 'Missing required parameter: query' }

    const chatId = stringArg(args, ['chat_id', 'chatId'])
    const maxResults = clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 10)), 1, 50)
    const maxChats = clamp(Math.floor(numberArg(args, ['max_chats', 'maxChats'], 20)), 1, 50)
    const perChatLimit = clamp(Math.floor(numberArg(args, ['per_chat_limit', 'perChatLimit'], 50)), 1, 150)

    const result = await whatsappSearchMessages({
        query,
        chatId: chatId || undefined,
        maxResults,
        maxChats,
        perChatLimit,
    })
    return { success: true, data: result }
}

export async function executeWhatsAppSendMessage(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true after explicit user approval before sending a WhatsApp message.' }
    }

    const chatId = stringArg(args, ['chat_id', 'chatId'])
    if (!chatId) return { success: false, error: 'Missing required parameter: chat_id' }
    const body = stringArg(args, ['body', 'message', 'text'])
    if (!body.trim()) return { success: false, error: 'Missing required parameter: body' }
    if (body.length > MAX_WHATSAPP_MESSAGE_CHARS) {
        return { success: false, error: `WhatsApp message body is over ${MAX_WHATSAPP_MESSAGE_CHARS} characters. Ask the user to approve a shorter message or split it.` }
    }

    const result = await whatsappSendMessage(chatId, body, {
        quotedMessageId: stringArg(args, ['quoted_message_id', 'quotedMessageId']) || undefined,
        linkPreview: optionalBooleanArg(args, ['link_preview', 'linkPreview']),
    })
    return { success: true, data: result }
}

export async function executeWhatsAppSendMedia(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true after explicit user approval before sending WhatsApp media/files.' }
    }

    const chatId = stringArg(args, ['chat_id', 'chatId'])
    if (!chatId) return { success: false, error: 'Missing required parameter: chat_id' }

    const attachments = parseOutgoingAttachments(args, ctx)
    if (!attachments.ok) return attachments.error
    const caption = stringArg(args, ['caption'])
    if (caption.length > MAX_WHATSAPP_MESSAGE_CHARS) {
        return { success: false, error: `WhatsApp caption is over ${MAX_WHATSAPP_MESSAGE_CHARS} characters. Ask the user to approve a shorter caption.` }
    }

    const result = await whatsappSendMedia(chatId, attachments.value, caption || undefined, {
        quotedMessageId: stringArg(args, ['quoted_message_id', 'quotedMessageId']) || undefined,
    })
    return {
        success: true,
        data: {
            ...result,
            files: attachments.value.map(attachment => ({
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.bytes.byteLength,
                sendAsDocument: attachment.sendAsDocument,
            })),
        },
    }
}

export async function executeWhatsAppDeleteMessageForEveryone(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true after explicit user approval before deleting a WhatsApp message for everyone.' }
    }

    const messageId = stringArg(args, ['message_id', 'messageId', 'id'])
    if (!messageId) return { success: false, error: 'Missing required parameter: message_id' }

    const result = await whatsappDeleteMessageForEveryone(messageId)
    return { success: true, data: result }
}

export async function executeWhatsAppMarkChatRead(args: Record<string, unknown>): Promise<ToolResult> {
    const chatId = stringArg(args, ['chat_id', 'chatId'])
    if (!chatId) return { success: false, error: 'Missing required parameter: chat_id' }
    const result = await whatsappMarkChatRead(chatId)
    return { success: true, data: result }
}

export async function executeWhatsAppMarkChatUnread(args: Record<string, unknown>): Promise<ToolResult> {
    const chatId = stringArg(args, ['chat_id', 'chatId'])
    if (!chatId) return { success: false, error: 'Missing required parameter: chat_id' }
    const result = await whatsappMarkChatUnread(chatId)
    return { success: true, data: result }
}

interface ParsedAttachmentInput {
    path?: string
    uploadId?: string
    filename?: string
    contentType?: string
    sendAsDocument?: boolean
}

interface ResolvedAttachmentInput {
    resolved: string
    display: string
    defaultFilename?: string
    defaultContentType?: string
}

function parseOutgoingAttachments(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
):
    | { ok: true; value: WhatsAppOutgoingAttachment[] }
    | { ok: false; error: ToolResult } {
    const raw = args.attachments ?? args.files
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: { success: false, error: 'attachments must be a non-empty array.' } }
    }

    const attachments: WhatsAppOutgoingAttachment[] = []
    let totalBytes = 0

    for (const [index, item] of raw.entries()) {
        const parsed = parseAttachmentInput(item)
        if (!parsed.ok) {
            return { ok: false, error: { success: false, error: `Invalid attachment at index ${index}: ${parsed.error}` } }
        }

        const resolved = resolveAttachmentInput(parsed, ctx)
        if (!resolved.ok) return { ok: false, error: { success: false, error: resolved.error } }

        let stat: fs.Stats
        try {
            stat = fs.statSync(resolved.resolved)
        } catch {
            return { ok: false, error: { success: false, error: `Attachment file does not exist: ${resolved.display}` } }
        }

        if (!stat.isFile()) return { ok: false, error: { success: false, error: `Attachment path is not a file: ${resolved.display}` } }
        if (stat.size <= 0) return { ok: false, error: { success: false, error: `Attachment file is empty: ${resolved.display}` } }
        if (stat.size > MAX_WHATSAPP_ATTACHMENT_BYTES) {
            return { ok: false, error: { success: false, error: `WhatsApp attachment is over 25MB: ${resolved.display}` } }
        }

        totalBytes += stat.size
        if (totalBytes > MAX_WHATSAPP_TOTAL_ATTACHMENT_BYTES) {
            return { ok: false, error: { success: false, error: 'Total WhatsApp attachment size is capped at 75MB per send.' } }
        }

        const filename = safeFilename(parsed.filename || resolved.defaultFilename || path.basename(resolved.resolved))
        const mimeType = normalizeMimeType(parsed.contentType || resolved.defaultContentType || inferMimeType(filename))
        attachments.push({
            filename,
            mimeType,
            bytes: fs.readFileSync(resolved.resolved),
            sendAsDocument: parsed.sendAsDocument ?? shouldSendAsDocument(mimeType),
        })
    }

    return { ok: true, value: attachments }
}

function parseAttachmentInput(value: unknown): { ok: true } & ParsedAttachmentInput | { ok: false; error: string } {
    if (typeof value === 'string' && value.trim()) {
        return { ok: true, path: value.trim() }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'expected a workspace path/upload id string or an object with path or upload_id.' }
    }
    const record = value as Record<string, unknown>
    const filePath = firstString(record, ['path', 'file_path', 'filePath'])
    const uploadId = firstString(record, ['upload_id', 'uploadId', 'attachment_id', 'attachmentId', 'id'])
    const filename = firstString(record, ['filename', 'name']) || undefined
    if (!filePath && !uploadId && !filename) return { ok: false, error: 'missing path or upload_id.' }
    return {
        ok: true,
        path: filePath || undefined,
        uploadId: uploadId || undefined,
        filename,
        contentType: firstString(record, ['content_type', 'contentType', 'mime_type', 'mimeType']) || undefined,
        sendAsDocument: optionalBooleanArg(record, ['send_as_document', 'sendAsDocument']),
    }
}

function resolveAttachmentInput(
    parsed: ParsedAttachmentInput,
    ctx?: ToolExecutionContext
): { ok: true } & ResolvedAttachmentInput | { ok: false; error: string } {
    if (parsed.uploadId) {
        const upload = resolveUploadById(parsed.uploadId, ctx)
        if (!upload) {
            const fallback = resolveConversationUploadByLabel([parsed.uploadId, parsed.filename, parsed.path], ctx)
            if (fallback.kind === 'found') return { ok: true, ...fallback.value }
            if (fallback.kind === 'ambiguous') return { ok: false, error: fallback.error }
            return { ok: false, error: `Uploaded attachment is no longer available: ${parsed.uploadId}` }
        }
        return { ok: true, ...upload }
    }

    if (parsed.path) {
        const directUpload = resolveUploadReference(parsed.path, ctx)
        if (directUpload) return { ok: true, ...directUpload }

        const sandboxed = resolveSandboxed(parsed.path)
        if (!sandboxed.ok) {
            const fallback = resolveConversationUploadByLabel([parsed.path, parsed.filename], ctx)
            if (fallback.kind === 'found') return { ok: true, ...fallback.value }
            if (fallback.kind === 'ambiguous') return { ok: false, error: fallback.error }
            return { ok: false, error: sandboxed.error }
        }

        if (isInsideProtectedAgentPath(sandboxed.resolved)) {
            return {
                ok: false,
                error: `Protected workspace file cannot be sent over WhatsApp: ${displayPath(sandboxed.resolved)}.`,
            }
        }

        if (fs.existsSync(sandboxed.resolved)) {
            return {
                ok: true,
                resolved: sandboxed.resolved,
                display: displayPath(sandboxed.resolved),
                defaultFilename: path.basename(sandboxed.resolved),
            }
        }

        const fallback = resolveConversationUploadByLabel([parsed.path, parsed.filename], ctx)
        if (fallback.kind === 'found') return { ok: true, ...fallback.value }
        if (fallback.kind === 'ambiguous') return { ok: false, error: fallback.error }

        return {
            ok: true,
            resolved: sandboxed.resolved,
            display: parsed.path,
            defaultFilename: path.basename(sandboxed.resolved),
        }
    }

    const fallback = resolveConversationUploadByLabel([parsed.filename], ctx)
    if (fallback.kind === 'found') return { ok: true, ...fallback.value }
    if (fallback.kind === 'ambiguous') return { ok: false, error: fallback.error }
    return { ok: false, error: 'missing path or upload_id.' }
}

function resolveUploadById(uploadId: string, ctx?: ToolExecutionContext): ResolvedAttachmentInput | null {
    const cleanUploadId = extractUploadId(uploadId)
    if (!cleanUploadId) return null
    const filePath = resolveExistingUploadPath(cleanUploadId)
    if (!filePath) return null
    const attachment = findConversationAttachmentById(cleanUploadId, ctx)
    return {
        resolved: filePath,
        display: `upload_id ${cleanUploadId}`,
        defaultFilename: attachment?.filename,
        defaultContentType: attachment?.mimeType,
    }
}

function resolveUploadReference(value: string, ctx?: ToolExecutionContext): ResolvedAttachmentInput | null {
    const byId = resolveUploadById(value, ctx)
    if (byId) return byId

    const fallback = resolveConversationUploadByLabel([value], ctx)
    return fallback.kind === 'found' ? fallback.value : null
}

function resolveConversationUploadByLabel(
    candidates: Array<string | undefined>,
    ctx?: ToolExecutionContext
): { kind: 'found'; value: ResolvedAttachmentInput } | { kind: 'ambiguous'; error: string } | { kind: 'none' } {
    if (!ctx?.conversationId) return { kind: 'none' }

    const labels = normalizedAttachmentLabels(candidates)
    if (labels.size === 0) return { kind: 'none' }

    const conversation = getConversation(ctx.conversationId)
    if (!conversation) return { kind: 'none' }

    const matches = new Map<string, Attachment>()
    for (const message of [...conversation.messages].reverse()) {
        for (const attachment of message.attachments ?? []) {
            if (!attachment?.id || matches.has(attachment.id)) continue
            const attachmentLabels = normalizedAttachmentLabels([attachment.id, attachment.filename])
            const matched = [...labels].some(label => attachmentLabels.has(label))
            if (matched && resolveExistingUploadPath(attachment.id)) matches.set(attachment.id, attachment)
        }
    }

    if (matches.size === 0) return { kind: 'none' }
    if (matches.size > 1) {
        const names = [...matches.values()]
            .map(attachment => attachment.filename || attachment.id)
            .slice(0, 5)
            .join(', ')
        return {
            kind: 'ambiguous',
            error: `More than one uploaded attachment matches that name (${names}). Use the exact upload_id instead.`,
        }
    }

    const attachment = [...matches.values()][0]
    const resolved = resolveExistingUploadPath(attachment.id)
    if (!resolved) return { kind: 'none' }
    return {
        kind: 'found',
        value: {
            resolved,
            display: `uploaded attachment ${attachment.filename || attachment.id}`,
            defaultFilename: attachment.filename,
            defaultContentType: attachment.mimeType,
        },
    }
}

function findConversationAttachmentById(uploadId: string, ctx?: ToolExecutionContext): Attachment | null {
    if (!ctx?.conversationId) return null
    const conversation = getConversation(ctx.conversationId)
    if (!conversation) return null
    for (const message of [...conversation.messages].reverse()) {
        const found = (message.attachments ?? []).find(attachment => attachment.id === uploadId)
        if (found) return found
    }
    return null
}

function normalizedAttachmentLabels(values: Array<string | undefined>): Set<string> {
    const labels = new Set<string>()
    for (const value of values) {
        if (!value) continue
        const clean = value.trim()
        if (!clean) continue
        addNormalizedLabel(labels, clean)
        addNormalizedLabel(labels, path.basename(clean))

        const uploadId = extractUploadId(clean)
        if (uploadId) addNormalizedLabel(labels, uploadId)
    }
    return labels
}

function addNormalizedLabel(labels: Set<string>, value: string) {
    const clean = value.trim().toLowerCase()
    if (clean) labels.add(clean)
}

function extractUploadId(value: string | undefined): string | null {
    if (!value) return null
    const clean = value.trim()
    if (!clean) return null
    if (resolveExistingUploadPath(clean)) return clean

    const apiMarker = '/api/uploads/'
    const markerIndex = clean.indexOf(apiMarker)
    if (markerIndex >= 0) {
        const afterMarker = clean.slice(markerIndex + apiMarker.length).split(/[?#/]/)[0]
        if (resolveExistingUploadPath(afterMarker)) return afterMarker
    }

    const basename = path.basename(clean).split(/[?#]/)[0]
    if (basename && basename !== clean && resolveExistingUploadPath(basename)) return basename

    return null
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function optionalBooleanArg(args: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        if (args[key] !== undefined) return booleanArg(args, [key])
    }
    return undefined
}

function safeFilename(value: string): string {
    return value.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim() || 'attachment.bin'
}

function normalizeMimeType(value: string): string {
    const base = value.split(';')[0].trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
        ? base
        : 'application/octet-stream'
}

function shouldSendAsDocument(mimeType: string): boolean {
    return !mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')
}

function inferMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase()
    switch (ext) {
        case '.txt':
        case '.log':
        case '.md':
            return 'text/plain'
        case '.csv':
            return 'text/csv'
        case '.json':
            return 'application/json'
        case '.pdf':
            return 'application/pdf'
        case '.png':
            return 'image/png'
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg'
        case '.webp':
            return 'image/webp'
        case '.gif':
            return 'image/gif'
        case '.mp4':
            return 'video/mp4'
        case '.mov':
            return 'video/quicktime'
        case '.mp3':
            return 'audio/mpeg'
        case '.ogg':
            return 'audio/ogg'
        case '.wav':
            return 'audio/wav'
        case '.zip':
            return 'application/zip'
        case '.doc':
            return 'application/msword'
        case '.docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        case '.xls':
            return 'application/vnd.ms-excel'
        case '.xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        case '.ppt':
            return 'application/vnd.ms-powerpoint'
        case '.pptx':
            return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        default:
            return 'application/octet-stream'
    }
}
