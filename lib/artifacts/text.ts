const COMPLETE_ARTIFACT_BLOCK_RE = /<artifact\b([^>]*)>[\s\S]*?<\/artifact>/gi
const TRAILING_ARTIFACT_BLOCK_RE = /<artifact\b[^>]*>[\s\S]*$/i

function attrValue(attrs: string, name: string): string | null {
    const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
    return match?.[2]?.trim() || null
}

export function extractArtifactBlocks(content: string): string[] {
    const blocks: string[] = []
    for (const match of content.matchAll(COMPLETE_ARTIFACT_BLOCK_RE)) {
        blocks.push(match[0])
    }
    return blocks
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
    const blocks = extractArtifactBlocks(source)
    if (blocks.length === 0) return target
    const missing = blocks.filter(block => !target.includes(block))
    if (missing.length === 0) return target
    return [target.trim(), ...missing].filter(Boolean).join('\n\n')
}
