import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    getWhatsAppIntegrationStatus,
    startWhatsApp,
    whatsappListChats,
    whatsappReadChat,
    whatsappSearchMessages,
    whatsappUnreadSummary,
} from '@/lib/integrations/whatsapp'
import { clamp, numberArg, stringArg } from './helpers'

export const whatsappStatusTool: ToolDef = {
    id: 'WhatsAppStatus',
    name: 'WhatsAppStatus',
    description: 'Checks the local read-only WhatsApp Web integration status, including whether a QR code is currently available.',
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
        'Starts the local read-only WhatsApp Web session and returns a QR image URL/markdown when login is needed.',
        'Use this when the user asks to configure, connect, reconnect, or scan WhatsApp.',
        'If qrMarkdown is present, show it directly in the final answer so the user can scan it from their phone.',
        'This tool never sends messages.',
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
    description: 'Lists recent WhatsApp chats from the connected local WhatsApp Web session. Read-only; does not send or mark chats handled.',
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
    description: 'Returns the total unread WhatsApp count and unread chats from the connected local WhatsApp Web session. Read-only; does not read message bodies, send, or mark chats handled.',
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
    description: 'Reads recent messages from one WhatsApp chat by chat_id returned by WhatsAppListChats. Read-only; does not send or mark chats handled.',
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
    description: 'Searches recent WhatsApp message bodies by scanning recent chats from the connected local WhatsApp Web session. Read-only; this is not full account history search.',
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

export const whatsappTools: ToolDef[] = [
    whatsappStatusTool,
    whatsappConnectTool,
    whatsappListChatsTool,
    whatsappUnreadSummaryTool,
    whatsappReadChatTool,
    whatsappSearchMessagesTool,
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
