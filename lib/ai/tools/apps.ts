import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import type { ToolExecutionContext } from '@/lib/ai/agents/types'
import { getArtifactById, listVersionsForIdentifier } from '@/lib/artifacts/store'
import {
    APP_CODE_TYPES,
    APP_DATA_MAX_BYTES,
    deleteApp,
    getApp,
    getAppData,
    listApps,
    normalizeAppSlug,
    saveApp,
    setAppData,
} from '@/lib/apps/store'

// ---------------------------------------------------------------------------
// Internal apps tools.
//
// "Apps" are reusable mini-apps the orchestrator builds as html/react
// artifacts and registers under a stable slug so they survive the
// conversation that created them. Code and data are deliberately separate:
// the artifact holds only the UI/logic, while a per-app JSON document (shared
// with the running app through the AppHost iframe bridge) holds everything
// that changes — so updating data never requires re-emitting code.
// ---------------------------------------------------------------------------

export const APPS_LIST_TOOL_ID = 'AppsList'
export const APP_GET_TOOL_ID = 'AppGet'
export const APP_SAVE_TOOL_ID = 'AppSave'
export const APP_DELETE_TOOL_ID = 'AppDelete'
export const APP_DATA_GET_TOOL_ID = 'AppDataGet'
export const APP_DATA_SET_TOOL_ID = 'AppDataSet'
export const APP_SHOW_TOOL_ID = 'AppShow'

export const appsListTool: ToolDef = {
    id: APPS_LIST_TOOL_ID,
    name: APPS_LIST_TOOL_ID,
    description: [
        'List every registered internal app (slug, title, description, data summary, last update).',
        'Call this FIRST whenever the user mentions a tool/app you may have built before (by name, by purpose, or just "aplicația aia") and before minting a new slug with AppSave — reuse an existing app instead of creating a near-duplicate.',
        'Entries with `codeMissing: true` lost their backing artifact (conversation deleted); rebuild the code and AppSave the same slug to restore them.',
    ].join(' '),
    input_schema: { type: 'object', properties: {} },
    tags: ['apps'],
}

export const appGetTool: ToolDef = {
    id: APP_GET_TOOL_ID,
    name: APP_GET_TOOL_ID,
    description: [
        'Fetch one registered app by slug or id: metadata, the data document, and optionally the full source code.',
        'Use includeCode: true only when you actually need to read or modify the code — html/react sources can be large.',
        'The data document is the single source of truth the running app renders from; read it before changing it so your merge patch fits the existing schema.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            app: { type: 'string', description: 'App slug (preferred) or registry id.' },
            includeCode: { type: 'boolean', description: 'Include the full artifact source. Default false.' },
            includeData: { type: 'boolean', description: 'Include the JSON data document. Default true.' },
        },
        required: ['app'],
    },
    tags: ['apps'],
}

export const appSaveTool: ToolDef = {
    id: APP_SAVE_TOOL_ID,
    name: APP_SAVE_TOOL_ID,
    description: [
        'Register an artifact as a reusable app, or repoint an existing app to new code. Upserts by slug: saving to an existing slug IS the update path and reports the previous artifact id.',
        'Pass `identifier` to use the latest version of an artifact you emitted in THIS conversation (the normal flow right after authoring), or `artifactId` to point at a specific artifact row from any conversation.',
        'Only text/html and application/vnd.ant.react artifacts can be apps.',
        'Write `description` for your future self: include what the app does AND the shape of its data document so a later conversation can extend it safely.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            slug: { type: 'string', description: 'Stable kebab-case handle, e.g. "calorie-calculator". Check AppsList before minting a new one.' },
            title: { type: 'string', description: 'Human title shown in Library and launch cards.' },
            description: { type: 'string', description: 'What the app does + data document schema notes. Shown in Library.' },
            icon: { type: 'string', description: 'Optional single emoji used as the app icon.' },
            identifier: { type: 'string', description: 'Artifact identifier in the CURRENT conversation; resolves to its latest version. Use this right after emitting the artifact.' },
            artifactId: { type: 'string', description: 'Exact artifact row UUID (any conversation). Alternative to identifier.' },
        },
        required: ['slug', 'title'],
    },
    tags: ['apps'],
}

export const appDeleteTool: ToolDef = {
    id: APP_DELETE_TOOL_ID,
    name: APP_DELETE_TOOL_ID,
    description: [
        'Unregister an app by slug or id, ONLY on explicit user request. Deletes its data document; the code artifact stays in its conversation.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            app: { type: 'string', description: 'App slug or registry id.' },
        },
        required: ['app'],
    },
    tags: ['apps'],
}

