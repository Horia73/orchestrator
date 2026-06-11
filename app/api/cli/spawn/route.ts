import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { CLI_IDS, type CliId } from '@/lib/cli/specs'
import { startSession, describeSession } from '@/lib/cli/sessions'
import { runWithRequestProfile } from "@/lib/profiles/server"

const SpawnBodySchema = z.object({
    cli: z.enum(CLI_IDS as [CliId, ...CliId[]]),
    mode: z.enum(['install', 'login', 'logout', 'status', 'free']),
})

/** POST /api/cli/spawn — start a CLI session, returns sessionId. */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
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
  })
}
