import type { Chat, Message, MessageSendOptions } from 'whatsapp-web.js'

import type {
    WhatsAppAttachmentSummary,
    WhatsAppChatSummary,
    WhatsAppMessageSummary,
    WhatsAppOutgoingAttachment,
    WhatsAppSendOptions,
    WhatsAppUnreadChatSummary,
} from './whatsapp'

export function chatSummary(chat: Chat): WhatsAppChatSummary {
    return {
        id: chat.id._serialized,
        name: chat.name || chat.id.user || chat.id._serialized,
        isGroup: Boolean(chat.isGroup),
        isReadOnly: Boolean(chat.isReadOnly),
        unreadCount: Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0,
        timestamp: unixSeconds(chat.timestamp),
        lastMessage: chat.lastMessage ? messageSummary(chat.lastMessage, chat) : null,
    }
}

export function unreadChatSummary(chat: Chat): WhatsAppUnreadChatSummary {
    return {
        id: chat.id._serialized,
        name: chat.name || chat.id.user || chat.id._serialized,
        isGroup: Boolean(chat.isGroup),
        unreadCount: Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0,
        timestamp: unixSeconds(chat.timestamp),
    }
}

export function messageSummary(message: Message, chat?: Chat): WhatsAppMessageSummary {
    return {
        id: message.id?._serialized || message.id?.id || '',
        chatId: chat?.id._serialized || (message.fromMe ? message.to : message.from),
        chatName: chat?.name || undefined,
        from: message.from,
        to: message.to,
        author: message.author ?? null,
        fromMe: Boolean(message.fromMe),
        type: String(message.type ?? 'unknown'),
        body: clip(message.body ?? '', 8_000),
        timestamp: unixSeconds(message.timestamp),
        date: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : null,
        hasMedia: Boolean(message.hasMedia),
    }
}

export function limitMessagesByChars(messages: WhatsAppMessageSummary[], maxChars: number): {
    messages: WhatsAppMessageSummary[]
    truncated: boolean
} {
    let used = 0
    const out: WhatsAppMessageSummary[] = []
    for (const message of messages) {
        const bodyChars = message.body.length
        if (out.length > 0 && used + bodyChars > maxChars) return { messages: out, truncated: true }
        out.push(message)
        used += bodyChars
    }
    return { messages: out, truncated: false }
}

export function normalizeChatId(value: string): string {
    const trimmed = value.trim()
    if (trimmed.includes('@')) return trimmed
    const digits = trimmed.replace(/[^\d]/g, '')
    if (digits.length >= 8) return `${digits}@c.us`
    return trimmed
}

export function attachmentSummary(attachment: WhatsAppOutgoingAttachment): WhatsAppAttachmentSummary {
    return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.bytes.byteLength,
        sendAsDocument: attachment.sendAsDocument,
    }
}

export function ensureChatWritable(chat: Chat): void {
    if (chat.isReadOnly) {
        throw new Error(`WhatsApp chat ${chat.name || chat.id._serialized} is read-only and cannot receive messages.`)
    }
}

export function sendOptions(options: WhatsAppSendOptions): MessageSendOptions {
    const out: MessageSendOptions = {
        sendSeen: false,
        waitUntilMsgSent: true,
    }
    const quotedMessageId = options.quotedMessageId?.trim()
    if (quotedMessageId) out.quotedMessageId = quotedMessageId
    if (typeof options.linkPreview === 'boolean') out.linkPreview = options.linkPreview
    return out
}

function unixSeconds(value: number | undefined): number | null {
    return Number.isFinite(value) && value ? value : null
}

function clip(value: string, maxChars: number): string {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
}
