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
import { probeClaudeCodeModels, type ClaudeModelProbeKey, type ClaudeResolvedModel } from '@/lib/cli/model-probe'
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

// Claude Code's picker entries are curated in seed.json keyed by the CLI's own
// aliases. We can't list models from the CLI, but we can resolve each selector
// entry to the concrete model id Claude Code reports and keep the labels honest.
const CLAUDE_MODEL_LABELS: Array<{
    modelId: string
    probeKey: ClaudeModelProbeKey
    label: (model: ClaudeResolvedModel) => string
}> = [
    { modelId: 'default', probeKey: 'default', label: model => `Default (${model.name})` },
    { modelId: 'opus[1m]', probeKey: 'opus[1m]', label: model => model.name },
    { modelId: 'sonnet', probeKey: 'sonnet', label: model => model.name },
    { modelId: 'sonnet[1m]', probeKey: 'sonnet[1m]', label: model => model.name },
    { modelId: 'haiku', probeKey: 'haiku', label: model => model.name },
]

/**
 * Relabel the existing claude-code entries to the names the CLI currently
 * resolves, and auto-unarchive any whose name changed (the user archives
 * entries that have gone stale, so a model bump should bring the affected ones
 * back). Entries whose label is unchanged are left exactly as the user left
 * them (archived stays archived).
 * Returns how many entries we relabeled+unarchived.
 */
function syncClaudeCodeModelLabels(models: Record<ClaudeModelProbeKey, ClaudeResolvedModel | null>): number {
    let changed = 0
    for (const { modelId, probeKey, label } of CLAUDE_MODEL_LABELS) {
        const resolved = models[probeKey]
        if (!resolved) continue
        const model = getEffectiveModel('claude-code', modelId)
        if (!model) continue

        const freshLabel = label(resolved)
        // The live label isn't reflected in the current label → it changed
        // (or was never set). Relabel and bring the entry back into the picker.
        if (model.name !== freshLabel) {
            patchCuratedModel('claude-code', modelId, { displayNameOverride: freshLabel, archived: false })
            changed++
        }
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
        // No model-list API — probe the selector entries for the concrete model
        // each resolves to, then relabel existing seed entries and unarchive any
        // whose label changed. We never invent new models; the set mirrors
        // `claude /models`. Also purge any stale live entries a former probe
        // experiment wrote.
        for (const cliProvider of ['claude-code', 'codex']) {
            if (live.providers[cliProvider]) delete live.providers[cliProvider]
        }
        try {
            const models = await probeClaudeCodeModels()
            if (Object.values(models).some(Boolean)) {
                const synced = syncClaudeCodeModelLabels(models)
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
