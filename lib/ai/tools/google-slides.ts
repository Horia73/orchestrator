import type { ToolDef, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    googleSlidesBatchUpdate,
    googleSlidesCreatePresentation,
    googleSlidesCreateSlide,
    googleSlidesGetPage,
    googleSlidesGetPresentation,
    googleSlidesGetThumbnail,
    googleSlidesInsertTextBox,
    googleSlidesReplaceAllText,
} from '@/lib/integrations/google-slides'
import { booleanArg, numberArg, stringArg } from './helpers'

export const googleSlidesTools: ToolDef[] = [
    {
        id: 'GoogleSlidesCreatePresentation',
        name: 'GoogleSlidesCreatePresentation',
        description: 'Creates a blank native Google Slides presentation. Use after confirming title, audience, aspect ratio/story direction, and design intent.',
        input_schema: writeSchema({ title: { type: 'string', description: 'Presentation title.' } }, ['title', 'confirmed_by_user']),
        tags: ['write', 'google-slides', 'presentation', 'external_action'],
    },
    {
        id: 'GoogleSlidesGetPresentation',
        name: 'GoogleSlidesGetPresentation',
        description: 'Reads presentation metadata, page size, slide object IDs, layouts, and element counts. Use before any edit and after batches for verification.',
        input_schema: { type: 'object', properties: { presentation_id: idParam('Google Slides presentation ID.') }, required: ['presentation_id'] },
        tags: ['read', 'google-slides', 'presentation'],
    },
    {
        id: 'GoogleSlidesGetPage',
        name: 'GoogleSlidesGetPage',
        description: 'Reads one slide/page by object ID, including current page elements. Use to ground geometry and object IDs before editing.',
        input_schema: { type: 'object', properties: { presentation_id: idParam('Presentation ID.'), page_object_id: idParam('Slide/page object ID.') }, required: ['presentation_id', 'page_object_id'] },
        tags: ['read', 'google-slides', 'presentation'],
    },
    {
        id: 'GoogleSlidesGetThumbnail',
        name: 'GoogleSlidesGetThumbnail',
        description: 'Gets a fresh slide thumbnail URL for visual verification after writes. Use LARGE thumbnails for production deck QA.',
        input_schema: {
            type: 'object',
            properties: {
                presentation_id: idParam('Presentation ID.'),
                page_object_id: idParam('Slide/page object ID.'),
                thumbnail_size: { type: 'string', enum: ['LARGE', 'MEDIUM', 'SMALL'] },
            },
            required: ['presentation_id', 'page_object_id'],
        },
        tags: ['read', 'google-slides', 'presentation', 'visual-qa'],
    },
    {
        id: 'GoogleSlidesCreateSlide',
        name: 'GoogleSlidesCreateSlide',
        description: 'Creates a slide. For modern decks, prefer BLANK and then add deliberate full-slide composition via BatchUpdate.',
        input_schema: writeSchema({
            presentation_id: idParam('Presentation ID.'),
            object_id: { type: 'string', description: 'Optional slide object ID.' },
            insertion_index: { type: 'integer', description: 'Zero-based insertion index.' },
            predefined_layout: { type: 'string', description: 'Slides predefined layout, e.g. BLANK, TITLE, TITLE_AND_BODY.' },
        }, ['presentation_id', 'confirmed_by_user']),
        tags: ['write', 'google-slides', 'presentation', 'external_action'],
    },
    {
        id: 'GoogleSlidesInsertTextBox',
        name: 'GoogleSlidesInsertTextBox',
        description: 'Creates a text box and inserts text using point geometry. Use for precise, modern slide composition; follow with BatchUpdate styling.',
        input_schema: writeSchema({
            presentation_id: idParam('Presentation ID.'),
            page_object_id: idParam('Slide object ID.'),
            object_id: { type: 'string', description: 'Optional text box object ID.' },
            text: { type: 'string', description: 'Text content.' },
            x_pt: { type: 'number', description: 'Left offset in points.' },
            y_pt: { type: 'number', description: 'Top offset in points.' },
            width_pt: { type: 'number', description: 'Width in points.' },
            height_pt: { type: 'number', description: 'Height in points.' },
        }, ['presentation_id', 'page_object_id', 'text', 'x_pt', 'y_pt', 'width_pt', 'height_pt', 'confirmed_by_user']),
        tags: ['write', 'google-slides', 'presentation', 'external_action'],
    },
    {
        id: 'GoogleSlidesReplaceAllText',
        name: 'GoogleSlidesReplaceAllText',
        description: 'Replaces placeholder text across a deck or selected slides. Use for template fill after reading slide IDs.',
        input_schema: writeSchema({
            presentation_id: idParam('Presentation ID.'),
            contains_text: { type: 'string', description: 'Text/placeholder to find.' },
            replace_text: { type: 'string', description: 'Replacement text.' },
            match_case: { type: 'boolean' },
            page_object_ids: { type: 'array', items: { type: 'string' }, description: 'Optional slide IDs to restrict replacement.' },
        }, ['presentation_id', 'contains_text', 'confirmed_by_user']),
        tags: ['write', 'google-slides', 'presentation', 'external_action'],
    },
    {
        id: 'GoogleSlidesBatchUpdate',
        name: 'GoogleSlidesBatchUpdate',
        description: [
            'Advanced native Slides batchUpdate for production decks: createSlide, createShape, createImage, createLine, createTable, insertText, updateTextStyle, updateParagraphStyle, updatePageElementTransform, updateShapeProperties, updateLineProperties, group/ungroup, replaceAllText, replaceImage, duplicateObject, deleteObject, charts, videos, speaker notes, and theme-aware layouts.',
            'Use exact object IDs and point geometry. For modern decks, create a coherent visual system, avoid dense card grids unless appropriate, use strong hierarchy, keep titles single-line, prevent overlap/clipping, and verify every touched slide with GoogleSlidesGetPage plus GoogleSlidesGetThumbnail.',
        ].join(' '),
        input_schema: writeSchema({
            presentation_id: idParam('Presentation ID.'),
            requests: { type: 'array', items: { type: 'object' }, description: 'Raw Google Slides API Request[] payload.' },
            write_control: { type: 'object', description: 'Optional writeControl.' },
        }, ['presentation_id', 'requests', 'confirmed_by_user']),
        tags: ['write', 'google-slides', 'presentation', 'external_action'],
    },
]

