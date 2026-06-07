import { NextResponse } from 'next/server'
import { getAgent } from '@/lib/ai'
import { AUDIO_CONTEXT_AGENT_ID, isAudioContextAgentModel } from '@/lib/ai/audio-context'
import { getEffectiveModel } from '@/lib/models/registry'
import { setAgentOverride, modelExists, type AgentFallback, type AgentOverride, type ThinkingLevel, type ModelFeatureValue } from '@/lib/config'
import type { AgentConfig } from '@/lib/ai/agents/types'
import { runWithRequestProfile } from "@/lib/profiles/server"

function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)
}

function isModelOptions(value: unknown): value is Record<string, ModelFeatureValue> {
    if (value === undefined) return true
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return Object.entries(value).every(([key, optionValue]) => (
        /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) &&
        (typeof optionValue === 'boolean' || typeof optionValue === 'string' || typeof optionValue === 'number')
    ))
}

function supportsModelFallbacks(agent: AgentConfig): boolean {
    return (
        (agent.kind === 'text' || agent.kind === 'concierge') &&
        agent.provider !== 'browser' &&
        agent.id !== AUDIO_CONTEXT_AGENT_ID &&
        agent.id !== 'phone_agent' &&
        agent.id !== 'android_agent'
    )
}

function isTextModel(provider: string, model: string): boolean {
    const modelDef = getEffectiveModel(provider, model)
    if (!modelDef) return false
    return (modelDef.kinds ?? []).includes('text') || (modelDef.capabilities ?? []).includes('text')
}

function parseFallbacks(value: unknown, agent: AgentConfig): { ok: true; fallbacks?: AgentFallback[] } | { ok: false; error: string } {
    if (value === undefined) return { ok: true }
    if (!supportsModelFallbacks(agent)) {
        return { ok: false, error: 'Fallbacks are only supported for text-runtime agents.' }
    }
    if (!Array.isArray(value)) {
        return { ok: false, error: 'fallbacks must be an array' }
    }
    if (value.length > 2) {
        return { ok: false, error: 'fallbacks accepts at most 2 entries' }
    }

    const fallbacks: AgentFallback[] = []
    const seen = new Set<string>()
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, error: 'Each fallback must be an object' }
        }
        const { provider, model, thinkingLevel } = item as Record<string, unknown>
        if (typeof provider !== 'string' || typeof model !== 'string') {
            return { ok: false, error: 'Fallback provider and model are required strings' }
        }
        if (!modelExists(provider, model)) {
            return { ok: false, error: `Unknown fallback model: ${provider}:${model}` }
        }
        if (!isTextModel(provider, model)) {
            return { ok: false, error: `Fallback model must support text: ${provider}:${model}` }
        }
        if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
            return { ok: false, error: 'Invalid fallback thinkingLevel' }
        }
        const key = `${provider}:${model}`
        if (seen.has(key)) continue
        seen.add(key)
        const fallback: AgentFallback = { provider, model }
        if (thinkingLevel !== undefined) fallback.thinkingLevel = thinkingLevel
        fallbacks.push(fallback)
    }

    return { ok: true, fallbacks: fallbacks.length > 0 ? fallbacks : undefined }
}

/**
 * PUT  — set or replace the override for an agent
 * DELETE — clear the override (agent falls back to global default)
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ agentId: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const { agentId } = await params

        const agent = getAgent(agentId)
        if (!agent) {
            return NextResponse.json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
        }

        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Body must be an object' }, { status: 400 })
        }

        const { provider, model, thinkingLevel, modelOptions, fallbacks } = body as Record<string, unknown>

        if (typeof provider !== 'string' || typeof model !== 'string') {
            return NextResponse.json({ error: 'provider and model are required strings' }, { status: 400 })
        }

        if (!modelExists(provider, model)) {
            return NextResponse.json({ error: `Unknown model: ${provider}:${model}` }, { status: 400 })
        }

        if (agent.id === AUDIO_CONTEXT_AGENT_ID && !isAudioContextAgentModel(provider, model)) {
            return NextResponse.json(
                { error: 'Audio Context Agent must use a Google/Gemini text model that can receive audio.' },
                { status: 400 }
            )
        }

        const override: AgentOverride = { provider, model }
        if (thinkingLevel !== undefined) {
            if (!isThinkingLevel(thinkingLevel)) {
                return NextResponse.json({ error: 'Invalid thinkingLevel' }, { status: 400 })
            }
            override.thinkingLevel = thinkingLevel
        }
        if (!isModelOptions(modelOptions)) {
            return NextResponse.json({ error: 'Invalid modelOptions' }, { status: 400 })
        }
        if (modelOptions !== undefined) override.modelOptions = modelOptions
        const parsedFallbacks = parseFallbacks(fallbacks, agent)
        if (!parsedFallbacks.ok) {
            return NextResponse.json({ error: parsedFallbacks.error }, { status: 400 })
        }
        if (parsedFallbacks.fallbacks) override.fallbacks = parsedFallbacks.fallbacks

        const updated = setAgentOverride(agentId, override)
        return NextResponse.json({ success: true, config: updated })
  })
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ agentId: string }> }
) {
  return runWithRequestProfile(_request, async () => {
        const { agentId } = await params

        if (!getAgent(agentId)) {
            return NextResponse.json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
        }

        const updated = setAgentOverride(agentId, null)
        return NextResponse.json({ success: true, config: updated })
  })
}
