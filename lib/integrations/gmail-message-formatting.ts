import { randomBytes } from 'crypto'
import { decodeHTML, decodeHTMLAttribute } from 'entities'

const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const GMAIL_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
const LINK_ONLY_TEXT_MAX_CHARS = 500
const MIN_USEFUL_HTML_CHARS = 60

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

export type GmailMessageBodySource = 'text/plain' | 'text/html' | 'none'

export interface GmailMessageBodyExtraction {
    body: string
    bodySource: GmailMessageBodySource
    hasPlain: boolean
    hasHtml: boolean
    bodyPlainCharCount: number
    bodyHtmlCharCount: number
    extractionWarnings: string[]
    needsVisualInspection: boolean
}

export function getHeader(headers: GmailHeader[], name: string): string {
    const lower = name.toLowerCase()
    return headers.find(header => header.name.toLowerCase() === lower)?.value ?? ''
}

export function extractMessageBody(payload: GmailPayloadPart | undefined): GmailMessageBodyExtraction {
    const empty: GmailMessageBodyExtraction = {
        body: '',
        bodySource: 'none',
        hasPlain: false,
        hasHtml: false,
        bodyPlainCharCount: 0,
        bodyHtmlCharCount: 0,
        extractionWarnings: [],
        needsVisualInspection: false,
    }
    if (!payload) return empty

    const plain = joinBodyParts(collectPayloadText(payload, 'text/plain').map(normalizeExtractedText))
    const htmlParts = collectPayloadText(payload, 'text/html').map(part => part.trim()).filter(Boolean)
    const rawHtml = htmlParts.join('\n\n')
    const html = joinBodyParts(htmlParts.map(htmlToText))
    const hasPlain = plain.length > 0
    const hasHtml = rawHtml.length > 0
    const plainLooksLinkOnly = hasPlain && looksLikeLinkOnlyText(plain)
    const htmlAnalysis = analyzeHtmlExtraction(rawHtml, html)
    const extractionWarnings: string[] = []

    if (plainLooksLinkOnly) extractionWarnings.push('Plain text appears short or link-only.')
    if (hasHtml && htmlAnalysis.containsTable && html.length === 0) {
        extractionWarnings.push('HTML body contained table markup but no readable text could be extracted.')
    }

    const shouldUseHtml = html.length > 0 && (
        !hasPlain
        || (plainLooksLinkOnly && isUsefulHtmlText(html))
        || (plain.length < 1000 && htmlAnalysis.containsTable && html.length > plain.length * 1.4)
    )

    if (shouldUseHtml && hasPlain) {
        extractionWarnings.push('Used HTML-derived body because it appears more complete than the plain-text part.')
    }

    const needsVisualInspection = hasHtml
        && htmlAnalysis.imageHeavy
        && (!hasPlain || plainLooksLinkOnly || html.length === 0)

    if (needsVisualInspection) {
        extractionWarnings.push('HTML body appears image/CID-heavy; visual inspection may be needed.')
    }

    if (hasHtml && html.length === 0) {
        extractionWarnings.push('HTML body produced no readable text.')
    }

    const bodySource: GmailMessageBodySource = shouldUseHtml
        ? 'text/html'
        : hasPlain
            ? 'text/plain'
            : html.length > 0
                ? 'text/html'
                : 'none'

    const body = bodySource === 'text/html'
        ? html
        : bodySource === 'text/plain'
            ? plain
            : ''

    return {
        body,
        bodySource,
        hasPlain,
        hasHtml,
        bodyPlainCharCount: plain.length,
        bodyHtmlCharCount: html.length,
        extractionWarnings,
        needsVisualInspection,
    }
}

export function extractMessageText(payload: GmailPayloadPart | undefined): string {
    return extractMessageBody(payload).body
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
    if (normalizeMimeType(part.mimeType) === mimeType && part.body?.data) out.push(base64UrlDecode(part.body.data))
    for (const child of part.parts ?? []) out.push(...collectPayloadText(child, mimeType))
    return out
}

