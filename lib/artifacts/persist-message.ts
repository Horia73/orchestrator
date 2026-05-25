import { ArtifactParser } from './parser'
import type { ArtifactOpenAttrs, ArtifactRow } from './schema'
import { insertArtifact } from './store'
import { stripWrappingCodeFence } from './sanitize'

interface PersistArtifactsFromMessageArgs {
    conversationId: string
    messageId: string
    content: string
}

interface PendingArtifact {
    attrs: ArtifactOpenAttrs
    content: string
}

export interface PersistArtifactsFromMessageResult {
    artifacts: ArtifactRow[]
    errors: string[]
}

/**
 * Persist finished artifact tags from a complete assistant message.
 *
 * The streaming chat route persists artifacts as chunks arrive so it can
 * notify the client over SSE. Background surfaces (scheduled runs, Inbox
 * replies, microscripts) write complete messages in one shot, so they use
 * this helper after the conversation/message rows exist.
 */
export function persistArtifactsFromMessage(
    args: PersistArtifactsFromMessageArgs,
): PersistArtifactsFromMessageResult {
    const parser = new ArtifactParser()
    const pending = new Map<string, PendingArtifact>()
    const artifacts: ArtifactRow[] = []
    const errors: string[] = []

    const handleEnd = (clientToken: string) => {
        const item = pending.get(clientToken)
        pending.delete(clientToken)
        if (!item) return
        try {
            artifacts.push(insertArtifact({
                conversationId: args.conversationId,
                messageId: args.messageId,
                identifier: item.attrs.identifier,
                type: item.attrs.type,
                title: item.attrs.title,
                language: item.attrs.language ?? null,
                display: item.attrs.display ?? null,
                content: stripWrappingCodeFence(item.content),
            }))
        } catch (err) {
            errors.push(err instanceof Error ? err.message : 'persist failed')
        }
    }

    for (const event of [...parser.feed(args.content), ...parser.end()]) {
        switch (event.kind) {
            case 'artifact_start':
                pending.set(event.clientToken, { attrs: event.attrs, content: '' })
                break
            case 'artifact_chunk': {
                const item = pending.get(event.clientToken)
                if (item) item.content += event.text
                break
            }
            case 'artifact_end':
                handleEnd(event.clientToken)
                break
            case 'artifact_error':
                errors.push(event.message)
                break
            case 'prose':
                break
        }
    }

    return { artifacts, errors }
}
