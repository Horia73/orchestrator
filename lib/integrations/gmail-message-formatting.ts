import { randomBytes } from 'crypto'

const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const GMAIL_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface GmailHeader {
    name: string
    value: string
}

export interface GmailPayloadPart {
    partId?: string
    mimeType?: string
    filename?: string
    headers?: GmailHeader[]
    body?: {
        data?: string
        size?: number
        attachmentId?: string
    }
    parts?: GmailPayloadPart[]
}

export interface GmailAttachmentInfo {
    messageId: string
    partId: string
    attachmentId: string
    filename: string
    mimeType: string
    size: number
}

export interface GmailOutgoingAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
}

export interface GmailAttachmentSummary {
    filename: string
    mimeType: string
    size: number
}

export interface GmailThreadMessageForLimit {
    from: string
    to: string
    subject: string
    body: string
}

export function getHeader(headers: GmailHeader[], name: string): string {
    const lower = name.toLowerCase()
    return headers.find(header => header.name.toLowerCase() === lower)?.value ?? ''
}

export function extractMessageText(payload: GmailPayloadPart | undefined): string {
    if (!payload) return ''
    const plain = collectPayloadText(payload, 'text/plain')
    if (plain.length > 0) return plain.join('\n\n').trim()
    const html = collectPayloadText(payload, 'text/html')
    return html.map(htmlToText).join('\n\n').trim()
}

export function collectAttachments(part: GmailPayloadPart | undefined, messageId: string): GmailAttachmentInfo[] {
    if (!part) return []
    const current = part.filename && part.body?.attachmentId
        ? [{
            messageId,
            partId: part.partId ?? '',
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: part.body.size ?? 0,
        }]
        : []
    for (const child of part.parts ?? []) current.push(...collectAttachments(child, messageId))
    return current
}

export function limitThreadMessages<T extends GmailThreadMessageForLimit>(messages: T[], maxChars: number): { messages: T[]; truncated: boolean } {
    const limit = Math.max(2000, Math.min(100_000, Math.floor(maxChars)))
    let used = 0
    let truncated = false
    const limited: T[] = []
    for (const message of messages) {
        const bodyBudget = Math.max(0, limit - used)
        if (bodyBudget <= 0) {
            truncated = true
            break
        }
        const body = message.body.length > bodyBudget
            ? `${message.body.slice(0, bodyBudget)}\n\n...[truncated]...`
            : message.body
        truncated ||= body.length !== message.body.length
        used += body.length + message.subject.length + message.from.length + message.to.length + 200
        limited.push({ ...message, body })
    }
    return { messages: limited, truncated }
}

export function cleanAddressList(values: string[]): string[] {
    return values
        .map(value => cleanHeaderValue(value))
        .filter(Boolean)
}

export function cleanHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim()
}

export function cleanLabelIds(values: string[]): string[] {
    return values.map(cleanHeaderValue).filter(Boolean)
}

export function normalizeOutgoingAttachments(attachments: GmailOutgoingAttachment[] | undefined): GmailOutgoingAttachment[] {
    const clean: GmailOutgoingAttachment[] = []
    let totalBytes = 0

    for (const attachment of attachments ?? []) {
        const filename = cleanAttachmentFilename(attachment.filename)
        const bytes = Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes)
        const mimeType = cleanMimeType(attachment.mimeType)

        if (!filename) throw new Error('Attachment filename is required.')
        if (bytes.byteLength === 0) throw new Error(`Attachment ${filename} is empty.`)
        if (bytes.byteLength > GMAIL_MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment ${filename} is too large. Gmail attachment limit is 25MB per file.`)
        }

        totalBytes += bytes.byteLength
        if (totalBytes > GMAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new Error('Gmail attachments are too large. Total attachment size is capped at 25MB.')
        }

        clean.push({ filename, mimeType, bytes })
    }

    return clean
}

export function summarizeOutgoingAttachments(attachments: GmailOutgoingAttachment[]): GmailAttachmentSummary[] {
    return attachments.map(attachment => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.bytes.byteLength,
    }))
}

export function buildMimeMessage(args: {
    from: string
    to: string[]
    cc: string[]
    bcc: string[]
    subject: string
    body: string
    attachments?: GmailOutgoingAttachment[]
    inReplyTo?: string
    references?: string
}): string {
    const headers = [
        `From: ${cleanHeaderValue(args.from)}`,
        `To: ${args.to.join(', ')}`,
        args.cc.length ? `Cc: ${args.cc.join(', ')}` : null,
        args.bcc.length ? `Bcc: ${args.bcc.join(', ')}` : null,
        `Subject: ${encodeMimeHeader(args.subject)}`,
        args.inReplyTo ? `In-Reply-To: ${cleanHeaderValue(args.inReplyTo)}` : null,
        args.references ? `References: ${cleanHeaderValue(args.references)}` : null,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
    ].filter((line): line is string => line !== null)

    if (!args.attachments?.length) {
        return [
            ...headers,
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 8bit',
            '',
            args.body,
        ].join('\r\n')
    }

    const boundary = `orchestrator-gmail-${randomBytes(12).toString('hex')}`
    const lines = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        args.body,
        ...args.attachments.flatMap(attachment => attachmentMimePart(boundary, attachment)),
        `--${boundary}--`,
        '',
    ]
    return lines.join('\r\n')
}

export function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlDecodeBuffer(value: string): Buffer {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=')
    return Buffer.from(padded, 'base64')
}

function collectPayloadText(part: GmailPayloadPart, mimeType: string): string[] {
    const out: string[] = []
    if (part.mimeType === mimeType && part.body?.data) out.push(base64UrlDecode(part.body.data))
    for (const child of part.parts ?? []) out.push(...collectPayloadText(child, mimeType))
    return out
}

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function attachmentMimePart(boundary: string, attachment: GmailOutgoingAttachment): string[] {
    return [
        `--${boundary}`,
        `Content-Type: ${cleanMimeType(attachment.mimeType)}; ${mimeFilenameParameter('name', attachment.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${mimeFilenameParameter('filename', attachment.filename)}`,
        '',
        wrapBase64(attachment.bytes.toString('base64')),
    ]
}

function encodeMimeHeader(value: string): string {
    const clean = cleanHeaderValue(value)
    if (/^[\x20-\x7e]*$/.test(clean)) return clean
    return `=?UTF-8?B?${Buffer.from(clean, 'utf-8').toString('base64')}?=`
}

function mimeFilenameParameter(name: string, filename: string): string {
    const clean = cleanAttachmentFilename(filename) || 'attachment.bin'
    const quoted = `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    if (/^[\x20-\x7e]*$/.test(clean)) return `${name}=${quoted}`
    return `${name}=${quoted}; ${name}*=UTF-8''${encodeURIComponent(clean)}`
}

function wrapBase64(value: string): string {
    return value.replace(/.{1,76}/g, '$&\r\n').trimEnd()
}

function cleanAttachmentFilename(value: string): string {
    return cleanHeaderValue(value).replace(/[\\/]/g, '_').trim()
}

function cleanMimeType(value: string): string {
    const base = cleanHeaderValue(value).split(';')[0].trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
        ? base
        : 'application/octet-stream'
}

function base64UrlDecode(value: string): string {
    return base64UrlDecodeBuffer(value).toString('utf-8')
}
