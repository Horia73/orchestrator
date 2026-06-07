import { NextResponse } from 'next/server'
import { z } from 'zod'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { CLI_IDS, type CliId } from '@/lib/cli/specs'
import { closeSessionsForCli } from '@/lib/cli/sessions'
import { invalidateRegistryCache } from '@/lib/models/registry'
import { runWithRequestProfile } from "@/lib/profiles/server"

const RestartBodySchema = z.object({
    cli: z.enum(CLI_IDS as [CliId, ...CliId[]]),
})

/**
 * POST /api/cli/restart — "restart" a CLI from Settings: tear down any live
 * sessions, drop the model registry cache, and let the caller re-fetch
 * /api/cli/status (which already forces a fresh detection). This does NOT
 * discover models the CLI gained that aren't in seed.json — the picker reads
 * the static seed, not the CLI's live catalog.
 */
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
        const parsed = RestartBodySchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ error: 'Invalid restart args', issues: parsed.error.issues }, { status: 400 })
        }

        const closedSessions = closeSessionsForCli(parsed.data.cli)
        invalidateRegistryCache()

        return NextResponse.json({ ok: true, cli: parsed.data.cli, closedSessions })
  })
}
