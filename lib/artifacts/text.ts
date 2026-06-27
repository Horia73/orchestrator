import type { ArtifactDisplay } from './schema'

const COMPLETE_ARTIFACT_BLOCK_RE = /<artifact\b([^>]*)>[\s\S]*?<\/artifact>/gi
const TRAILING_ARTIFACT_BLOCK_RE = /<artifact\b[^>]*>[\s\S]*$/i

export interface ArtifactBlockInfo {
    block: string
    identifier: string | null
    type: string | null
    title: string | null
}

function attrValue(attrs: string, name: string): string | null {
    const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
    return match?.[2]?.trim() || null
}

function normalizeKeyPart(value: string | null | undefined): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

function artifactBlockIdentityKey(info: ArtifactBlockInfo): string {
    const type = normalizeKeyPart(info.type)
    const identifier = normalizeKeyPart(info.identifier)
    if (identifier) return `artifact:${type}:${identifier}`

    const title = normalizeKeyPart(info.title)
    if (type || title) return `artifact:${type}:${title}`

    return `block:${info.block}`
}

interface ArtifactBlockSource {
    identifier: string
    type: string
    title: string
    display?: ArtifactDisplay | null
    language?: string | null
    content: string
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

export function buildArtifactBlockFromRow(row: ArtifactBlockSource): string {
    const attrs = [
        `identifier="${escapeAttr(row.identifier)}"`,
        `type="${escapeAttr(row.type)}"`,
        `title="${escapeAttr(row.title)}"`,
    ]
    if (row.display) attrs.push(`display="${escapeAttr(row.display)}"`)
    if (row.language) attrs.push(`language="${escapeAttr(row.language)}"`)
    return `<artifact ${attrs.join(' ')}>\n${row.content}\n</artifact>`
}

export function extractArtifactBlocks(content: string): string[] {
    COMPLETE_ARTIFACT_BLOCK_RE.lastIndex = 0
    const blocks: string[] = []
    for (const match of content.matchAll(COMPLETE_ARTIFACT_BLOCK_RE)) {
        blocks.push(match[0])
    }
    return blocks
}

export function extractArtifactBlockInfos(content: string): ArtifactBlockInfo[] {
    COMPLETE_ARTIFACT_BLOCK_RE.lastIndex = 0
    const infos: ArtifactBlockInfo[] = []
    for (const match of content.matchAll(COMPLETE_ARTIFACT_BLOCK_RE)) {
        const attrs = match[1] ?? ''
        infos.push({
            block: match[0],
            identifier: attrValue(attrs, 'identifier'),
            type: attrValue(attrs, 'type'),
            title: attrValue(attrs, 'title'),
        })
    }
    return infos
}

export function artifactIdentityKeys(content: string): string[] {
    const keys = extractArtifactBlockInfos(content).map(artifactBlockIdentityKey)
    return Array.from(new Set(keys))
}

export function hasArtifactBlock(content: string): boolean {
    COMPLETE_ARTIFACT_BLOCK_RE.lastIndex = 0
    return COMPLETE_ARTIFACT_BLOCK_RE.test(content)
}

export function stripArtifactBlocksForPreview(content: string): string {
    return content
        .replace(COMPLETE_ARTIFACT_BLOCK_RE, (_block, attrs: string) => {
            const title = attrValue(attrs, 'title')
            return title ? `\n[Artifact: ${title}]\n` : '\n[Artifact]\n'
        })
        .replace(TRAILING_ARTIFACT_BLOCK_RE, '\n[Artifact]\n')
        .replace(/\s+/g, ' ')
        .trim()
}

export function appendMissingArtifactBlocks(target: string, source: string): string {
    const missing = missingArtifactBlocks(target, source)
    if (missing.length === 0) return target
    return [target.trim(), ...missing].filter(Boolean).join('\n\n')
}

export function missingArtifactBlocks(target: string, source: string): string[] {
    const sourceInfos = extractArtifactBlockInfos(source)
    if (sourceInfos.length === 0) return []

    const targetBlocks = new Set(extractArtifactBlocks(target))
    const targetKeys = new Set(extractArtifactBlockInfos(target).map(artifactBlockIdentityKey))
    const missing: string[] = []
    for (const info of sourceInfos) {
        const key = artifactBlockIdentityKey(info)
        if (targetBlocks.has(info.block) || targetKeys.has(key)) continue
        targetBlocks.add(info.block)
        targetKeys.add(key)
        missing.push(info.block)
    }
    return missing
}

export function dedupeArtifactNotifications<T extends { title?: string; body: string }>(
    notifications: readonly T[],
): T[] {
    if (notifications.length < 2) return [...notifications]

    const slots: Array<{ key: string; item: T }> = []
    const indexByKey = new Map<string, number>()
    for (const notification of notifications) {
        const artifactKeys = artifactIdentityKeys(notification.body).sort()
        const key = artifactKeys.length > 0
            ? `artifacts:${artifactKeys.join('|')}`
            : `body:${normalizeKeyPart(notification.title)}:${stripArtifactBlocksForPreview(notification.body).toLowerCase()}`
        const existingIndex = indexByKey.get(key)
        if (existingIndex === undefined) {
            indexByKey.set(key, slots.length)
            slots.push({ key, item: notification })
        } else {
            slots[existingIndex] = { key, item: notification }
        }
    }
    return slots.map((slot) => slot.item)
}
