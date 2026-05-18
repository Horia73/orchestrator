import { ArtifactOpenAttrsSchema, type ArtifactStreamEvent } from './schema'

/**
 * Streaming artifact-block parser.
 *
 * A finite-state machine that consumes assistant content chunk-by-chunk and
 * emits a stream of events:
 *
 *   - `prose`           — text that should render as normal assistant message
 *   - `artifact_start`  — opening tag fully parsed (with attrs)
 *   - `artifact_chunk`  — inner content of the current artifact
 *   - `artifact_end`    — closing tag seen
 *   - `artifact_error`  — malformed opening tag; raw text falls back to prose
 *
 * The parser handles the awkward cases:
 *
 *   1. Opening tag split across chunks: we hold a tentative buffer when we
 *      see `<` and only commit (as prose or as a tag) once we have enough
 *      bytes to disambiguate.
 *
 *   2. Attribute values with `>` inside (rare in artifact attrs, but the
 *      title could contain one): we use a proper attribute tokenizer rather
 *      than a regex-on-the-line.
 *
 *   3. Inner content with `<` characters (e.g. JSX, HTML, markdown links):
 *      we only treat the matching artifact close tag as the close, scanning forward
 *      character-by-character while inside an artifact.
 *
 * The parser never throws. Bad tags become `artifact_error` + prose fallback
 * so a partial stream can't kill the chat session.
 */

const OPEN_TAG_NAME = 'artifact'

/**
 * Tag matching is case-insensitive. We lowercase only for the match decision;
 * the body content keeps its original casing so e.g. JSX inside the artifact
 * isn't mangled.
 */
function couldStartTag(buffer: string): boolean {
    const lower = buffer.toLowerCase()
    return `<${OPEN_TAG_NAME}`.startsWith(lower)
}

function matchedOpenTag(buffer: string): boolean {
    const lower = buffer.toLowerCase()
    return lower === `<${OPEN_TAG_NAME}` || lower.startsWith(`<${OPEN_TAG_NAME}`)
}

type State =
    | { kind: 'prose' }
    | { kind: 'tag-tentative'; buffer: string }            // saw '<', waiting to disambiguate
    | { kind: 'tag-open'; buffer: string }
    | { kind: 'artifact'; clientToken: string; closeBuffer: string }

export class ArtifactParser {
    private state: State = { kind: 'prose' }
    private events: ArtifactStreamEvent[] = []
    // Coalesce consecutive char-level emissions of the same kind into one
    // event so the SSE wire isn't spammed with single-character payloads.
    private proseBuffer = ''
    private chunkBuffer = ''
    private chunkBufferToken = ''
    // Counter used for clientToken — independent of the model's identifier so
    // the renderer can route chunks to the right card even if the model
    // reuses identifiers within a single message.
    private tokenCounter = 0

    feed(chunk: string): ArtifactStreamEvent[] {
        for (const ch of chunk) {
            this.consumeChar(ch)
        }
        this.flushBuffers()
        const out = this.events
        this.events = []
        return out
    }

    /** Emit any pending prose/chunk runs as single events. */
    private flushBuffers() {
        if (this.proseBuffer) {
            this.events.push({ kind: 'prose', text: this.proseBuffer })
            this.proseBuffer = ''
        }
        if (this.chunkBuffer) {
            this.events.push({ kind: 'artifact_chunk', clientToken: this.chunkBufferToken, text: this.chunkBuffer })
            this.chunkBuffer = ''
            this.chunkBufferToken = ''
        }
    }

    private emitProse(text: string) {
        // If we have buffered artifact chunks, they need to come first.
        if (this.chunkBuffer) this.flushBuffers()
        this.proseBuffer += text
    }

    private emitChunk(token: string, text: string) {
        if (this.proseBuffer) this.flushBuffers()
        if (this.chunkBufferToken && this.chunkBufferToken !== token) this.flushBuffers()
        this.chunkBuffer += text
        this.chunkBufferToken = token
    }

    private emitDiscrete(event: ArtifactStreamEvent) {
        this.flushBuffers()
        this.events.push(event)
    }

    /**
     * Flush whatever's buffered. Call once the upstream stream completes —
     * any tentative tag bytes become prose, and an unterminated artifact's
     * inner content gets flushed (you might still want to drop it; we keep
     * it because partial code/SVG/etc is often useful).
     */
    end(): ArtifactStreamEvent[] {
        switch (this.state.kind) {
            case 'tag-tentative':
                if (this.state.buffer) this.emitProse(this.state.buffer)
                break
            case 'tag-open':
                // Unterminated opening tag — treat the whole literal as prose.
                this.emitProse(this.state.buffer)
                break
            case 'artifact':
                // Stream ended mid-artifact. Emit any trailing close-buffer as
                // content (it's prose-from-inside-artifact-view since the close
                // never came). Then end the artifact anyway so the UI doesn't
                // hang waiting.
                if (this.state.closeBuffer) {
                    this.emitChunk(this.state.clientToken, this.state.closeBuffer)
                }
                this.emitDiscrete({ kind: 'artifact_end', clientToken: this.state.clientToken })
                break
            case 'prose':
                break
        }
        this.flushBuffers()
        this.state = { kind: 'prose' }
        const out = this.events
        this.events = []
        return out
    }

