import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    type GmailOutgoingAttachment,
    type GmailModifyTargetType,
    gmailArchive,
    gmailCreateDraft,
    gmailCreateLabel,
    gmailDeletePermanently,
    gmailDownloadAttachment,
    gmailListLabels,
    gmailMarkRead,
    gmailMarkUnread,
    gmailModifyLabels,
    gmailReadThread,
    gmailSearchMessages,
    gmailSendDraft,
    gmailSendMessage,
    gmailTrash,
    gmailUntrash,
} from '@/lib/integrations/gmail'
import { clamp, ensureParentDir, numberArg, stringArg } from './helpers'
import { displayPath, resolveSandboxed, resolveSandboxedWritable } from './sandbox'

const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024

export const gmailSearchTool: ToolDef = {
    id: 'GmailSearch',
    name: 'GmailSearch',
    description: 'Searches the connected Gmail mailbox using Gmail query syntax and returns message metadata. Requires Gmail to be connected in Settings > Auth.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Gmail search query, e.g. from:alice@example.com newer_than:30d subject:invoice is:unread.' },
            max_results: { type: 'integer', description: 'Maximum messages to return. Defaults to 10 and is capped at 25.' },
        },
        required: ['query'],
    },
    tags: ['read', 'gmail', 'email'],
}

export const gmailReadThreadTool: ToolDef = {
    id: 'GmailReadThread',
    name: 'GmailReadThread',
    description: 'Reads a connected Gmail thread, including message headers, labels, plain-text body content, and attachment metadata. Use only for threads relevant to the user request.',
    input_schema: {
        type: 'object',
        properties: {
            thread_id: { type: 'string', description: 'Gmail thread ID returned by GmailSearch.' },
            max_chars: { type: 'integer', description: 'Maximum body characters returned across the thread. Defaults to 30000.' },
        },
        required: ['thread_id'],
    },
    tags: ['read', 'gmail', 'email'],
}

export const gmailCreateDraftTool: ToolDef = {
    id: 'GmailCreateDraft',
    name: 'GmailCreateDraft',
    description: 'Creates an unsent Gmail draft in the connected mailbox, optionally with workspace file attachments. This tool does not send email.',
    input_schema: mailComposeSchema('Draft subject line.', 'Plain-text draft body.', false),
    tags: ['write', 'gmail', 'email'],
}

export const gmailSendDraftTool: ToolDef = {
    id: 'GmailSendDraft',
    name: 'GmailSendDraft',
    description: 'Sends an existing Gmail draft. Only use when the user explicitly asked to send this draft or approved sending it.',
    input_schema: {
        type: 'object',
        properties: {
            draft_id: { type: 'string', description: 'Gmail draft ID.' },
            confirmed_by_user: { type: 'boolean', description: 'Must be true only after explicit user approval to send.' },
        },
        required: ['draft_id', 'confirmed_by_user'],
    },
    tags: ['write', 'gmail', 'email', 'external_action'],
}

export const gmailSendEmailTool: ToolDef = {
    id: 'GmailSendEmail',
    name: 'GmailSendEmail',
    description: 'Composes and immediately sends a Gmail message, optionally with workspace file attachments. Only use when the user explicitly asked to send this exact email or approved sending it.',
    input_schema: mailComposeSchema('Email subject line.', 'Plain-text email body.', true),
    tags: ['write', 'gmail', 'email', 'external_action'],
}

export const gmailModifyLabelsTool: ToolDef = {
    id: 'GmailModifyLabels',
    name: 'GmailModifyLabels',
    description: 'Adds or removes Gmail label IDs on a message or thread. Use GmailListLabels first when label IDs are not known.',
    input_schema: {
        type: 'object',
        properties: {
            target_type: targetTypeParam(),
            id: { type: 'string', description: 'Gmail message ID or thread ID.' },
            add_label_ids: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add.' },
            remove_label_ids: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove.' },
        },
        required: ['target_type', 'id'],
    },
    tags: ['write', 'gmail', 'email'],
}

