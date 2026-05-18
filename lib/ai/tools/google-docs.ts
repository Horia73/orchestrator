import type { ToolDef, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    googleDocsApplyParagraphStyle,
    googleDocsApplyTextStyle,
    googleDocsBatchUpdate,
    googleDocsCreateDocument,
    googleDocsGetDocument,
    googleDocsInsertTable,
    googleDocsInsertText,
    googleDocsReplaceAllText,
} from '@/lib/integrations/google-docs'
import { booleanArg, numberArg, stringArg } from './helpers'

export const googleDocsTools: ToolDef[] = [
    {
        id: 'GoogleDocsCreateDocument',
        name: 'GoogleDocsCreateDocument',
        description: 'Creates a blank native Google Doc. Use after confirming title and purpose; then use Docs batchUpdate tools for production formatting.',
        input_schema: writeSchema({ title: { type: 'string', description: 'Document title.' } }, ['title', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsGetDocument',
        name: 'GoogleDocsGetDocument',
        description: 'Reads Google Docs structure summary and extracted body text. Use before editing to ground indexes, revision, and existing content.',
        input_schema: { type: 'object', properties: { document_id: idParam('Google Docs document ID.') }, required: ['document_id'] },
        tags: ['read', 'google-docs', 'document'],
    },
    {
        id: 'GoogleDocsInsertText',
        name: 'GoogleDocsInsertText',
        description: 'Inserts text into a Google Doc at a 1-based structural index. For production docs, insert section skeleton first, then apply styles in separate requests.',
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            index: { type: 'integer', description: 'Insertion index. Defaults to 1, after document start.' },
            text: { type: 'string', description: 'Text to insert. Include line breaks intentionally.' },
        }, ['document_id', 'text', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsReplaceAllText',
        name: 'GoogleDocsReplaceAllText',
        description: 'Replaces all matching text in a Google Doc. Use for template placeholders after reading the target doc.',
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            contains_text: { type: 'string', description: 'Text or placeholder to find.' },
            replace_text: { type: 'string', description: 'Replacement text.' },
            match_case: { type: 'boolean', description: 'Defaults to false.' },
        }, ['document_id', 'contains_text', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsApplyTextStyle',
        name: 'GoogleDocsApplyTextStyle',
        description: 'Applies Google Docs textStyle over an exact range. Use for modern hierarchy: font size, weight, foreground color, links, weightedFontFamily, small caps, and emphasis.',
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            start_index: { type: 'integer', description: 'Inclusive range start.' },
            end_index: { type: 'integer', description: 'Exclusive range end.' },
            style: { type: 'object', description: 'Google Docs TextStyle JSON.' },
            fields: { type: 'string', description: 'Field mask, e.g. bold,fontSize,foregroundColor,weightedFontFamily.' },
        }, ['document_id', 'start_index', 'end_index', 'style', 'fields', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsApplyParagraphStyle',
        name: 'GoogleDocsApplyParagraphStyle',
        description: 'Applies paragraphStyle over an exact range. Use for headings, spacing, alignment, borders, namedStyleType, and document readability.',
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            start_index: { type: 'integer', description: 'Inclusive range start.' },
            end_index: { type: 'integer', description: 'Exclusive range end.' },
            style: { type: 'object', description: 'Google Docs ParagraphStyle JSON.' },
            fields: { type: 'string', description: 'Field mask, e.g. namedStyleType,spaceAbove,spaceBelow,alignment,borderBottom.' },
        }, ['document_id', 'start_index', 'end_index', 'style', 'fields', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsInsertTable',
        name: 'GoogleDocsInsertTable',
        description: 'Inserts a native Google Docs table. Use for clean comparisons, matrices, pricing, milestones, or structured facts; style cells via BatchUpdate.',
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            index: { type: 'integer', description: 'Insertion index. Defaults to 1.' },
            rows: { type: 'integer', description: 'Rows, capped by backend.' },
            columns: { type: 'integer', description: 'Columns, capped by backend.' },
        }, ['document_id', 'rows', 'columns', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
    {
        id: 'GoogleDocsBatchUpdate',
        name: 'GoogleDocsBatchUpdate',
        description: [
            'Advanced native Google Docs batchUpdate. Use for production-ready Docs: insertText, replaceAllText, updateTextStyle, updateParagraphStyle, insertTable, table cell styling, headers/footers, section breaks, inline images, bullets, and document style.',
            'Read the doc first, use exact indexes, keep requests atomic, and verify with GoogleDocsGetDocument afterward.',
        ].join(' '),
        input_schema: writeSchema({
            document_id: idParam('Google Docs document ID.'),
            requests: { type: 'array', items: { type: 'object' }, description: 'Raw Google Docs API Request[] payload.' },
            write_control: { type: 'object', description: 'Optional Docs writeControl with requiredRevisionId or targetRevisionId.' },
        }, ['document_id', 'requests', 'confirmed_by_user']),
        tags: ['write', 'google-docs', 'document', 'external_action'],
    },
]

export async function executeGoogleDocsCreateDocument(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Doc')
    const title = stringArg(args, ['title', 'name'])
    if (!title) return missing('title')
    return { success: true, data: await googleDocsCreateDocument(title) }
}

export async function executeGoogleDocsGetDocument(args: Record<string, unknown>): Promise<ToolResult> {
    const documentId = stringArg(args, ['document_id', 'documentId'])
    if (!documentId) return missing('document_id')
    return { success: true, data: await googleDocsGetDocument(documentId) }
}

export async function executeGoogleDocsInsertText(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('inserting text into a Google Doc')
    const documentId = stringArg(args, ['document_id', 'documentId'])
    const text = stringArg(args, ['text'])
    if (!documentId) return missing('document_id')
    if (!text) return missing('text')
    return { success: true, data: await googleDocsInsertText({ documentId, text, index: numberArg(args, ['index'], 1) }) }
}

export async function executeGoogleDocsReplaceAllText(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('replacing text in a Google Doc')
    const documentId = stringArg(args, ['document_id', 'documentId'])
    const containsText = stringArg(args, ['contains_text', 'containsText'])
    if (!documentId) return missing('document_id')
    if (!containsText) return missing('contains_text')
    return { success: true, data: await googleDocsReplaceAllText({ documentId, containsText, replaceText: stringArg(args, ['replace_text', 'replaceText']), matchCase: booleanArg(args, ['match_case', 'matchCase']) }) }
}

export async function executeGoogleDocsApplyTextStyle(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('styling Google Doc text')
    const parsed = parseRangeStyle(args, 'style')
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleDocsApplyTextStyle(parsed.value) }
}

export async function executeGoogleDocsApplyParagraphStyle(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('styling Google Doc paragraphs')
    const parsed = parseRangeStyle(args, 'style')
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleDocsApplyParagraphStyle(parsed.value) }
}

export async function executeGoogleDocsInsertTable(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('inserting a Google Docs table')
    const documentId = stringArg(args, ['document_id', 'documentId'])
    if (!documentId) return missing('document_id')
    return { success: true, data: await googleDocsInsertTable({ documentId, rows: numberArg(args, ['rows'], 2), columns: numberArg(args, ['columns'], 2), index: numberArg(args, ['index'], 1) }) }
}

export async function executeGoogleDocsBatchUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('running Google Docs batchUpdate')
    const documentId = stringArg(args, ['document_id', 'documentId'])
    if (!documentId) return missing('document_id')
    const requests = args.requests
    if (!Array.isArray(requests)) return { success: false, error: 'requests must be an array.' }
    return { success: true, data: await googleDocsBatchUpdate(documentId, requests, objectArg(args.write_control ?? args.writeControl)) }
}

