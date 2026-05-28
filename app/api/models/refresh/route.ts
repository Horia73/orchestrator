import { NextResponse } from 'next/server'

import { getApiKey } from '@/lib/config'
import {
    getEffectiveRegistry,
    invalidateRegistryCache,
} from '@/lib/models/registry'
import { readLiveRegistry, writeLiveRegistry } from '@/lib/models/store'
import { fetchGoogleModels } from '@/lib/models/fetcher'
import { probeClaudeCodeModels } from '@/lib/cli/model-probe'

/**
 * POST /api/models/refresh
 *
 * Pulls the live model list from each provider whose API key is configured.
 * Anthropic and OpenAI are stubs today — only Google is fetched. When the
 * real providers land, plug their fetcher in alongside.
 *
 * The response includes per-provider status so the UI can show which fetches
 * succeeded vs which were skipped (no key) vs which failed.
 */
interface ProviderRefreshResult {
    fetched: number
    error?: string
    skipped?: 'no_api_key' | 'not_implemented'
}

export async function POST() {
    const live = readLiveRegistry()
    const results: Record<string, ProviderRefreshResult> = {}

    // ---------- Google ----------
    const googleKey = getApiKey('google')
    if (!googleKey) {
        results.google = { fetched: 0, skipped: 'no_api_key' }
    } else {
        try {
            const entry = await fetchGoogleModels(googleKey)
            live.providers.google = entry
            results.google = { fetched: Object.keys(entry.models).length }
        } catch (err) {
            results.google = {
                fetched: 0,
                error: err instanceof Error ? err.message : 'Unknown error',
            }
        }
    }

    // ---------- Claude Code (CLI) ----------
    // No list API — we resolve the opus/sonnet/haiku aliases by spawning the
    // CLI and reading the model id from its stream-json init event, then write
    // them into the live registry so the picker gains e.g. an "Opus 4.8" entry
    // that tracks whatever the alias currently resolves to.
    try {
        const entry = await probeClaudeCodeModels()
        if (entry) {
            live.providers['claude-code'] = entry
            results['claude-code'] = { fetched: Object.keys(entry.models).length }
        } else {
            results['claude-code'] = { fetched: 0, skipped: 'not_implemented' }
        }
    } catch (err) {
        results['claude-code'] = {
            fetched: 0,
            error: err instanceof Error ? err.message : 'Claude Code probe failed.',
        }
    }

    // ---------- Codex & API providers ----------
    // Codex uses explicit model ids (no "latest" alias) and has no list
    // command, so there's nothing to probe. Anthropic/OpenAI API fetchers are
    // not implemented yet.
    results.codex = { fetched: 0, skipped: 'not_implemented' }
    results.anthropic = { fetched: 0, skipped: 'not_implemented' }
    results.openai = { fetched: 0, skipped: 'not_implemented' }

    writeLiveRegistry(live)
    invalidateRegistryCache()

    return NextResponse.json({
        success: true,
        results,
        registry: getEffectiveRegistry(),
    })
}