export const gmailArchiveTool = simpleTargetTool('GmailArchive', 'GmailArchive', 'Archives a Gmail message or thread by removing the INBOX label. This is reversible from All Mail.')
export const gmailMarkReadTool = simpleTargetTool('GmailMarkRead', 'GmailMarkRead', 'Marks a Gmail message or thread as read by removing the UNREAD label.')
export const gmailMarkUnreadTool = simpleTargetTool('GmailMarkUnread', 'GmailMarkUnread', 'Marks a Gmail message or thread as unread by adding the UNREAD label.')
export const gmailTrashTool = simpleTargetTool('GmailTrash', 'GmailTrash', 'Moves a Gmail message or thread to Trash. This is reversible until Trash is emptied.')
export const gmailUntrashTool = simpleTargetTool('GmailUntrash', 'GmailUntrash', 'Restores a Gmail message or thread from Trash.')

export const gmailDeleteTool: ToolDef = {
    id: 'GmailDeletePermanently',
    name: 'GmailDeletePermanently',
    description: 'Permanently deletes a Gmail message or thread. This cannot be undone. Only use after explicit user approval for permanent deletion.',
    input_schema: {
        type: 'object',
        properties: {
            target_type: targetTypeParam(),
            id: { type: 'string', description: 'Gmail message ID or thread ID.' },
            confirm_permanent_delete: { type: 'boolean', description: 'Must be true only after explicit user approval for permanent deletion.' },
        },
        required: ['target_type', 'id', 'confirm_permanent_delete'],
    },
    tags: ['write', 'gmail', 'email', 'destructive'],
}

export const gmailListLabelsTool: ToolDef = {
    id: 'GmailListLabels',
    name: 'GmailListLabels',
    description: 'Lists Gmail system and user labels with their IDs.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'gmail', 'email'],
}

export const gmailCreateLabelTool: ToolDef = {
    id: 'GmailCreateLabel',
    name: 'GmailCreateLabel',
    description: 'Creates a Gmail user label.',
    input_schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'New Gmail label name.' },
        },
        required: ['name'],
    },
    tags: ['write', 'gmail', 'email'],
}

export const gmailDownloadAttachmentTool: ToolDef = {
    id: 'GmailDownloadAttachment',
    name: 'GmailDownloadAttachment',
    description: 'Downloads a Gmail message attachment to the agent workspace. Use attachment metadata returned by GmailReadThread.',
    input_schema: {
        type: 'object',
        properties: {
            message_id: { type: 'string', description: 'Gmail message ID containing the attachment.' },
            attachment_id: { type: 'string', description: 'Gmail attachment ID from GmailReadThread.' },
            filename: { type: 'string', description: 'Optional filename used when save_path is omitted or is a directory.' },
            save_path: { type: 'string', description: 'Optional workspace path to save the attachment. Defaults to /gmail-attachments/<filename>.' },
            max_bytes: { type: 'integer', description: 'Maximum attachment bytes to save. Defaults to 25MB and is capped at 50MB.' },
        },
        required: ['message_id', 'attachment_id'],
    },
    tags: ['read', 'gmail', 'email', 'filesystem'],
}

export const gmailTools: ToolDef[] = [
    gmailSearchTool,
    gmailReadThreadTool,
    gmailCreateDraftTool,
    gmailSendDraftTool,
    gmailSendEmailTool,
    gmailModifyLabelsTool,
    gmailArchiveTool,
    gmailMarkReadTool,
    gmailMarkUnreadTool,
    gmailTrashTool,
    gmailUntrashTool,
    gmailDeleteTool,
    gmailListLabelsTool,
    gmailCreateLabelTool,
    gmailDownloadAttachmentTool,
]

