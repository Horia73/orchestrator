import { NextResponse } from 'next/server'

import { getApiKey } from '@/lib/config'
import {
    getEffectiveModel,
    getEffectiveRegistry,
    invalidateRegistryCache,
    patchCuratedModel,
} from '@/lib/models/registry'
import { readLiveRegistry, writeLiveRegistry } from '@/lib/models/store'
import { fetchGoogleModels } from '@/lib/models/fetcher'
import { probeClaudeAliasVersions, type ClaudeAlias } from '@/lib/cli/model-probe'

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
    skipped?: 'no_api_key' | 'not_implemented'
}

// Claude Code's picker entries are curated in seed.json keyed by the CLI's own
// aliases. We can't list models from the CLI, but we can resolve each alias's
// current version and keep these labels honest. `default` and `opus[1m]` track
// the `opus` alias (the CLI's default is Opus at 1M context).
const CLAUDE_MODEL_LABELS: Array<{
    modelId: string
    alias: ClaudeAlias
    label: (version: string) => string
}> = [
    { modelId: 'default', alias: 'opus', label: v => `Default (Opus ${v})` },
    { modelId: 'opus[1m]', alias: 'opus', label: v => `Opus ${v} (1M context)` },
    { modelId: 'sonnet', alias: 'sonnet', label: v => `Sonnet ${v}` },
    { modelId: 'sonnet[1m]', alias: 'sonnet', label: v => `Sonnet ${v} (1M context)` },
    { modelId: 'haiku', alias: 'haiku', label: v => `Haiku ${v}` },
]

/**
 * Relabel the existing claude-code entries to the versions the CLI currently
 * resolves, and auto-unarchive any whose version changed (the user archives
 * entries that have gone stale — e.g. all of them while they said "4.7" — so a
 * version bump should bring the affected ones back). Entries whose version is
 * unchanged are left exactly as the user left them (archived stays archived).
 * Returns how many entries we relabeled+unarchived.
 */
function syncClaudeCodeModelLabels(versions: Record<ClaudeAlias, string | null>): number {
    let changed = 0
    for (const { modelId, alias, label } of CLAUDE_MODEL_LABELS) {
        const version = versions[alias]
        if (!version) continue
        const model = getEffectiveModel('claude-code', modelId)
        if (!model) continue

        const freshLabel = label(version)
        // The live version isn't reflected in the current label → it changed
        // (or was never set). Relabel and bring the entry back into the picker.
        if (!model.name.includes(version)) {
            patchCuratedModel('claude-code', modelId, { displayNameOverride: freshLabel, archived: false })
            changed++
        } else if (model.name !== freshLabel) {
            // Version current, only the label format differs — fix the label
            // but respect a deliberate archive.
            patchCuratedModel('claude-code', modelId, { displayNameOverride: freshLabel })
        }
    }
    return changed
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
    // No model-list API — probe the opus/sonnet/haiku aliases for the version
    // each resolves to, then relabel the existing seed entries and unarchive
    // any whose version changed. We never invent new models; the set mirrors
    // `claude /models`. Also purge any stale live entries a former alias-probe
    // experiment wrote.
    for (const cliProvider of ['claude-code', 'codex']) {
        if (live.providers[cliProvider]) delete live.providers[cliProvider]
    }
    try {
        const versions = await probeClaudeAliasVersions()
        if (Object.values(versions).some(Boolean)) {
            const synced = syncClaudeCodeModelLabels(versions)
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
}
