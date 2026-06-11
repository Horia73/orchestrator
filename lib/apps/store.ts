import { randomUUID } from 'crypto'

import db from '@/lib/db'
import { emitAppEvent } from '@/lib/events'

// ---------------------------------------------------------------------------
// Internal apps registry.
//
// An "app" is a reusable mini-app the agent built once (calorie calculator,
// quoting tool, ...). Its code is a normal versioned html/react artifact;
// `artifactId` points at the current code version and gets repointed on
// updates — possibly from a different conversation than the one that created
// it. Its data is a single JSON document in `app_data`, shared between the
// agent (AppData* tools) and the running app (AppHost iframe bridge).
// ---------------------------------------------------------------------------

export const APP_CODE_TYPES = ['text/html', 'application/vnd.ant.react'] as const

/** Serialized data documents are capped so a runaway app/agent can't bloat the DB. */
export const APP_DATA_MAX_BYTES = 1024 * 1024

export interface AppRow {
    id: string
    slug: string
    title: string
    description: string | null
    icon: string | null
    artifactId: string
    createdAt: number
    updatedAt: number
}

export interface AppListItem extends AppRow {
    codeType: string | null
    codeMissing: boolean
    dataBytes: number
    dataKeys: string[]
    dataUpdatedAt: number | null
}

export interface AppDataDoc {
    data: unknown
    updatedAt: number
}

interface RawAppListRow extends AppRow {
    codeType: string | null
    dataJson: string | null
    dataUpdatedAt: number | null
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function normalizeAppSlug(value: string): string | null {
    const slug = value.trim().toLowerCase()
    return SLUG_RE.test(slug) ? slug : null
}

function topLevelKeys(json: string | null): string[] {
    if (!json) return []
    try {
        const parsed = JSON.parse(json)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.keys(parsed).slice(0, 20)
        }
    } catch {
        // Treat unparseable docs as opaque; size still reports.
    }
    return []
}

function parseListRow(r: RawAppListRow): AppListItem {
    const { dataJson, dataUpdatedAt, ...rest } = r
    return {
        ...rest,
        codeMissing: r.codeType == null,
        dataBytes: dataJson ? Buffer.byteLength(dataJson, 'utf8') : 0,
        dataKeys: topLevelKeys(dataJson),
        dataUpdatedAt: dataUpdatedAt ?? null,
    }
}

const LIST_SELECT = `
    SELECT p.*, a.type AS codeType, d.data AS dataJson, d.updatedAt AS dataUpdatedAt
      FROM apps p
      LEFT JOIN artifacts a ON a.id = p.artifactId
      LEFT JOIN app_data d ON d.appId = p.id
`

export function listApps(): AppListItem[] {
    const rows = db.prepare(`${LIST_SELECT} ORDER BY p.updatedAt DESC`).all() as RawAppListRow[]
    return rows.map(parseListRow)
}

/** Look an app up by slug or registry id. */
export function getApp(slugOrId: string): AppListItem | null {
    const row = db
        .prepare(`${LIST_SELECT} WHERE p.id = ? OR p.slug = ?`)
        .get(slugOrId, slugOrId) as RawAppListRow | undefined
    return row ? parseListRow(row) : null
}

/**
 * Resolve which registered app a rendered artifact belongs to. Matches the
 * exact current artifact, or any version in the same (conversationId,
 * identifier) chain — so the version dropdown and just-re-emitted (not yet
 * repointed) versions still bind to the app's data.
 */
export function resolveAppForArtifact(artifactId: string): AppRow | null {
    const row = db
        .prepare(
            `SELECT p.id, p.slug, p.title, p.description, p.icon, p.artifactId, p.createdAt, p.updatedAt
               FROM apps p
               JOIN artifacts cur ON cur.id = p.artifactId
               JOIN artifacts probe ON probe.conversationId = cur.conversationId
                                   AND probe.identifier = cur.identifier
              WHERE probe.id = ?
              LIMIT 1`
        )
        .get(artifactId) as AppRow | undefined
    return row ?? null
}

