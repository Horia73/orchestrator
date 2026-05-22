import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { CLI_IDS, CLI_SPECS, type CliId } from '@/lib/cli/specs'
import { startSession, describeSession } from '@/lib/cli/sessions'

const SpawnBodySchema = z.object({
    cli: z.enum(CLI_IDS as [CliId, ...CliId[]]),
    mode: z.enum(['install', 'login', 'logout', 'status', 'free', 'setup-token']),
})

/** POST /api/cli/spawn — start a CLI session, returns sessionId. */
export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsed = SpawnBodySchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid spawn args', issues: parsed.error.issues }, { status: 400 })
    }

    // Validate setup-token at the route boundary so the UI gets a clean 400
    // ("Codex doesn't support setup-token") instead of a 500 from the spawn
    // helper. Keeps the failure mode the same as an unknown mode would be.
    if (parsed.data.mode === 'setup-token') {
        const spec = CLI_SPECS[parsed.data.cli]
        if (!spec.setupTokenArgs) {
            return NextResponse.json(
                { error: `${spec.name} does not support setup-token mode` },
                { status: 400 }
            )
        }
    }

    try {
        const id = startSession({
            cli: parsed.data.cli,
            mode: parsed.data.mode,
        })
        return NextResponse.json({ sessionId: id, session: describeSession(id) })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Spawn failed' },
            { status: 500 }
        )
    }
}
