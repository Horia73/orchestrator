import { NextResponse } from 'next/server'

import { orchestrator } from '@/lib/ai/agents/orchestrator'
import { getAgent } from '@/lib/ai/agents/registry'
import { MAX_AGENT_DEPTH, type AgentConfig } from '@/lib/ai/agents/types'
import { getProviderCapabilities } from '@/lib/ai/providers'
import { getToolsForAgent, getToolsForBuiltins, resolveProviderToolSurface } from '@/lib/ai/tools/registry'
import { getConfig, getEffectiveAgentSettings } from '@/lib/config'
import { filterIntegrationToolExposure } from '@/lib/integrations/exposure'
import { getEffectiveRegistry } from '@/lib/models/registry'
import { getProviderReadiness } from '@/lib/provider-readiness'
import { resolveRequestOrigin } from '@/lib/app-origin'

type ProviderCaps = NonNullable<ReturnType<typeof getProviderCapabilities>>

function resolveChatAgentSettings() {
    const resolved = getEffectiveAgentSettings(orchestrator.id)
    if (resolved.fromOverride) return { ...resolved, source: 'agentOverride' as const }

    return {
        ...resolved,
        provider: orchestrator.provider ?? resolved.provider,
        model: orchestrator.model ?? resolved.model,
        thinkingLevel: orchestrator.thinkingLevel ?? resolved.thinkingLevel,
        source: orchestrator.provider || orchestrator.model || orchestrator.thinkingLevel
            ? 'agentDefault'
            : 'globalDefault',
    } as const
}

/**
 * Estimate the orchestrator system prompt size (in tokens) so the context
 * ring reflects it instead of a flat guess. Mirrors the prompt-build pipeline
 * in app/api/chat/route.ts — kept in sync by hand; this only needs to be
 * close, not byte-exact. Char/4 matches the client-side token estimate.
 */
function estimateSystemPromptTokens(origin: string, providerCaps: ProviderCaps): number | null {
    if (!orchestrator.buildPrompt) return null
    try {
        const seen = new Set<string>()
        const candidateTools = filterIntegrationToolExposure(
            [
                ...getToolsForAgent(orchestrator.tools),
                ...getToolsForBuiltins(orchestrator.builtins),
            ].filter(tool => (seen.has(tool.id) ? false : (seen.add(tool.id), true))),
            { conversationId: undefined, origin, agentId: orchestrator.id }
        )
        const surface = resolveProviderToolSurface(candidateTools, orchestrator.builtins, providerCaps)
        const config = getConfig()
        const availableAgents = (orchestrator.canCallAgents ?? [])
            .map(id => getAgent(id))
            .filter((a): a is AgentConfig => a !== undefined)
        const prompt = orchestrator.buildPrompt({
            agentId: orchestrator.id,
            userName: config.userName,
            assistantName: config.assistantName,
            availableTools: surface.tools,
            availableBuiltins: surface.builtins,
            customToolNamePrefix: providerCaps.customToolNamePrefix,
            availableAgents,
            declaredToolIds: orchestrator.tools,
            declaredTools: getToolsForAgent(orchestrator.tools),
            delegationDepth: 0,
            maxDelegationDepth: MAX_AGENT_DEPTH,
            extra: { appOrigin: origin },
        })
        return Math.ceil(prompt.length / 4)
    } catch {
        return null
    }
}

/** GET /api/chat/status - compact status payload for the chat input popover. */
export async function GET(request: Request) {
    const origin = resolveRequestOrigin(request)
    const settings = resolveChatAgentSettings()
    const config = getConfig()
    const registry = getEffectiveRegistry()
    const providerDef = registry[settings.provider]
    const modelDef = providerDef?.models[settings.model] ?? null
    const providerCaps = getProviderCapabilities(settings.provider)
    const readiness = await getProviderReadiness(settings.provider, providerDef)
    const availableModel = readiness.available ? modelDef : null

    const systemPromptTokens = providerCaps && availableModel
        ? estimateSystemPromptTokens(origin, providerCaps)
        : null

    return NextResponse.json({
        chat: {
            agent: {
                id: orchestrator.id,
                name: config.assistantName || orchestrator.name,
            },
            provider: {
                id: settings.provider,
                name: providerDef?.name ?? settings.provider,
                requiresApiKey: providerCaps?.requiresApiKey !== false,
            },
            model: availableModel ? {
                id: settings.model,
                name: availableModel.name,
                contextWindow: availableModel.contextWindow,
                maxOutputTokens: availableModel.maxOutputTokens,
                pricingKind: availableModel.pricing?.kind ?? 'unknown',
                dataCompleteness: availableModel.dataCompleteness,
            } : null,
            thinkingLevel: settings.thinkingLevel,
            source: settings.source,
            available: Boolean(availableModel),
            unavailableReason: !modelDef
                ? `Model ${settings.model} is not available for ${providerDef?.name ?? settings.provider}.`
                : readiness.unavailableReason,
        },
        systemPromptTokens,
    }, {
        headers: { 'Cache-Control': 'no-store' },
    })
}