export async function executeGmailSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return { success: false, error: 'Missing required parameter: query' }
    const maxResults = clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 10)), 1, 25)
    return { success: true, data: await gmailSearchMessages(query, maxResults) }
}

export async function executeGmailReadThread(args: Record<string, unknown>): Promise<ToolResult> {
    const threadId = stringArg(args, ['thread_id', 'threadId'])
    if (!threadId) return { success: false, error: 'Missing required parameter: thread_id' }
    const maxChars = clamp(Math.floor(numberArg(args, ['max_chars', 'maxChars'], 30_000)), 2_000, 100_000)
    return { success: true, data: await gmailReadThread(threadId, maxChars) }
}

export async function executeGmailCreateDraft(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseComposeArgs(args)
    if (!parsed.ok) return parsed.error
    const result = await gmailCreateDraft(parsed.input)
    return { success: true, data: { ...result, status: 'draft_created_not_sent' } }
}

export async function executeGmailSendDraft(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return { success: false, error: 'confirmed_by_user must be true before sending Gmail draft.' }
    const draftId = stringArg(args, ['draft_id', 'draftId'])
    if (!draftId) return { success: false, error: 'Missing required parameter: draft_id' }
    return { success: true, data: { ...await gmailSendDraft(draftId), status: 'sent' } }
}

export async function executeGmailSendEmail(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return { success: false, error: 'confirmed_by_user must be true before sending Gmail email.' }
    const parsed = parseComposeArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: { ...await gmailSendMessage(parsed.input), status: 'sent' } }
}

export async function executeGmailModifyLabels(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    const add = stringArrayArg(args, 'add_label_ids')
    const remove = stringArrayArg(args, 'remove_label_ids')
    if (add.length === 0 && remove.length === 0) return { success: false, error: 'Provide at least one label ID to add or remove.' }
    return { success: true, data: await gmailModifyLabels(parsed.targetType, parsed.id, add, remove) }
}

export async function executeGmailArchive(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailArchive(parsed.targetType, parsed.id) }
}

export async function executeGmailMarkRead(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailMarkRead(parsed.targetType, parsed.id) }
}

export async function executeGmailMarkUnread(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailMarkUnread(parsed.targetType, parsed.id) }
}

export async function executeGmailTrash(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailTrash(parsed.targetType, parsed.id) }
}

export async function executeGmailUntrash(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailUntrash(parsed.targetType, parsed.id) }
}

export async function executeGmailDeletePermanently(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirm_permanent_delete !== true) return { success: false, error: 'confirm_permanent_delete must be true before permanent deletion.' }
    const parsed = parseTargetArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await gmailDeletePermanently(parsed.targetType, parsed.id) }
}

export async function executeGmailListLabels(): Promise<ToolResult> {
    return { success: true, data: await gmailListLabels() }
}

export async function executeGmailCreateLabel(args: Record<string, unknown>): Promise<ToolResult> {
    const name = stringArg(args, ['name', 'label'])
    if (!name) return { success: false, error: 'Missing required parameter: name' }
    return { success: true, data: await gmailCreateLabel(name) }
}

export async function executeGmailDownloadAttachment(args: Record<string, unknown>): Promise<ToolResult> {
    const messageId = stringArg(args, ['message_id', 'messageId'])
    const attachmentId = stringArg(args, ['attachment_id', 'attachmentId'])
    if (!messageId) return { success: false, error: 'Missing required parameter: message_id' }
    if (!attachmentId) return { success: false, error: 'Missing required parameter: attachment_id' }

    const maxBytes = clamp(Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], 25 * 1024 * 1024)), 1, 50 * 1024 * 1024)
    const filename = safeFilename(stringArg(args, ['filename']) || `${attachmentId}.bin`)
    const rawSavePath = stringArg(args, ['save_path', 'path']) || path.posix.join('gmail-attachments', filename)
    const savePath = rawSavePath.endsWith('/') ? path.posix.join(rawSavePath, filename) : rawSavePath
    const sandboxed = resolveSandboxedWritable(savePath)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }

    const attachment = await gmailDownloadAttachment(messageId, attachmentId)
    if (attachment.bytes.byteLength > maxBytes) {
        return { success: false, error: `Attachment is ${attachment.bytes.byteLength} bytes, above max_bytes ${maxBytes}.` }
    }

    ensureParentDir(sandboxed.resolved)
    fs.writeFileSync(sandboxed.resolved, attachment.bytes)
    return {
        success: true,
        data: {
            message_id: messageId,
            attachment_id: attachmentId,
            path: displayPath(sandboxed.resolved),
            bytes: attachment.bytes.byteLength,
        },
    }
}

