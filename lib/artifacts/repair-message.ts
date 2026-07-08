import { ArtifactParser } from './parser'
import type { ArtifactOpenAttrs } from './schema'
import { repairArtifactContent } from './repair'
import { stripWrappingCodeFence } from './sanitize'
import { isStrictArtifactType, validateArtifactContent } from './validation'

// ---------------------------------------------------------------------------
// Pre-persist validate+repair pass for complete assistant messages.
//
// The streaming chat route repairs invalid strict-schema artifacts in-turn
// (app/api/chat/route.ts → repairPendingArtifacts). Background surfaces —
// scheduled runs, microscript inbox posts, inline Inbox replies — write the
// whole message in one shot, so they run this pass over the final content
// BEFORE storing the message. That way the stored message and the persisted
// artifact rows always agree, and the user never receives a card that is
// already known to be broken.
//
// The model round-trip is injected (`generate`) so this module stays free of
// any agent-runner dependency and is unit-testable; callers bind it to the
// artifact's source agent runtime via lib/ai/agents/repair-generate.ts.
// ---------------------------------------------------------------------------

export interface RepairMessageArtifactsArgs {
    /** Complete assistant message content (may contain `<artifact>` blocks). */
    content: string
    /** One repair-model round-trip; null on provider failure. */
    generate: (userPrompt: string) => Promise<string | null>
    /** Caller label for log lines: 'scheduled-run' | 'microscript' | 'inbox-reply'. */
    surface: string
    /** Model round-trips per broken artifact before giving up. Default 3. */
    maxAttemptsPerArtifact?: number
}

export interface RepairedArtifactReport {
    identifier: string
    type: string
    attempts: number
}

export interface FailedArtifactReport {
    identifier: string
    type: string
    error: string
}

export interface RepairMessageArtifactsResult {
    /** Message content with every repaired artifact body spliced back in. */
    content: string
    repaired: RepairedArtifactReport[]
    /** Artifacts still invalid after repair — persist will reject these. */
    failed: FailedArtifactReport[]
}

interface ParsedArtifactBlock {
    attrs: ArtifactOpenAttrs
    /** Raw body exactly as it appears in the message (used for splicing). */
    body: string
}

function collectArtifactBlocks(content: string): ParsedArtifactBlock[] {
    const parser = new ArtifactParser()
    const pending = new Map<string, ParsedArtifactBlock>()
    const blocks: ParsedArtifactBlock[] = []
    for (const event of [...parser.feed(content), ...parser.end()]) {
        switch (event.kind) {
            case 'artifact_start':
                pending.set(event.clientToken, { attrs: event.attrs, body: '' })
                break
            case 'artifact_chunk': {
                const item = pending.get(event.clientToken)
                if (item) item.body += event.text
                break
            }
            case 'artifact_end': {
                const item = pending.get(event.clientToken)
                pending.delete(event.clientToken)
                if (item) blocks.push(item)
                break
            }
            default:
                break
        }
    }
    return blocks
}

/**
 * Validate every strict-schema artifact block in `content` and repair the
 * invalid ones with the injected repair generation. Valid blocks (and permissive
 * types) cost zero model calls. Returns the corrected content plus a report;
 * a `failed` entry means the artifact will still be rejected at persist time
 * and the caller should log it loudly.
 */
export async function repairMessageArtifacts(
    args: RepairMessageArtifactsArgs,
): Promise<RepairMessageArtifactsResult> {
    let content = args.content
    const repaired: RepairedArtifactReport[] = []
    const failed: FailedArtifactReport[] = []

    for (const block of collectArtifactBlocks(args.content)) {
        if (!isStrictArtifactType(block.attrs.type)) continue
        const candidate = stripWrappingCodeFence(block.body)
        const validation = validateArtifactContent(block.attrs.type, candidate)
        if (validation.ok) continue

        const result = await repairArtifactContent({
            type: block.attrs.type,
            content: candidate,
            error: validation.error,
            issues: validation.issues,
            generate: args.generate,
            maxAttempts: args.maxAttemptsPerArtifact ?? 3,
        })

        if (!result.ok) {
            failed.push({
                identifier: block.attrs.identifier,
                type: block.attrs.type,
                error: result.error,
            })
            console.warn(
                `[artifact-repair] surface=${args.surface} type=${block.attrs.type} identifier=${block.attrs.identifier} repair failed after ${result.attempts} attempt(s): ${result.error}`,
            )
            continue
        }

        // Splice the fixed body back over the original (fence included, if
        // any). The functional replacement arg keeps `$`-sequences in the
        // repaired JSON from being expanded as replacement patterns.
        if (!content.includes(block.body)) {
            failed.push({
                identifier: block.attrs.identifier,
                type: block.attrs.type,
                error: 'repaired body could not be spliced back into the message',
            })
            console.warn(
                `[artifact-repair] surface=${args.surface} type=${block.attrs.type} identifier=${block.attrs.identifier} repaired but original body not found verbatim in message`,
            )
            continue
        }
        content = content.replace(block.body, () => result.content)
        repaired.push({
            identifier: block.attrs.identifier,
            type: block.attrs.type,
            attempts: result.attempts,
        })
        console.log(
            `[artifact-repair] surface=${args.surface} type=${block.attrs.type} identifier=${block.attrs.identifier} repaired after ${result.attempts} attempt(s)`,
        )
    }

    return { content, repaired, failed }
}
