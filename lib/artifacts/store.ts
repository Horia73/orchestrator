import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import db from '@/lib/db'
import { ARTIFACTS_DIR } from '@/lib/config'
import { emitAppEvent } from '@/lib/events'
import { type ArtifactRow, type ArtifactDisplay } from './schema'
import { validateArtifactContent } from './validation'

// ---------------------------------------------------------------------------
// Artifact persistence layer.
//
// Each completed artifact block in an assistant turn lands here. Versioning
// is monotone-per-(conversation, identifier): same identifier reused = next
// version. Older versions stay so the panel can show history.
// ---------------------------------------------------------------------------

interface RawArtifactRow {
    id: string
    conversationId: string
    messageId: string
    identifier: string
    version: number
    type: string
    title: string
    language: string | null
    display: string | null
    filePath: string | null
    content: string
    createdAt: number
}

interface RawArtifactListRow extends RawArtifactRow {
    conversationTitle: string | null
}

export interface ArtifactListItem extends ArtifactRow {
    conversationTitle: string | null
}

function resolveArtifactReadPath(filePath: string): string | null {
    try {
        const root = fs.realpathSync(/* turbopackIgnore: true */ ARTIFACTS_DIR)
        const target = fs.realpathSync(/* turbopackIgnore: true */ filePath)
        const rel = path.relative(root, target)
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
        return target
    } catch {
        return null
    }
}

function parseRow(r: RawArtifactRow): ArtifactRow {
    let content = r.content
    if (r.filePath) {
        try {
            const filePath = resolveArtifactReadPath(r.filePath)
            if (filePath) content = fs.readFileSync(/* turbopackIgnore: true */ filePath, 'utf8')
        } catch {
            // Fall back to the SQLite snapshot if the backing file is unreadable.
        }
    }
    return {
        ...r,
        display: r.display as ArtifactDisplay | null,
        content,
    }
}

function parseListRow(r: RawArtifactListRow): ArtifactListItem {
    return {
        ...parseRow(r),
        conversationTitle: r.conversationTitle,
    }
}

interface InsertArgs {
    conversationId: string
    messageId: string
    identifier: string
    type: string
    title: string
    language?: string | null
    display?: ArtifactDisplay | null
    content: string
}

function safePathPart(value: string): string {
    return value
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96) || 'artifact'
}

function extensionFor(type: string, language?: string | null): string {
    switch (type) {
        case 'text/markdown': return 'md'
        case 'application/vnd.ant.mermaid': return 'mmd'
        case 'image/svg+xml': return 'svg'
        case 'text/csv': return 'csv'
        case 'application/json': return 'json'
        case 'application/x-latex': return 'tex'
        case 'text/html': return 'html'
        case 'application/vnd.ant.react': return 'tsx'
        case 'application/vnd.ant.map': return 'json'
        case 'application/vnd.ant.weather': return 'json'
        case 'application/vnd.ant.recipe': return 'json'
        case 'application/vnd.ant.workout': return 'json'
        case 'application/xml': return 'xml'
        case 'text/vnd.graphviz': return 'dot'
        case 'application/vnd.ant.code': return safePathPart(language ?? 'txt')
        default: return safePathPart(language ?? 'txt')
    }
}

function artifactFilePath(args: InsertArgs, version: number): string {
    const conversationDir = safePathPart(args.conversationId)
    const identifierDir = safePathPart(args.identifier)
    const ext = extensionFor(args.type, args.language)
    return path.join(ARTIFACTS_DIR, conversationDir, identifierDir, `v${version}.${ext}`)
}

/**
 * Persist a finished artifact. Computes the next version inside
 * (conversationId, identifier) atomically — so two concurrent inserts can't
 * collide on the same version number.
 */
