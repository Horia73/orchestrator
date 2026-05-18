import { NextResponse } from 'next/server'
import { getAgent } from '@/lib/ai'
import { setAgentOverride, modelExists, type AgentOverride, type ThinkingLevel, type ModelFeatureValue } from '@/lib/config'

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

/**
 * PUT  — set or replace the override for an agent
 * DELETE — clear the override (agent falls back to global default)
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ agentId: string }> }
) {
    const { agentId } = await params

    if (!getAgent(agentId)) {
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

    const { provider, model, thinkingLevel, modelOptions } = body as Record<string, unknown>

    if (typeof provider !== 'string' || typeof model !== 'string') {
        return NextResponse.json({ error: 'provider and model are required strings' }, { status: 400 })
    }

    if (!modelExists(provider, model)) {
        return NextResponse.json({ error: `Unknown model: ${provider}:${model}` }, { status: 400 })
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

    const updated = setAgentOverride(agentId, override)
    return NextResponse.json({ success: true, config: updated })
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ agentId: string }> }
) {
    const { agentId } = await params

    if (!getAgent(agentId)) {
        return NextResponse.json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
    }

    const updated = setAgentOverride(agentId, null)
    return NextResponse.json({ success: true, config: updated })
}
