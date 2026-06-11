import { NextResponse } from 'next/server'
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    modelExists,
    setBrowserAgentModel,
    type BrowserAgentModelSettings,
    type BrowserAgentModelSlot,
    type ModelFeatureValue,
    type ThinkingLevel,
} from '@/lib/config'

function isSlot(value: unknown): value is BrowserAgentModelSlot {
    return value === 'light' || value === 'pro'
}

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

export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Body must be an object' }, { status: 400 })
        }

        const { slot, provider, model, thinkingLevel, modelOptions } = body as Record<string, unknown>
        if (!isSlot(slot)) {
            return NextResponse.json({ error: 'slot must be "light" or "pro"' }, { status: 400 })
        }
        if (provider !== 'google' && provider !== 'codex') {
            return NextResponse.json({ error: 'Browser agent supports the Google (Gemini API) and Codex CLI providers only' }, { status: 400 })
        }
        if (typeof model !== 'string') {
            return NextResponse.json({ error: 'model is required' }, { status: 400 })
        }
        if (!modelExists(provider, model)) {
            return NextResponse.json({ error: `Unknown model: ${provider}:${model}` }, { status: 400 })
        }
        if (!isThinkingLevel(thinkingLevel)) {
            return NextResponse.json({ error: 'Invalid thinkingLevel' }, { status: 400 })
        }
        if (!isModelOptions(modelOptions)) {
            return NextResponse.json({ error: 'Invalid modelOptions' }, { status: 400 })
        }

        const override: BrowserAgentModelSettings = { provider, model, thinkingLevel }
        if (modelOptions !== undefined) override.modelOptions = modelOptions

        const updated = setBrowserAgentModel(slot, override)
        return NextResponse.json({ success: true, config: updated })
  })
}
