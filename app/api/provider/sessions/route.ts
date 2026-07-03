import type { ProviderBuiltin, StreamCallbacks } from '@/lib/ai/agents/types'
import { getProvider } from '@/lib/ai/providers'
import { checkProviderAuth } from '@/lib/agenticweb/provider-auth'
import { prepareWorkspace } from '@/lib/agenticweb/workspaces'

/**
 * „AI Provider" pentru AgenticWeb OS: o sesiune = o rulare headless a unui
 * agent pe subscripție (Claude Code / Codex) într-un workspace izolat per
 * site. Răspunsul e un stream SSE cu evenimente normalizate — contractul e
 * oglindit în agenticwebos/src/lib/provider/contract.ts; schimbările se fac
 * în tandem.
 *
 * mode=ask  — întrebări/teste de instrucțiuni; fără branch, fără cerințe git.
 * mode=edit — editare de site: clonează repo-ul dacă lipsește și taie
 *             branch-ul de lucru înainte să pornească agentul.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const ENGINES = new Set(['claude-code', 'codex'])
const BUILTINS: ReadonlySet<ProviderBuiltin> = new Set([
    'read', 'write', 'edit', 'bash', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write',
])
const DEFAULT_BUILTINS: Record<'ask' | 'edit', ProviderBuiltin[]> = {
    ask: ['read', 'glob', 'grep'],
    edit: ['read', 'write', 'edit', 'bash', 'glob', 'grep'],
}

interface SessionRequest {
    engine: 'claude-code' | 'codex'
    prompt: string
    siteSlug: string
    mode: 'ask' | 'edit'
    model?: string
    systemPrompt?: string
    repoUrl?: string
    branch?: string
    builtins?: string[]
    resumeSession?: { id: string; at: number }
}

export async function POST(req: Request) {
    const auth = checkProviderAuth(req)
    if (!auth.ok) return auth.response

    let body: SessionRequest
    try {
        body = await req.json() as SessionRequest
    } catch {
        return Response.json({ error: 'Body-ul trebuie să fie JSON.' }, { status: 400 })
    }

    const mode = body.mode === 'edit' ? 'edit' : 'ask'
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!ENGINES.has(body.engine)) return Response.json({ error: `engine necunoscut: ${body.engine}` }, { status: 400 })
    if (!prompt) return Response.json({ error: 'prompt gol' }, { status: 400 })
    if (typeof body.siteSlug !== 'string') return Response.json({ error: 'siteSlug lipsă' }, { status: 400 })

    let workspace
    try {
        workspace = await prepareWorkspace({
            siteSlug: body.siteSlug,
            repoUrl: mode === 'edit' ? body.repoUrl : undefined,
            branch: mode === 'edit' ? body.branch : undefined,
        })
    } catch (err) {
        return Response.json(
            { error: `Workspace-ul nu a putut fi pregătit: ${err instanceof Error ? err.message : 'eroare'}` },
            { status: 400 },
        )
    }

    const builtins = sanitizeBuiltins(body.builtins) ?? DEFAULT_BUILTINS[mode]
    const provider = getProvider(body.engine, '')
    const streamFn = provider.stream?.bind(provider)
    if (!streamFn) return Response.json({ error: `engine fără streaming: ${body.engine}` }, { status: 400 })
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false
            const send = (data: Record<string, unknown>) => {
                if (closed) return
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            }
            const close = () => {
                if (closed) return
                closed = true
                clearInterval(ping)
                try { controller.close() } catch { /* deja închis */ }
            }
            // Ping periodic: ține conexiunea vie prin reverse-proxy-ul de pe
            // gazdă cât timp agentul lucrează fără să emită nimic.
            const ping = setInterval(() => {
                if (!closed) controller.enqueue(encoder.encode(': ping\n\n'))
            }, 15_000)

            send({ type: 'started', workspace: workspace.dir, branch: workspace.branch ?? null, engine: body.engine })

            const callbacks: StreamCallbacks = {
                onThinking: text => send({ type: 'thinking', text }),
                onThinkingDone: seconds => send({ type: 'thinking_done', seconds }),
                onContent: text => send({ type: 'content', text }),
                onToolCall: call => send({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments }),
                onToolResult: (toolCallId, toolName, result) =>
                    send({ type: 'tool_result', id: toolCallId, name: toolName, result: truncateDeep(result) }),
                onUsage: usage => send({ type: 'usage', usage }),
                onDone: meta => {
                    send({
                        type: 'done',
                        sessionId: meta.sessionId ?? null,
                        usage: meta.usage ?? null,
                        thinkingDuration: meta.thinkingDuration ?? null,
                    })
                    close()
                },
                onError: error => {
                    send({ type: 'error', error })
                    close()
                },
            }

            streamFn(
                    {
                        model: body.model ?? '',
                        messages: [{ role: 'user', content: prompt }],
                        systemPrompt: body.systemPrompt || undefined,
                        builtins,
                        cwd: workspace.dir,
                        prevSession: body.resumeSession ?? null,
                        signal: req.signal,
                    },
                    callbacks,
                )
                .catch(err => {
                    send({ type: 'error', error: err instanceof Error ? err.message : 'eroare necunoscută' })
                    close()
                })
        },
        cancel() {
            // Clientul a închis conexiunea; req.signal se declanșează și
            // providerul omoară procesul CLI.
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        },
    })
}

function sanitizeBuiltins(raw: string[] | undefined): ProviderBuiltin[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null
    const picked = raw.filter((b): b is ProviderBuiltin => BUILTINS.has(b as ProviderBuiltin))
    return picked.length ? picked : null
}

/** Rezultatele de tool pot fi uriașe (cat pe fișiere mari) — tăiem stringurile
 *  adânci ca stream-ul spre OS să rămână suplu; agentul își vede oricum tot. */
function truncateDeep(value: unknown, maxString = 4000): unknown {
    if (typeof value === 'string') {
        return value.length > maxString ? `${value.slice(0, maxString)}… [trunchiat, ${value.length} caractere]` : value
    }
    if (Array.isArray(value)) return value.map(v => truncateDeep(v, maxString))
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateDeep(v, maxString)]))
    }
    return value
}
