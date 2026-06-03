import { NextResponse } from 'next/server'
import { getRuntimeConfig } from '@/lib/config'
import { getEffectiveRegistry } from '@/lib/models/registry'
import { getAllAgents } from '@/lib/ai'
import { getProviderReadinessMap } from '@/lib/provider-readiness'

/**
 * Single round-trip bootstrap for the settings page.
 * Returns runtime config + serializable view of agents + effective model registry
 * + per-provider API key status (so the UI can flag missing keys without round-trips).
 */
export async function GET() {
    const config = getRuntimeConfig()
    const registry = getEffectiveRegistry()

    const agents = getAllAgents().map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        kind: a.kind,
        status: a.status ?? 'active',
        tier: a.tier ?? 'primary',
        defaultProvider: a.provider,
        defaultModel: a.model,
        defaultThinkingLevel: a.thinkingLevel,
        canCallAgents: a.canCallAgents ?? [],
    }))

    const providerStatus = await getProviderReadinessMap(registry)

    return NextResponse.json({
        config,
        agents,
        providers: registry,
        providerStatus,
    })
}
