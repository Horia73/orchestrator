import { googleWorkspaceJson } from './google-drive'

const GOOGLE_DOCS_API_BASE = 'https://docs.googleapis.com/v1'

export interface GoogleDocsDocumentSummary {
    documentId: string
    title: string
    revisionId: string | null
    url: string
    bodyText: string
    inlineObjects: string[]
    positionedObjects: string[]
    namedRanges: string[]
}

export interface GoogleDocsBatchUpdateResult {
    documentId: string
    replies: unknown[]
    writeControl: unknown | null
}

interface DocsDocument {
    documentId?: string
    title?: string
    revisionId?: string
    body?: {
        content?: DocsStructuralElement[]
    }
    inlineObjects?: Record<string, unknown>
    positionedObjects?: Record<string, unknown>
    namedRanges?: Record<string, unknown>
}

interface DocsStructuralElement {
    paragraph?: {
        elements?: Array<{ textRun?: { content?: string } }>
    }
    table?: {
        tableRows?: Array<{
            tableCells?: Array<{
                content?: DocsStructuralElement[]
            }>
        }>
    }
    sectionBreak?: unknown
}

export async function googleDocsCreateDocument(title: string): Promise<GoogleDocsDocumentSummary> {
    const cleanTitle = cleanRequired(title, 'title')
    const doc = await googleWorkspaceJson<DocsDocument>(GOOGLE_DOCS_API_BASE, '/documents', {
        method: 'POST',
        body: JSON.stringify({ title: cleanTitle }),
    })
    return summarizeDocument(doc)
}

export async function googleDocsGetDocument(documentId: string): Promise<GoogleDocsDocumentSummary> {
    const doc = await googleWorkspaceJson<DocsDocument>(
        GOOGLE_DOCS_API_BASE,
        `/documents/${encodeURIComponent(cleanRequired(documentId, 'document_id'))}`
    )
    return summarizeDocument(doc)
}

export async function googleDocsBatchUpdate(documentId: string, requests: unknown[], writeControl?: unknown): Promise<GoogleDocsBatchUpdateResult> {
    const cleanDocumentId = cleanRequired(documentId, 'document_id')
    if (!Array.isArray(requests) || requests.length === 0) throw new Error('Google Docs batchUpdate requires at least one request.')
    const response = await googleWorkspaceJson<{ documentId?: string; replies?: unknown[]; writeControl?: unknown }>(
        GOOGLE_DOCS_API_BASE,
        `/documents/${encodeURIComponent(cleanDocumentId)}:batchUpdate`,
        {
            method: 'POST',
            body: JSON.stringify({
                requests,
                ...(writeControl ? { writeControl } : {}),
            }),
        }
    )
    return {
        documentId: response.documentId ?? cleanDocumentId,
        replies: response.replies ?? [],
        writeControl: response.writeControl ?? null,
    }
}

export async function googleDocsInsertText(args: {
    documentId: string
    text: string
    index?: number
    segmentId?: string
}): Promise<GoogleDocsBatchUpdateResult> {
    const text = cleanRequired(args.text, 'text')
    const location = typeof args.index === 'number'
        ? { index: Math.max(1, Math.floor(args.index)), ...(args.segmentId ? { segmentId: args.segmentId } : {}) }
        : { index: 1, ...(args.segmentId ? { segmentId: args.segmentId } : {}) }
    return googleDocsBatchUpdate(args.documentId, [{ insertText: { location, text } }])
}

export async function googleDocsReplaceAllText(args: {
    documentId: string
    containsText: string
    replaceText: string
    matchCase?: boolean
}): Promise<GoogleDocsBatchUpdateResult> {
    return googleDocsBatchUpdate(args.documentId, [{
        replaceAllText: {
            containsText: {
                text: cleanRequired(args.containsText, 'contains_text'),
                matchCase: args.matchCase === true,
            },
            replaceText: args.replaceText ?? '',
        },
    }])
}

export async function googleDocsApplyTextStyle(args: {
    documentId: string
    startIndex: number
    endIndex: number
    style: Record<string, unknown>
    fields: string
}): Promise<GoogleDocsBatchUpdateResult> {
    assertRange(args.startIndex, args.endIndex)
    return googleDocsBatchUpdate(args.documentId, [{
        updateTextStyle: {
            range: { startIndex: Math.floor(args.startIndex), endIndex: Math.floor(args.endIndex) },
            textStyle: args.style,
            fields: cleanRequired(args.fields, 'fields'),
        },
    }])
}

export async function googleDocsApplyParagraphStyle(args: {
    documentId: string
    startIndex: number
    endIndex: number
    style: Record<string, unknown>
    fields: string
}): Promise<GoogleDocsBatchUpdateResult> {
    assertRange(args.startIndex, args.endIndex)
    return googleDocsBatchUpdate(args.documentId, [{
        updateParagraphStyle: {
            range: { startIndex: Math.floor(args.startIndex), endIndex: Math.floor(args.endIndex) },
            paragraphStyle: args.style,
            fields: cleanRequired(args.fields, 'fields'),
        },
    }])
}

export async function googleDocsInsertTable(args: {
    documentId: string
    rows: number
    columns: number
    index?: number
}): Promise<GoogleDocsBatchUpdateResult> {
    return googleDocsBatchUpdate(args.documentId, [{
        insertTable: {
            rows: clampInt(args.rows, 1, 100),
            columns: clampInt(args.columns, 1, 20),
            location: { index: Math.max(1, Math.floor(args.index ?? 1)) },
        },
    }])
}

function summarizeDocument(doc: DocsDocument): GoogleDocsDocumentSummary {
    const documentId = doc.documentId ?? ''
    return {
        documentId,
        title: doc.title ?? '',
        revisionId: doc.revisionId ?? null,
        url: documentId ? `https://docs.google.com/document/d/${documentId}/edit` : '',
        bodyText: extractText(doc.body?.content ?? []).trim(),
        inlineObjects: Object.keys(doc.inlineObjects ?? {}),
        positionedObjects: Object.keys(doc.positionedObjects ?? {}),
        namedRanges: Object.keys(doc.namedRanges ?? {}),
    }
}

function extractText(elements: DocsStructuralElement[]): string {
    const parts: string[] = []
    for (const element of elements) {
        if (element.paragraph?.elements) {
            parts.push(...element.paragraph.elements.map(item => item.textRun?.content ?? ''))
        }
        if (element.table?.tableRows) {
            for (const row of element.table.tableRows) {
                const cells = (row.tableCells ?? []).map(cell => extractText(cell.content ?? []).trim())
                if (cells.length > 0) parts.push(`${cells.join(' | ')}\n`)
            }
        }
    }
    return parts.join('')
}

function cleanRequired(value: string | undefined, name: string): string {
    const clean = (value ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw new Error(`Missing required parameter: ${name}`)
    return clean
}

function assertRange(start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || Math.floor(end) <= Math.floor(start)) {
        throw new Error('Range end must be after range start.')
    }
}

function clampInt(value: number, min: number, max: number): number {
    const parsed = Number.isFinite(value) ? Math.floor(value) : min
    return Math.min(max, Math.max(min, parsed))
}