export function insertArtifact(args: InsertArgs): ArtifactRow {
    const validation = validateArtifactContent(args.type, args.content)
    if (!validation.ok) {
        throw new Error(`Invalid artifact "${args.identifier}": ${validation.error}`)
    }

    const id = randomUUID()
    const createdAt = Date.now()

    const inserted = db.transaction((): ArtifactRow => {
        const row = db
            .prepare(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next
                   FROM artifacts
                  WHERE conversationId = ? AND identifier = ?`
            )
            .get(args.conversationId, args.identifier) as { next: number }
        const version = row.next
        const filePath = artifactFilePath(args, version)
        fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(filePath), { recursive: true })
        fs.writeFileSync(/* turbopackIgnore: true */ filePath, args.content, 'utf8')

        db.prepare(`
            INSERT INTO artifacts (id, conversationId, messageId, identifier, version, type, title, language, display, filePath, content, createdAt)
            VALUES (@id, @conversationId, @messageId, @identifier, @version, @type, @title, @language, @display, @filePath, @content, @createdAt)
        `).run({
            id,
            conversationId: args.conversationId,
            messageId: args.messageId,
            identifier: args.identifier,
            version,
            type: args.type,
            title: args.title,
            language: args.language ?? null,
            display: args.display ?? null,
            filePath,
            content: args.content,
            createdAt,
        })

        return {
            id,
            conversationId: args.conversationId,
            messageId: args.messageId,
            identifier: args.identifier,
            version,
            type: args.type,
            title: args.title,
            language: args.language ?? null,
            display: args.display ?? null,
            filePath,
            content: args.content,
            createdAt,
        }
    })()

    emitAppEvent({
        type: 'artifacts.changed',
        conversationId: inserted.conversationId,
        messageId: inserted.messageId,
        artifactId: inserted.id,
        action: 'created',
    })

    return inserted
}

/** All artifact versions for a conversation, oldest first per identifier chain. */
export function listArtifactsForConversation(conversationId: string): ArtifactRow[] {
    const rows = db
        .prepare(
            `SELECT * FROM artifacts
              WHERE conversationId = ?
              ORDER BY identifier ASC, version ASC`
        )
        .all(conversationId) as RawArtifactRow[]
    return rows.map(parseRow)
}

/** Latest version of each identifier in a conversation. Useful for the panel default state. */
export function listLatestArtifactsForConversation(conversationId: string): ArtifactRow[] {
    const rows = db
        .prepare(
            `SELECT a.* FROM artifacts a
              JOIN (
                  SELECT identifier, MAX(version) AS v
                    FROM artifacts
                   WHERE conversationId = ?
                   GROUP BY identifier
              ) m ON m.identifier = a.identifier AND m.v = a.version
              WHERE a.conversationId = ?
              ORDER BY a.createdAt ASC`
        )
        .all(conversationId, conversationId) as RawArtifactRow[]
    return rows.map(parseRow)
}

export function getArtifactById(id: string): ArtifactRow | null {
    const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as RawArtifactRow | undefined
    return row ? parseRow(row) : null
}

export function deleteArtifactIdentifierChainById(
    id: string,
    options: { conversationId?: string; type?: string } = {},
): { deleted: number; row: ArtifactRow | null } {
    const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as RawArtifactRow | undefined
    if (!row) return { deleted: 0, row: null }
    if (options.conversationId && row.conversationId !== options.conversationId) {
        return { deleted: 0, row: parseRow(row) }
    }
    if (options.type && row.type !== options.type) {
        return { deleted: 0, row: parseRow(row) }
    }

    const rows = db.prepare(
        `SELECT * FROM artifacts
          WHERE conversationId = ?
            AND identifier = ?
            AND (? IS NULL OR type = ?)`,
    ).all(row.conversationId, row.identifier, options.type ?? null, options.type ?? null) as RawArtifactRow[]

    const result = db.prepare(
        `DELETE FROM artifacts
          WHERE conversationId = ?
            AND identifier = ?
            AND (? IS NULL OR type = ?)`,
    ).run(row.conversationId, row.identifier, options.type ?? null, options.type ?? null)

    for (const item of rows) {
        if (!item.filePath) continue
        const filePath = resolveArtifactReadPath(item.filePath)
        if (!filePath) continue
        try {
            fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true })
        } catch {
            // The database row is the source of truth; stale files can be
            // ignored if the OS races us or the backing file was already gone.
        }
    }

    return { deleted: result.changes, row: parseRow(row) }
}

/** Latest versions for a MIME type across all conversations, newest first. */
export function listLatestArtifactsByType(type: string, limit = 100): ArtifactListItem[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500))
    const rows = db
        .prepare(
            `SELECT a.*, c.title AS conversationTitle
               FROM artifacts a
               JOIN (
                   SELECT conversationId, identifier, MAX(version) AS v
                     FROM artifacts
                    WHERE type = ?
                    GROUP BY conversationId, identifier
               ) m ON m.conversationId = a.conversationId
                  AND m.identifier = a.identifier
                  AND m.v = a.version
               LEFT JOIN conversations c ON c.id = a.conversationId
              WHERE a.type = ?
              ORDER BY a.createdAt DESC
              LIMIT ?`
        )
        .all(type, type, safeLimit) as RawArtifactListRow[]
    return rows.map(parseListRow)
}

/** All versions for a specific identifier, version asc. Powers the panel's version dropdown. */
export function listVersionsForIdentifier(conversationId: string, identifier: string): ArtifactRow[] {
    const rows = db
        .prepare(`SELECT * FROM artifacts WHERE conversationId = ? AND identifier = ? ORDER BY version ASC`)
        .all(conversationId, identifier) as RawArtifactRow[]
    return rows.map(parseRow)
}

export function copyArtifactsForMessageMap(args: {
    fromConversationId: string
    toConversationId: string
    messageIdMap: Map<string, string>
}): ArtifactRow[] {
    const copied: ArtifactRow[] = []
    for (const [fromMessageId, toMessageId] of args.messageIdMap) {
        const rows = db
            .prepare(
                `SELECT * FROM artifacts
                  WHERE conversationId = ?
                    AND messageId = ?
                  ORDER BY identifier ASC, version ASC`
            )
            .all(args.fromConversationId, fromMessageId) as RawArtifactRow[]
        for (const row of rows.map(parseRow)) {
            const validation = validateArtifactContent(row.type, row.content)
            if (!validation.ok) {
                console.warn(`Skipping invalid artifact "${row.identifier}" during copy: ${validation.error}`)
                continue
            }
            copied.push(insertArtifact({
                conversationId: args.toConversationId,
                messageId: toMessageId,
                identifier: row.identifier,
                type: row.type,
                title: row.title,
                language: row.language,
                display: row.display,
                content: row.content,
            }))
        }
    }
    return copied
}