export async function executeGoogleSlidesCreatePresentation(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Slides presentation')
    const title = stringArg(args, ['title', 'name'])
    if (!title) return missing('title')
    return { success: true, data: await googleSlidesCreatePresentation(title) }
}

export async function executeGoogleSlidesGetPresentation(args: Record<string, unknown>): Promise<ToolResult> {
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    if (!presentationId) return missing('presentation_id')
    return { success: true, data: await googleSlidesGetPresentation(presentationId) }
}

export async function executeGoogleSlidesGetPage(args: Record<string, unknown>): Promise<ToolResult> {
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    const pageObjectId = stringArg(args, ['page_object_id', 'pageObjectId'])
    if (!presentationId) return missing('presentation_id')
    if (!pageObjectId) return missing('page_object_id')
    return { success: true, data: await googleSlidesGetPage(presentationId, pageObjectId) }
}

export async function executeGoogleSlidesGetThumbnail(args: Record<string, unknown>): Promise<ToolResult> {
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    const pageObjectId = stringArg(args, ['page_object_id', 'pageObjectId'])
    if (!presentationId) return missing('presentation_id')
    if (!pageObjectId) return missing('page_object_id')
    return { success: true, data: await googleSlidesGetThumbnail({ presentationId, pageObjectId, thumbnailSize: enumArg(args, ['thumbnail_size', 'thumbnailSize'], ['LARGE', 'MEDIUM', 'SMALL']) }) }
}

export async function executeGoogleSlidesCreateSlide(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Slide')
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    if (!presentationId) return missing('presentation_id')
    return { success: true, data: await googleSlidesCreateSlide({ presentationId, objectId: stringArg(args, ['object_id', 'objectId']), insertionIndex: numberArg(args, ['insertion_index', 'insertionIndex'], 0), predefinedLayout: stringArg(args, ['predefined_layout', 'predefinedLayout']) }) }
}

export async function executeGoogleSlidesInsertTextBox(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Slides text box')
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    const pageObjectId = stringArg(args, ['page_object_id', 'pageObjectId'])
    const text = stringArg(args, ['text'])
    if (!presentationId) return missing('presentation_id')
    if (!pageObjectId) return missing('page_object_id')
    if (!text) return missing('text')
    return { success: true, data: await googleSlidesInsertTextBox({ presentationId, pageObjectId, objectId: stringArg(args, ['object_id', 'objectId']), text, xPt: numberArg(args, ['x_pt', 'xPt'], 0), yPt: numberArg(args, ['y_pt', 'yPt'], 0), widthPt: numberArg(args, ['width_pt', 'widthPt'], 200), heightPt: numberArg(args, ['height_pt', 'heightPt'], 80) }) }
}

export async function executeGoogleSlidesReplaceAllText(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('replacing Google Slides text')
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    const containsText = stringArg(args, ['contains_text', 'containsText'])
    if (!presentationId) return missing('presentation_id')
    if (!containsText) return missing('contains_text')
    return { success: true, data: await googleSlidesReplaceAllText({ presentationId, containsText, replaceText: stringArg(args, ['replace_text', 'replaceText']), matchCase: booleanArg(args, ['match_case', 'matchCase']), pageObjectIds: stringArrayArg(args, ['page_object_ids', 'pageObjectIds']) }) }
}

export async function executeGoogleSlidesBatchUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('running Google Slides batchUpdate')
    const presentationId = stringArg(args, ['presentation_id', 'presentationId'])
    if (!presentationId) return missing('presentation_id')
    if (!Array.isArray(args.requests)) return { success: false, error: 'requests must be an array.' }
    return { success: true, data: await googleSlidesBatchUpdate(presentationId, args.requests, objectArg(args.write_control ?? args.writeControl)) }
}

function writeSchema(properties: Record<string, ToolParameter>, required: string[]): ToolParameter {
    return { type: 'object', properties: { ...properties, confirmed_by_user: { type: 'boolean', description: 'Must be true only after explicit approval for this exact Google Slides write.' } }, required }
}

function idParam(description: string): ToolParameter {
    return { type: 'string', description }
}

function stringArrayArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function enumArg<T extends string>(args: Record<string, unknown>, keys: string[], allowed: readonly T[]): T | undefined {
    const value = stringArg(args, keys)
    return allowed.includes(value as T) ? value as T : undefined
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