    // ────────────────────────────────────────────────────────────────────
    // Single-character driver. Branches on current state.
    // ────────────────────────────────────────────────────────────────────
    private consumeChar(ch: string) {
        switch (this.state.kind) {
            case 'prose':
                if (ch === '<') {
                    this.state = { kind: 'tag-tentative', buffer: '<' }
                } else {
                    this.emitProse(ch)
                }
                return

            case 'tag-tentative': {
                const next = this.state.buffer + ch
                // Is next either an exact match or a prefix of the accepted tag?
                if (matchedOpenTag(next)) {
                    // Locked in on a tag name — transition to attribute parsing.
                    this.state = { kind: 'tag-open', buffer: next }
                    return
                }
                if (couldStartTag(next)) {
                    // Still ambiguous (e.g. just "<a") — keep buffering.
                    this.state = { kind: 'tag-tentative', buffer: next }
                    return
                }
                // Diverged — emit the literal as prose and reset.
                this.emitProse(next)
                this.state = { kind: 'prose' }
                return
            }

            case 'tag-open': {
                const next = this.state.buffer + ch
                if (ch === '>') {
                    const inner = next.slice(`<${OPEN_TAG_NAME}`.length, -1).trim()
                    const attrs = parseOpenAttrs(inner)
                    if (!attrs.ok) {
                        this.emitDiscrete({ kind: 'artifact_error', message: attrs.error, raw: next })
                        this.emitProse(next)
                        this.state = { kind: 'prose' }
                        return
                    }
                    const clientToken = `art-${++this.tokenCounter}-${Math.random().toString(36).slice(2, 8)}`
                    this.emitDiscrete({ kind: 'artifact_start', attrs: attrs.value, clientToken })
                    this.state = { kind: 'artifact', clientToken, closeBuffer: '' }
                    return
                }
                this.state = { kind: 'tag-open', buffer: next }
                return
            }

            case 'artifact': {
                const closeTag = `</${OPEN_TAG_NAME}>`
                const nextBuf = this.state.closeBuffer + ch
                const nextBufLower = nextBuf.toLowerCase()
                if (closeTag.startsWith(nextBufLower)) {
                    if (nextBufLower === closeTag) {
                        this.emitDiscrete({ kind: 'artifact_end', clientToken: this.state.clientToken })
                        this.state = { kind: 'prose' }
                    } else {
                        this.state = { kind: 'artifact', clientToken: this.state.clientToken, closeBuffer: nextBuf }
                    }
                    return
                }
                // Mismatch — flush whatever close-buffer we accumulated as content.
                if (this.state.closeBuffer) {
                    this.emitChunk(this.state.clientToken, this.state.closeBuffer)
                }
                // Could the current char start a fresh close-tag match? Yes if it's '<'.
                if (closeTag.startsWith(ch.toLowerCase())) {
                    this.state = { kind: 'artifact', clientToken: this.state.clientToken, closeBuffer: ch }
                } else {
                    this.emitChunk(this.state.clientToken, ch)
                    this.state = { kind: 'artifact', clientToken: this.state.clientToken, closeBuffer: '' }
                }
                return
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Attribute tokenizer.
//
// Input is the body of an artifact opening tag with the tag name + brackets
// stripped, e.g. `identifier="recipe" type="text/markdown" title="Greek salad"`.
// Output is a record of attribute → value. Quotes can be ", ', or absent.
// Values can contain `>` only when quoted (matches HTML5 behaviour).
// ────────────────────────────────────────────────────────────────────────

type ParseAttrsResult = { ok: true; value: import('./schema').ArtifactOpenAttrs } | { ok: false; error: string }

function parseOpenAttrs(body: string): ParseAttrsResult {
    const attrs: Record<string, string> = {}
    let i = 0
    while (i < body.length) {
        // Skip whitespace.
        while (i < body.length && /\s/.test(body[i])) i++
        if (i >= body.length) break

        // Read attribute name.
        const nameStart = i
        while (i < body.length && /[a-zA-Z0-9_-]/.test(body[i])) i++
        const name = body.slice(nameStart, i)
        if (!name) {
            return { ok: false, error: `Unexpected character at attribute start: ${body[i]}` }
        }

        // Skip optional whitespace + '='.
        while (i < body.length && /\s/.test(body[i])) i++
        if (body[i] !== '=') {
            // Boolean attribute. Set to "true" and continue.
            attrs[name] = 'true'
            continue
        }
        i++ // consume '='
        while (i < body.length && /\s/.test(body[i])) i++

        // Read value: quoted ("..."/'...') or bare (no whitespace, no >).
        const quote = body[i]
        if (quote === '"' || quote === "'") {
            i++
            const valStart = i
            while (i < body.length && body[i] !== quote) i++
            if (i >= body.length) {
                return { ok: false, error: `Unterminated ${quote === '"' ? 'double' : 'single'} quote` }
            }
            attrs[name] = body.slice(valStart, i)
            i++ // consume closing quote
        } else {
            const valStart = i
            while (i < body.length && !/\s/.test(body[i])) i++
            attrs[name] = body.slice(valStart, i)
        }
    }

    const parsed = ArtifactOpenAttrsSchema.safeParse(attrs)
    if (!parsed.success) {
        const missing = parsed.error.issues.map(iss => iss.path.join('.')).join(', ')
        return { ok: false, error: `Missing or invalid attrs: ${missing}` }
    }
    return { ok: true, value: parsed.data }
}