function htmlToText(html: string): string {
    const normalized = stripInvisibleHtml(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<head[\s\S]*?<\/head>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => formatAnchorText(attrs, inner))
        .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => formatImageText(attrs))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(td|th)>/gi, ' | ')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/(thead|tbody|tfoot|table)>/gi, '\n')
        .replace(/<tr\b[^>]*>/gi, '\n')
        .replace(/<t[dh]\b[^>]*>/gi, '')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|blockquote|pre)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')

    return normalizeExtractedText(decodeHTML(normalized))
        .split('\n')
        .map(normalizeTableLine)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function joinBodyParts(parts: string[]): string {
    return parts.map(part => part.trim()).filter(Boolean).join('\n\n').trim()
}

function normalizeExtractedText(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function normalizeTableLine(value: string): string {
    const trimmed = value
        .replace(/[ \t]*\|[ \t]*/g, ' | ')
        .replace(/(?:^\|[ \t]*|[ \t]*\|$)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    if (!trimmed.includes('|')) return trimmed
    return trimmed
        .split('|')
        .map(cell => cell.trim())
        .filter(Boolean)
        .join(' | ')
}

function normalizeMimeType(value: string | undefined): string {
    return (value ?? '').split(';')[0].trim().toLowerCase()
}

function looksLikeLinkOnlyText(value: string): boolean {
    const text = value.trim()
    if (!text || text.length > LINK_ONLY_TEXT_MAX_CHARS) return false

    const urls = text.match(/https?:\/\/\S+/gi) ?? []
    if (urls.length === 0) return false

    const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ')
    const words = withoutUrls.match(/[A-Za-z0-9][A-Za-z0-9'_-]{2,}/g) ?? []
    const hasLinkOnlyCue = /\b(view|open|see|click|browser|online|web|receipt|invoice|link)\b/i.test(withoutUrls)
    return words.length <= 16 || (text.length <= 260 && hasLinkOnlyCue)
}

function isUsefulHtmlText(value: string): boolean {
    const words = value.match(/[A-Za-z0-9][A-Za-z0-9'_-]{1,}/g) ?? []
    return value.length >= MIN_USEFUL_HTML_CHARS && words.length >= 8
}

function analyzeHtmlExtraction(rawHtml: string, extractedText: string): {
    containsTable: boolean
    imageHeavy: boolean
} {
    if (!rawHtml) return { containsTable: false, imageHeavy: false }

    const imgCount = countMatches(rawHtml, /<img\b/gi)
    const cidCount = countMatches(rawHtml, /\bcid:/gi)
    const containsTable = /<table\b/i.test(rawHtml) || /<t[dh]\b/i.test(rawHtml)
    const extractedChars = extractedText.trim().length
    const imageHeavy = imgCount > 0 && (
        extractedChars < 80
        || (cidCount >= 3 && extractedChars < 250)
        || (imgCount >= 5 && extractedChars < 400)
    )

    return { containsTable, imageHeavy }
}

function countMatches(value: string, pattern: RegExp): number {
    return value.match(pattern)?.length ?? 0
}

function stripInvisibleHtml(value: string): string {
    let current = value
    for (let i = 0; i < 5; i += 1) {
        const next = current.replace(
            /<([a-z][\w:-]*)\b(?=[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|font-size\s*:\s*0|max-height\s*:\s*0|opacity\s*:\s*0))[^>]*>[\s\S]*?<\/\1>/gi,
            ' ',
        )
        if (next === current) break
        current = next
    }
    return current
}

function formatAnchorText(attrs: string, inner: string): string {
    const label = inlineHtmlToText(inner)
    const href = htmlAttribute(attrs, 'href')
    if (!href) return ` ${label} `

    const cleanHref = decodeHTMLAttribute(href).trim()
    if (!cleanHref || !/^(https?:|mailto:)/i.test(cleanHref)) return ` ${label} `
    if (!label) return ` ${cleanHref} `
    if (label.includes(cleanHref)) return ` ${label} `
    return ` ${label} (${cleanHref}) `
}

function formatImageText(attrs: string): string {
    const alt = htmlAttribute(attrs, 'alt')
    const text = alt ? decodeHTMLAttribute(alt).trim() : ''
    return text ? ` ${text} ` : ' '
}

function inlineHtmlToText(html: string): string {
    return normalizeExtractedText(decodeHTML(
        html
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' '),
    ))
}

function htmlAttribute(attrs: string, name: string): string | null {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i')
    const match = pattern.exec(attrs)
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
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
