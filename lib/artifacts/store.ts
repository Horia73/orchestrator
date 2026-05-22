import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import db from '@/lib/db'
import { ARTIFACTS_DIR } from '@/lib/config'
import { type ArtifactRow, type ArtifactDisplay } from './schema'

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
        case 'application/vnd.ant.weather': return 'json'
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

/** All versions for a specific identifier, version asc. Powers the panel's version dropdown. */
export function listVersionsForIdentifier(conversationId: string, identifier: string): ArtifactRow[] {
    const rows = db
        .prepare(`SELECT * FROM artifacts WHERE conversationId = ? AND identifier = ? ORDER BY version ASC`)
        .all(conversationId, identifier) as RawArtifactRow[]
    return rows.map(parseRow)
}
