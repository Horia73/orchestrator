import { hostname } from 'os'

import { checkProviderAuth } from '@/lib/agenticweb/provider-auth'
import { getAllCliStatuses } from '@/lib/cli/status'
import { workspacesBaseDir } from '@/lib/agenticweb/workspaces'

/**
 * Health-check pentru AgenticWeb OS: confirmă că providerul e viu și spune
 * ce motoare (CLI-uri pe subscripție) sunt instalate + logate pe gazda asta.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
    const auth = checkProviderAuth(req)
    if (!auth.ok) return auth.response

    const statuses = await getAllCliStatuses({ staleWhileRevalidate: true })
    return Response.json({
        ok: true,
        host: hostname(),
        workspacesDir: workspacesBaseDir(),
        engines: Object.fromEntries(
            Object.entries(statuses).map(([id, s]) => [id, {
                installed: s.installed,
                loggedIn: s.loggedIn,
                needsReconnect: s.needsReconnect ?? false,
                version: s.version,
                detail: s.detail,
            }]),
        ),
    })
}
