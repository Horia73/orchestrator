import { hostname } from 'os'

import { checkProviderAuth } from '@/lib/agenticweb/provider-auth'
import { getAllCliStatuses } from '@/lib/cli/status'
import { getEffectiveRegistry } from '@/lib/models/registry'
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
    const registry = getEffectiveRegistry()
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
                // modelele active din registrul Orchestrator — sursa
                // selectorului unic din Lab-ul AgenticWeb OS
                models: Object.entries(registry[id]?.models ?? {})
                    .filter(([, m]) => !m.archived && m.kinds.includes('text'))
                    .map(([modelId, m]) => ({ id: modelId, name: m.name })),
            }]),
        ),
    })
}