export const appDataGetTool: ToolDef = {
    id: APP_DATA_GET_TOOL_ID,
    name: APP_DATA_GET_TOOL_ID,
    description: [
        "Read an app's JSON data document (by slug or id).",
        'This is the same document the running app reads/writes through window.AppHost, so it also answers questions about what the user did inside the app (logged entries, saved selections).',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            app: { type: 'string', description: 'App slug or registry id.' },
        },
        required: ['app'],
    },
    tags: ['apps'],
}

export const appDataSetTool: ToolDef = {
    id: APP_DATA_SET_TOOL_ID,
    name: APP_DATA_SET_TOOL_ID,
    description: [
        "Update an app's JSON data document. Default mode \"merge\" applies an RFC 7396 merge patch: objects merge recursively, a null value DELETES that key, arrays and scalars replace wholesale. Mode \"replace\" swaps the whole document.",
        'To append to an array you must send the full new array (read it with AppDataGet first).',
        'Use this — never re-emit the artifact code — when only data changes (new entries, updated values, imported records). Open instances of the app update live.',
        `Document cap: ${Math.round(APP_DATA_MAX_BYTES / 1024)} KiB serialized.`,
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            app: { type: 'string', description: 'App slug or registry id.' },
            data: { type: 'object', description: 'Merge patch (mode "merge") or the full replacement document (mode "replace").' },
            mode: { type: 'string', enum: ['merge', 'replace'], description: 'Default "merge".' },
        },
        required: ['app', 'data'],
    },
    tags: ['apps'],
}

export const appShowTool: ToolDef = {
    id: APP_SHOW_TOOL_ID,
    name: APP_SHOW_TOOL_ID,
    description: [
        'Mount a launch card for a registered app in the current chat. The card always opens the app\'s CURRENT code version, so use this instead of re-emitting the artifact when the user wants to open an existing app.',
        'Call after AppSave when creating/updating an app, or whenever the user asks to open one.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            app: { type: 'string', description: 'App slug or registry id.' },
        },
        required: ['app'],
    },
    tags: ['apps'],
}

export const APPS_TOOLS: ToolDef[] = [
    appsListTool,
    appGetTool,
    appSaveTool,
    appDeleteTool,
    appDataGetTool,
    appDataSetTool,
    appShowTool,
]

// === execution =============================================================

function unknownAppError(ref: string): ToolResult {
    const slugs = listApps().map((a) => a.slug)
    return {
        success: false,
        error: `Unknown app "${ref}". Registered apps: ${slugs.length ? slugs.join(', ') : '(none yet — create one with AppSave)'}.`,
    }
}

export async function executeAppsList(): Promise<ToolResult> {
    const apps = listApps().map((a) => ({
        slug: a.slug,
        title: a.title,
        description: a.description,
        icon: a.icon,
        codeType: a.codeType,
        codeMissing: a.codeMissing,
        artifactId: a.artifactId,
        dataBytes: a.dataBytes,
        dataKeys: a.dataKeys,
        dataUpdatedAt: a.dataUpdatedAt,
        updatedAt: a.updatedAt,
    }))
    return {
        success: true,
        data: {
            apps,
            total: apps.length,
            hint: apps.some((a) => a.codeMissing)
                ? 'Apps with codeMissing lost their backing artifact — re-author the code and AppSave the same slug to restore.'
                : undefined,
        },
    }
}

export async function executeAppGet(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = typeof args.app === 'string' ? args.app.trim() : ''
    if (!ref) return { success: false, error: 'AppGet requires `app` (slug or id).' }
    const app = getApp(ref)
    if (!app) return unknownAppError(ref)

    const includeCode = args.includeCode === true
    const includeData = args.includeData !== false

    let code: { artifactId: string; type: string; title: string; content: string } | null = null
    if (includeCode) {
        const artifact = getArtifactById(app.artifactId)
        if (artifact) {
            code = { artifactId: artifact.id, type: artifact.type, title: artifact.title, content: artifact.content }
        }
    }

    return {
        success: true,
        data: {
            app: {
                id: app.id,
                slug: app.slug,
                title: app.title,
                description: app.description,
                icon: app.icon,
                artifactId: app.artifactId,
                codeType: app.codeType,
                codeMissing: app.codeMissing,
                createdAt: app.createdAt,
                updatedAt: app.updatedAt,
            },
            data: includeData ? getAppData(app.id) : undefined,
            code,
            codeNote: includeCode && !code
                ? 'Backing artifact is gone — re-author the code and AppSave the same slug.'
                : undefined,
        },
    }
}