function parseRangeStyle(args: Record<string, unknown>, styleKey: string):
    | { ok: true; value: { documentId: string; startIndex: number; endIndex: number; style: Record<string, unknown>; fields: string } }
    | { ok: false; error: ToolResult } {
    const documentId = stringArg(args, ['document_id', 'documentId'])
    const style = objectArg(args[styleKey])
    const fields = stringArg(args, ['fields'])
    if (!documentId) return { ok: false, error: missing('document_id') }
    if (!style) return { ok: false, error: missing(styleKey) }
    if (!fields) return { ok: false, error: missing('fields') }
    return {
        ok: true,
        value: {
            documentId,
            startIndex: Math.floor(numberArg(args, ['start_index', 'startIndex'], 0)),
            endIndex: Math.floor(numberArg(args, ['end_index', 'endIndex'], 0)),
            style,
            fields,
        },
    }
}

function writeSchema(properties: Record<string, ToolParameter>, required: string[]): ToolParameter {
    return {
        type: 'object',
        properties: {
            ...properties,
            confirmed_by_user: { type: 'boolean', description: 'Must be true only after explicit approval for this exact Google Docs write.' },
        },
        required,
    }
}

function idParam(description: string): ToolParameter {
    return { type: 'string', description }
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function confirmed(args: Record<string, unknown>): boolean {
    return args.confirmed_by_user === true
}

function missing(name: string): ToolResult {
    return { success: false, error: `Missing required parameter: ${name}` }
}

function confirmationError(action: string): ToolResult {
    return { success: false, error: `confirmed_by_user must be true before ${action}.` }
}