export interface SaveAppArgs {
    slug: string
    title: string
    description?: string | null
    icon?: string | null
    artifactId: string
}

export interface SaveAppResult {
    app: AppRow
    created: boolean
    previousArtifactId: string | null
}

/** Upsert by slug — registering a new app and repointing an existing one are the same call. */
export function saveApp(args: SaveAppArgs): SaveAppResult {
    const now = Date.now()
    const result = db.transaction((): SaveAppResult => {
        const existing = db.prepare(`SELECT * FROM apps WHERE slug = ?`).get(args.slug) as AppRow | undefined
        if (existing) {
            const updated: AppRow = {
                ...existing,
                title: args.title,
                description: args.description !== undefined ? args.description : existing.description,
                icon: args.icon !== undefined ? args.icon : existing.icon,
                artifactId: args.artifactId,
                updatedAt: now,
            }
            db.prepare(`
                UPDATE apps SET title = @title, description = @description, icon = @icon,
                       artifactId = @artifactId, updatedAt = @updatedAt
                 WHERE id = @id
            `).run(updated)
            return { app: updated, created: false, previousArtifactId: existing.artifactId }
        }
        const app: AppRow = {
            id: randomUUID(),
            slug: args.slug,
            title: args.title,
            description: args.description ?? null,
            icon: args.icon ?? null,
            artifactId: args.artifactId,
            createdAt: now,
            updatedAt: now,
        }
        db.prepare(`
            INSERT INTO apps (id, slug, title, description, icon, artifactId, createdAt, updatedAt)
            VALUES (@id, @slug, @title, @description, @icon, @artifactId, @createdAt, @updatedAt)
        `).run(app)
        return { app, created: true, previousArtifactId: null }
    })()

    emitAppEvent({ type: 'apps.changed', appId: result.app.id, action: result.created ? 'created' : 'updated' })
    return result
}

export function deleteApp(slugOrId: string): boolean {
    const app = getApp(slugOrId)
    if (!app) return false
    db.prepare(`DELETE FROM apps WHERE id = ?`).run(app.id)
    emitAppEvent({ type: 'apps.changed', appId: app.id, action: 'deleted' })
    return true
}

export function getAppData(appId: string): AppDataDoc {
    const row = db.prepare(`SELECT data, updatedAt FROM app_data WHERE appId = ?`).get(appId) as
        | { data: string; updatedAt: number }
        | undefined
    if (!row) return { data: {}, updatedAt: 0 }
    try {
        return { data: JSON.parse(row.data), updatedAt: row.updatedAt }
    } catch {
        return { data: {}, updatedAt: row.updatedAt }
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** RFC 7396 JSON merge-patch: null deletes a key, objects merge recursively, everything else replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
    if (!isPlainObject(patch)) return patch
    const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete base[key]
        } else {
            base[key] = mergePatch(base[key], value)
        }
    }
    return base
}

export function setAppData(
    appId: string,
    data: unknown,
    mode: 'merge' | 'replace' = 'merge',
): { data: unknown; bytes: number; updatedAt: number } {
    const next = mode === 'replace' ? data : mergePatch(getAppData(appId).data, data)
    const json = JSON.stringify(next ?? {})
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > APP_DATA_MAX_BYTES) {
        throw new Error(
            `App data document too large: ${bytes} bytes after ${mode} (cap ${APP_DATA_MAX_BYTES}). ` +
            `Trim old entries or restructure the document.`
        )
    }
    const updatedAt = Date.now()
    db.prepare(`
        INSERT INTO app_data (appId, data, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(appId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
    `).run(appId, json, updatedAt)

    emitAppEvent({ type: 'app_data.changed', appId })
    return { data: next ?? {}, bytes, updatedAt }
}
