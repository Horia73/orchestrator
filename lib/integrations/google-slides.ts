import { googleWorkspaceJson } from './google-drive'

const GOOGLE_SLIDES_API_BASE = 'https://slides.googleapis.com/v1'

export interface GoogleSlidesPresentationSummary {
    presentationId: string
    title: string
    url: string
    pageSize: unknown | null
    slides: Array<{
        objectId: string
        pageType: string
        elementCount: number
        revisionId: string | null
    }>
    masters: number
    layouts: number
}

export interface GoogleSlidesBatchUpdateResult {
    presentationId: string
    replies: unknown[]
}

interface SlidesPresentation {
    presentationId?: string
    title?: string
    pageSize?: unknown
    slides?: SlidesPage[]
    masters?: unknown[]
    layouts?: unknown[]
}

interface SlidesPage {
    objectId?: string
    pageType?: string
    pageElements?: unknown[]
    revisionId?: string
}

export async function googleSlidesCreatePresentation(title: string): Promise<GoogleSlidesPresentationSummary> {
    const presentation = await googleWorkspaceJson<SlidesPresentation>(GOOGLE_SLIDES_API_BASE, '/presentations', {
        method: 'POST',
        body: JSON.stringify({ title: cleanRequired(title, 'title') }),
    })
    return summarizePresentation(presentation)
}

export async function googleSlidesGetPresentation(presentationId: string): Promise<GoogleSlidesPresentationSummary> {
    const presentation = await googleWorkspaceJson<SlidesPresentation>(
        GOOGLE_SLIDES_API_BASE,
        `/presentations/${encodeURIComponent(cleanRequired(presentationId, 'presentation_id'))}`
    )
    return summarizePresentation(presentation)
}

export async function googleSlidesGetPage(presentationId: string, pageObjectId: string): Promise<SlidesPage> {
    return googleWorkspaceJson<SlidesPage>(
        GOOGLE_SLIDES_API_BASE,
        `/presentations/${encodeURIComponent(cleanRequired(presentationId, 'presentation_id'))}/pages/${encodeURIComponent(cleanRequired(pageObjectId, 'page_object_id'))}`
    )
}

export async function googleSlidesGetThumbnail(args: {
    presentationId: string
    pageObjectId: string
    thumbnailSize?: 'LARGE' | 'MEDIUM' | 'SMALL'
    mimeType?: 'PNG'
}) {
    const params = new URLSearchParams({
        'thumbnailProperties.thumbnailSize': args.thumbnailSize ?? 'LARGE',
        'thumbnailProperties.mimeType': args.mimeType ?? 'PNG',
    })
    return googleWorkspaceJson<{ contentUrl?: string; width?: number; height?: number }>(
        GOOGLE_SLIDES_API_BASE,
        `/presentations/${encodeURIComponent(cleanRequired(args.presentationId, 'presentation_id'))}/pages/${encodeURIComponent(cleanRequired(args.pageObjectId, 'page_object_id'))}/thumbnail?${params.toString()}`
    )
}

export async function googleSlidesBatchUpdate(presentationId: string, requests: unknown[], writeControl?: unknown): Promise<GoogleSlidesBatchUpdateResult> {
    const cleanPresentationId = cleanRequired(presentationId, 'presentation_id')
    if (!Array.isArray(requests) || requests.length === 0) throw new Error('Google Slides batchUpdate requires at least one request.')
    const response = await googleWorkspaceJson<{ presentationId?: string; replies?: unknown[] }>(
        GOOGLE_SLIDES_API_BASE,
        `/presentations/${encodeURIComponent(cleanPresentationId)}:batchUpdate`,
        {
            method: 'POST',
            body: JSON.stringify({
                requests,
                ...(writeControl ? { writeControl } : {}),
            }),
        }
    )
    return {
        presentationId: response.presentationId ?? cleanPresentationId,
        replies: response.replies ?? [],
    }
}

export async function googleSlidesCreateSlide(args: {
    presentationId: string
    objectId?: string
    insertionIndex?: number
    predefinedLayout?: string
}) {
    return googleSlidesBatchUpdate(args.presentationId, [{
        createSlide: {
            ...(args.objectId ? { objectId: args.objectId } : {}),
            insertionIndex: Math.max(0, Math.floor(args.insertionIndex ?? 0)),
            slideLayoutReference: { predefinedLayout: args.predefinedLayout || 'BLANK' },
        },
    }])
}

export async function googleSlidesReplaceAllText(args: {
    presentationId: string
    containsText: string
    replaceText: string
    matchCase?: boolean
    pageObjectIds?: string[]
}) {
    return googleSlidesBatchUpdate(args.presentationId, [{
        replaceAllText: {
            containsText: {
                text: cleanRequired(args.containsText, 'contains_text'),
                matchCase: args.matchCase === true,
            },
            replaceText: args.replaceText ?? '',
            ...(args.pageObjectIds?.length ? { pageObjectIds: args.pageObjectIds } : {}),
        },
    }])
}

export async function googleSlidesInsertTextBox(args: {
    presentationId: string
    pageObjectId: string
    objectId?: string
    text: string
    xPt: number
    yPt: number
    widthPt: number
    heightPt: number
}) {
    const objectId = args.objectId || `textbox_${Date.now()}`
    return googleSlidesBatchUpdate(args.presentationId, [
        {
            createShape: {
                objectId,
                shapeType: 'TEXT_BOX',
                elementProperties: {
                    pageObjectId: cleanRequired(args.pageObjectId, 'page_object_id'),
                    size: {
                        width: { magnitude: positive(args.widthPt, 'width_pt'), unit: 'PT' },
                        height: { magnitude: positive(args.heightPt, 'height_pt'), unit: 'PT' },
                    },
                    transform: {
                        scaleX: 1,
                        scaleY: 1,
                        translateX: Math.max(0, args.xPt),
                        translateY: Math.max(0, args.yPt),
                        unit: 'PT',
                    },
                },
            },
        },
        {
            insertText: {
                objectId,
                insertionIndex: 0,
                text: cleanRequired(args.text, 'text'),
            },
        },
    ])
}

function summarizePresentation(presentation: SlidesPresentation): GoogleSlidesPresentationSummary {
    const presentationId = presentation.presentationId ?? ''
    return {
        presentationId,
        title: presentation.title ?? '',
        url: presentationId ? `https://docs.google.com/presentation/d/${presentationId}/edit` : '',
        pageSize: presentation.pageSize ?? null,
        slides: (presentation.slides ?? []).map(slide => ({
            objectId: slide.objectId ?? '',
            pageType: slide.pageType ?? '',
            elementCount: slide.pageElements?.length ?? 0,
            revisionId: slide.revisionId ?? null,
        })),
        masters: presentation.masters?.length ?? 0,
        layouts: presentation.layouts?.length ?? 0,
    }
}

function cleanRequired(value: string | undefined, name: string): string {
    const clean = (value ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw new Error(`Missing required parameter: ${name}`)
    return clean
}

function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`)
    return value
}