function mailComposeSchema(subjectDescription: string, bodyDescription: string, includeConfirmation: boolean): ToolDef['input_schema'] {
    const properties: ToolDef['input_schema']['properties'] = {
        to: { type: 'array', description: 'Recipient email addresses.', items: { type: 'string' } },
        cc: { type: 'array', description: 'Optional CC recipients.', items: { type: 'string' } },
        bcc: { type: 'array', description: 'Optional BCC recipients.', items: { type: 'string' } },
        subject: { type: 'string', description: subjectDescription },
        body: { type: 'string', description: bodyDescription },
        thread_id: { type: 'string', description: 'Optional Gmail thread ID when replying in an existing thread.' },
        attachments: {
            type: 'array',
            description: 'Optional files from the agent workspace to attach to the draft/email.',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace file path to attach.' },
                    filename: { type: 'string', description: 'Optional filename shown to recipients.' },
                    content_type: { type: 'string', description: 'Optional MIME type. Defaults from file extension.' },
                },
                required: ['path'],
            },
        },
    }
    const required = ['to', 'subject', 'body']
    if (includeConfirmation) {
        properties.confirmed_by_user = { type: 'boolean', description: 'Must be true only after explicit user approval to send.' }
        required.push('confirmed_by_user')
    }
    return { type: 'object', properties, required }
}

function simpleTargetTool(id: string, name: string, description: string): ToolDef {
    return {
        id,
        name,
        description,
        input_schema: {
            type: 'object',
            properties: {
                target_type: targetTypeParam(),
                id: { type: 'string', description: 'Gmail message ID or thread ID.' },
            },
            required: ['target_type', 'id'],
        },
        tags: ['write', 'gmail', 'email'],
    }
}

function targetTypeParam(): ToolDef['input_schema'] {
    return { type: 'string', enum: ['message', 'thread'], description: 'Whether id is a Gmail message ID or thread ID.' }
}

function parseComposeArgs(args: Record<string, unknown>):
    | { ok: true; input: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; threadId?: string; attachments?: GmailOutgoingAttachment[] } }
    | { ok: false; error: ToolResult } {
    const to = stringArrayArg(args, 'to')
    const cc = stringArrayArg(args, 'cc')
    const bcc = stringArrayArg(args, 'bcc')
    const subject = stringArg(args, ['subject'])
    const body = stringArg(args, ['body', 'text'])
    const threadId = stringArg(args, ['thread_id', 'threadId'])
    const attachments = parseOutgoingAttachments(args)
    if (to.length === 0) return { ok: false, error: { success: false, error: 'Missing required parameter: to' } }
    if (!subject) return { ok: false, error: { success: false, error: 'Missing required parameter: subject' } }
    if (!body) return { ok: false, error: { success: false, error: 'Missing required parameter: body' } }
    if (!attachments.ok) return attachments
    return {
        ok: true,
        input: {
            to,
            cc,
            bcc,
            subject,
            body,
            threadId: threadId || undefined,
            attachments: attachments.value.length > 0 ? attachments.value : undefined,
        },
    }
}