export async function executeAppSave(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const slugRaw = typeof args.slug === 'string' ? args.slug : ''
    const slug = normalizeAppSlug(slugRaw)
    if (!slug) {
        return { success: false, error: `AppSave slug "${slugRaw}" must be kebab-case (lowercase letters, digits, hyphens).` }
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return { success: false, error: 'AppSave requires a non-empty `title`.' }

    const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : ''
    const artifactIdArg = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
    if (!identifier && !artifactIdArg) {
        return { success: false, error: 'AppSave requires `identifier` (artifact in this conversation) or `artifactId`.' }
    }

    let artifactId = artifactIdArg
    if (!artifactId) {
        const conversationId = ctx?.conversationId
        if (!conversationId) {
            return { success: false, error: 'AppSave with `identifier` needs a conversation context; pass `artifactId` instead.' }
        }
        const versions = listVersionsForIdentifier(conversationId, identifier)
        const latest = versions[versions.length - 1]
        if (!latest) {
            return { success: false, error: `No artifact with identifier "${identifier}" in this conversation. Emit the artifact first, then AppSave.` }
        }
        artifactId = latest.id
    }

    const artifact = getArtifactById(artifactId)
    if (!artifact) {
        return { success: false, error: `Artifact "${artifactId}" not found.` }
    }
    if (!(APP_CODE_TYPES as readonly string[]).includes(artifact.type)) {
        return {
            success: false,
            error: `Artifact type "${artifact.type}" cannot be an app. Allowed: ${APP_CODE_TYPES.join(', ')}.`,
        }
    }

    const description = typeof args.description === 'string' ? args.description.trim() || null : undefined
    const icon = typeof args.icon === 'string' ? args.icon.trim() || null : undefined

    const result = saveApp({ slug, title, description, icon, artifactId })
    return {
        success: true,
        data: {
            created: result.created,
            updated: !result.created,
            previousArtifactId: result.previousArtifactId,
            app: result.app,
            note: result.created
                ? 'App registered. Call AppShow to mount its launch card, and seed initial data with AppDataSet if the app expects any.'
                : `Repointed "${slug}" from artifact ${result.previousArtifactId} to ${artifactId}. Existing data document untouched.`,
        },
    }
}

export async function executeAppDelete(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = typeof args.app === 'string' ? args.app.trim() : ''
    if (!ref) return { success: false, error: 'AppDelete requires `app` (slug or id).' }
    const app = getApp(ref)
    if (!app) return unknownAppError(ref)
    deleteApp(app.id)
    return {
        success: true,
        data: { deleted: true, slug: app.slug, note: 'App unregistered and its data document deleted. The code artifact remains in its conversation.' },
    }
}

export async function executeAppDataGet(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = typeof args.app === 'string' ? args.app.trim() : ''
    if (!ref) return { success: false, error: 'AppDataGet requires `app` (slug or id).' }
    const app = getApp(ref)
    if (!app) return unknownAppError(ref)
    const doc = getAppData(app.id)
    return {
        success: true,
        data: { slug: app.slug, data: doc.data, updatedAt: doc.updatedAt || null },
    }
}

export async function executeAppDataSet(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = typeof args.app === 'string' ? args.app.trim() : ''
    if (!ref) return { success: false, error: 'AppDataSet requires `app` (slug or id).' }
    const app = getApp(ref)
    if (!app) return unknownAppError(ref)
    if (args.data === undefined || args.data === null || typeof args.data !== 'object' || Array.isArray(args.data)) {
        return { success: false, error: 'AppDataSet requires `data` to be a JSON object (merge patch or full document).' }
    }
    const mode = args.mode === 'replace' ? 'replace' : 'merge'
    try {
        const result = setAppData(app.id, args.data, mode)
        return {
            success: true,
            data: {
                slug: app.slug,
                mode,
                bytes: result.bytes,
                updatedAt: result.updatedAt,
                topLevelKeys: result.data && typeof result.data === 'object' && !Array.isArray(result.data)
                    ? Object.keys(result.data as Record<string, unknown>).slice(0, 20)
                    : [],
                note: 'Open instances of the app receive the new data live.',
            },
        }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

export async function executeAppShow(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = typeof args.app === 'string' ? args.app.trim() : ''
    if (!ref) return { success: false, error: 'AppShow requires `app` (slug or id).' }
    const app = getApp(ref)
    if (!app) return unknownAppError(ref)
    if (app.codeMissing) {
        return {
            success: false,
            error: `App "${app.slug}" has no backing artifact (codeMissing). Re-author the code and AppSave the same slug, then AppShow.`,
        }
    }

    const body = JSON.stringify({
        appId: app.id,
        slug: app.slug,
        title: app.title,
        description: app.description ?? undefined,
        icon: app.icon ?? undefined,
        artifactId: app.artifactId,
    })

    return {
        success: true,
        data: {
            identifier: `app-link-${app.slug}`,
            title: app.title,
            type: 'application/vnd.ant.app-link',
            display: 'inline',
            body,
            directEmit: true,
        },
    }
}
