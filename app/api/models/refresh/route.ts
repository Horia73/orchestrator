import { NextResponse } from 'next/server'

import { getApiKey, getEnvValue } from '@/lib/config'
import {
    getEffectiveModel,
    getEffectiveRegistry,
    invalidateRegistryCache,
    patchCuratedModel,
} from '@/lib/models/registry'
import { readLiveRegistry, writeLiveRegistry } from '@/lib/models/store'
import { fetchGoogleModels, fetchLMStudioModels, fetchOpenRouterModels } from '@/lib/models/fetcher'
import { probeClaudeCodeModels, type ClaudeResolvedModel } from '@/lib/cli/model-probe'
import type { LiveModelEntry } from '@/lib/models/schema'
import { runWithAdminCookieProfile } from "@/lib/profiles/server"
import { LM_STUDIO_API_KEY_ENV } from '@/lib/lm-studio'

/**
 * POST /api/models/refresh
 *
 * Pulls the live model list from each provider whose API key is configured,
 * and re-syncs the Claude Code entries from the CLI (see below). The response
 * includes per-provider status so the UI can show which fetches succeeded vs
 * which were skipped (no key) vs which failed.
 */
interface ProviderRefreshResult {
    fetched: number
    error?: string
    skipped?: 'no_api_key' | 'no_base_url' | 'not_implemented'
}

/**
 * Sync the claude-code entries from the CLI probe:
 *
 *   • Aliases that already exist in the registry are relabelled to the name
 *     the CLI currently resolves, and auto-unarchived when the name changed
 *     (the user archives entries that went stale, so a model bump should
 *     bring the affected ones back). Unchanged entries are left exactly as
 *     the user left them (archived stays archived).
 *   • Aliases the registry has never seen (a brand-new model family the CLI
 *     documents, e.g. `fable`) get a live-registry entry — the effective
 *     registry grows from live under an existing seed provider. Pricing is
 *     `subscription` (it's the CLI plan); context window and the rest stay
 *     unset so the research flow can fill them in.
 *
 * Existing live entries are never dropped on probe failure — a flaky or
 * logged-out CLI must not empty the picker. Returns how many entries changed.
 */
function syncClaudeCodeModels(
    probed: Record<string, ClaudeResolvedModel | null>,
    liveModels: Record<string, LiveModelEntry>
): number {
    let changed = 0
    for (const [alias, resolved] of Object.entries(probed)) {
        if (!resolved) continue
        const freshLabel = alias === 'default' ? `Default (${resolved.name})` : resolved.name

        const existing = getEffectiveModel('claude-code', alias)
        if (existing) {
            // The live label isn't reflected in the current label → it changed
            // (or was never set). Relabel and bring the entry back into the picker.
            if (existing.name !== freshLabel) {
                patchCuratedModel('claude-code', alias, { displayNameOverride: freshLabel, archived: false })
                changed++
            }
            if (liveModels[alias]) {
                liveModels[alias] = { ...liveModels[alias], name: freshLabel }
            }
            continue
        }

        liveModels[alias] = {
            name: freshLabel,
            pricing: { kind: 'subscription' },
            thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultThinkingLevel: 'high',
            capabilities: ['text', 'function_calling'],
            rawDescription: `Discovered from \`claude --model ${alias}\` (resolves to ${resolved.id}).`,
        }
        changed++
    }
    return changed
}

export async function POST() {
  return runWithAdminCookieProfile(async () => {
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

        // ---------- OpenRouter ----------
        const openRouterKey = getApiKey('openrouter')
        if (!openRouterKey) {
            results.openrouter = { fetched: 0, skipped: 'no_api_key' }
        } else {
            try {
                const entry = await fetchOpenRouterModels(openRouterKey)
                live.providers.openrouter = entry
                results.openrouter = { fetched: Object.keys(entry.models).length }
            } catch (err) {
                results.openrouter = {
                    fetched: 0,
                    error: err instanceof Error ? err.message : 'Unknown error',
                }
            }
        }

        // ---------- LM Studio ----------
        const lmStudioBaseUrl = getApiKey('lm-studio')
        if (!lmStudioBaseUrl) {
            results['lm-studio'] = { fetched: 0, skipped: 'no_base_url' }
        } else {
            try {
                const entry = await fetchLMStudioModels(lmStudioBaseUrl, getEnvValue(LM_STUDIO_API_KEY_ENV))
                live.providers['lm-studio'] = entry
                results['lm-studio'] = { fetched: Object.keys(entry.models).length }
            } catch (err) {
                results['lm-studio'] = {
                    fetched: 0,
                    error: err instanceof Error ? err.message : 'Unknown error',
                }
            }
        }

        // ---------- Claude Code (CLI) ----------
        // No model-list API — discover the CLI's documented `--model` aliases
        // (plus every claude-code entry already in the registry), resolve each
        // to the concrete model id the CLI reports, then relabel existing
        // entries and add live entries for new families (see
        // syncClaudeCodeModels). Codex still has no list surface — purge any
        // stale live entries a former probe experiment wrote.
        if (live.providers.codex) delete live.providers.codex
        try {
            const knownAliases = Object.keys(getEffectiveRegistry()['claude-code']?.models ?? {})
            const probed = await probeClaudeCodeModels(knownAliases)
            if (Object.values(probed).some(Boolean)) {
                const liveModels = { ...(live.providers['claude-code']?.models ?? {}) }
                const synced = syncClaudeCodeModels(probed, liveModels)
                live.providers['claude-code'] = { fetchedAt: Date.now(), models: liveModels }
                results['claude-code'] = { fetched: synced }
            } else {
                results['claude-code'] = { fetched: 0, skipped: 'not_implemented' }
            }
        } catch (err) {
            results['claude-code'] = {
                fetched: 0,
                error: err instanceof Error ? err.message : 'Claude Code probe failed.',
            }
        }

        // ---------- Codex, Anthropic & OpenAI ----------
        // Codex uses explicit model ids (no "latest" alias, no list command), and
        // the Anthropic/OpenAI API fetchers aren't implemented yet.
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
  })
}
