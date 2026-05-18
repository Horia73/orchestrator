import { NextResponse } from 'next/server'
import { getEnvValue, getRuntimeConfig } from '@/lib/config'
import { getEffectiveRegistry } from '@/lib/models/registry'
import { getAllAgents } from '@/lib/ai'

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
        defaultProvider: a.provider,
        defaultModel: a.model,
        defaultThinkingLevel: a.thinkingLevel,
        canCallAgents: a.canCallAgents ?? [],
    }))

    const providerStatus: Record<string, { apiKeyConfigured: boolean; apiKeyMasked: string | null }> = {}
    for (const [providerId, provider] of Object.entries(registry)) {
        const key = getEnvValue(provider.apiKeyEnv)
        if (key && key.length > 8) {
            providerStatus[providerId] = {
                apiKeyConfigured: true,
                apiKeyMasked: key.slice(0, 4) + '...' + key.slice(-4),
            }
        } else {
            providerStatus[providerId] = { apiKeyConfigured: false, apiKeyMasked: null }
        }
    }

    return NextResponse.json({
        config,
        agents,
        providers: registry,
        providerStatus,
    })
}