function parseTargetArgs(args: Record<string, unknown>):
    | { ok: true; targetType: GmailModifyTargetType; id: string }
    | { ok: false; error: ToolResult } {
    const targetType = stringArg(args, ['target_type', 'targetType']) as GmailModifyTargetType
    const id = stringArg(args, ['id', 'message_id', 'thread_id'])
    if (targetType !== 'message' && targetType !== 'thread') {
        return { ok: false, error: { success: false, error: 'target_type must be "message" or "thread".' } }
    }
    if (!id) return { ok: false, error: { success: false, error: 'Missing required parameter: id' } }
    return { ok: true, targetType, id }
}

function parseOutgoingAttachments(args: Record<string, unknown>):
    | { ok: true; value: GmailOutgoingAttachment[] }
    | { ok: false; error: ToolResult } {
    const raw = args.attachments ?? args.files
    if (raw === undefined || raw === null) return { ok: true, value: [] }
    if (!Array.isArray(raw)) return { ok: false, error: { success: false, error: 'attachments must be an array.' } }

    const attachments: GmailOutgoingAttachment[] = []
    let totalBytes = 0

    for (const [index, item] of raw.entries()) {
        const parsed = parseAttachmentInput(item)
        if (!parsed.ok) {
            return { ok: false, error: { success: false, error: `Invalid attachment at index ${index}: ${parsed.error}` } }
        }

        const resolved = resolveSandboxed(parsed.path)
        if (!resolved.ok) return { ok: false, error: { success: false, error: resolved.error } }

        let stat: fs.Stats
        try {
            stat = fs.statSync(resolved.resolved)
        } catch {
            return { ok: false, error: { success: false, error: `Attachment file does not exist: ${parsed.path}` } }
        }

        if (!stat.isFile()) {
            return { ok: false, error: { success: false, error: `Attachment path is not a file: ${parsed.path}` } }
        }
        if (stat.size <= 0) {
            return { ok: false, error: { success: false, error: `Attachment file is empty: ${parsed.path}` } }
        }
        if (stat.size > MAX_OUTGOING_ATTACHMENT_BYTES) {
            return { ok: false, error: { success: false, error: `Attachment is over 25MB: ${parsed.path}` } }
        }

        totalBytes += stat.size
        if (totalBytes > MAX_OUTGOING_TOTAL_ATTACHMENT_BYTES) {
            return { ok: false, error: { success: false, error: 'Total Gmail attachment size is capped at 25MB.' } }
        }

        const filename = safeFilename(parsed.filename || path.basename(resolved.resolved))
        attachments.push({
            filename,
            mimeType: normalizeMimeType(parsed.contentType || inferMimeType(filename)),
            bytes: fs.readFileSync(resolved.resolved),
        })
    }

    return { ok: true, value: attachments }
}

function parseAttachmentInput(value: unknown): { ok: true; path: string; filename?: string; contentType?: string } | { ok: false; error: string } {
    if (typeof value === 'string' && value.trim()) {
        return { ok: true, path: value.trim() }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'expected a workspace path string or an object with path.' }
    }
    const record = value as Record<string, unknown>
    const filePath = firstString(record, ['path', 'file_path', 'filePath'])
    if (!filePath) return { ok: false, error: 'missing path.' }
    return {
        ok: true,
        path: filePath,
        filename: firstString(record, ['filename', 'name']) || undefined,
        contentType: firstString(record, ['content_type', 'contentType', 'mime_type', 'mimeType']) || undefined,
    }
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
    const value = args[key]
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    }
    if (typeof value === 'string' && value.trim()) {
        return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function safeFilename(value: string): string {
    return value.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim() || 'attachment.bin'
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function normalizeMimeType(value: string): string {
    const base = value.split(';')[0].trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
        ? base
        : 'application/octet-stream'
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
        case '.svg':
            return 'image/svg+xml'
        case '.html':
        case '.htm':
            return 'text/html'
        case '.ics':
            return 'text/calendar'
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
