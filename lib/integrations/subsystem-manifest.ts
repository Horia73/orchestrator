import { MONITORING_DOCTRINE } from '@/lib/integrations/doctrines/monitoring'
import { SCHEDULING_DOCTRINE } from '@/lib/integrations/doctrines/scheduling'
import { WATCHLIST_DOCTRINE } from '@/lib/integrations/doctrines/watchlist'
import { MICROSCRIPTS_DOCTRINE } from '@/lib/integrations/doctrines/microscripts'

// ---------------------------------------------------------------------------
// Subsystem manifest — orchestrator-native capabilities that mirror the
// integration manifest's lazy-doctrine pattern.
//
// Unlike integrations (Gmail, Calendar, Maps, …), subsystems have no
// connection state and no setup runbook: they ship with the orchestrator.
// But their operating doctrine — schema, rule grammars, lifecycle nuances —
// is heavy enough that always-on inclusion bloats every turn. So we route
// them through the same activation primitive (ActivateIntegrationTools):
// the always-on <subsystems> block tells the orchestrator each subsystem
// exists; the doctrine block is loaded only after activation.
//
// New subsystem? Add the doctrine file under lib/integrations/doctrines/
// and register the entry below. The activation tool and the prompt
// builders pick it up automatically.
// ---------------------------------------------------------------------------

export type SubsystemId = 'watchlist' | 'monitoring' | 'scheduling' | 'microscripts'

export interface SubsystemManifestEntry {
    /** Stable id used by ActivateIntegrationTools and the activation store. */
    id: SubsystemId
    /** Display label for the <subsystems> block. */
    label: string
    /** 1–2 line plain-language summary of what the subsystem does. Always in context. */
    capability: string
    /** Heavy operating doctrine loaded lazily — flow, rules, protocols, gotchas. */
    doctrine: string
}

export const SUBSYSTEM_MANIFEST: readonly SubsystemManifestEntry[] = [
    {
        id: 'watchlist',
        label: 'Watchlist',
        capability: 'Track financial instruments (stocks, ETFs, indexes, FX, crypto) and products with local price observations and charts. The Watchlist surface itself is local; background market monitoring is one consolidated heartbeat that auto-arms once a market-data key + at least one monitor-enabled item exists.',
        doctrine: WATCHLIST_DOCTRINE,
    },
    {
        id: 'monitoring',
        label: 'Smart Monitor',
        capability: 'Ongoing recurring model-owned work: persistent source monitoring, recurring summaries, recurring maintenance, and tell-me-when subscriptions. One consolidated scheduled agent wake handles connector-backed and custom prompt-backed watches; the agent decides what to inspect, notify, digest, and how to self-pace from history.',
        doctrine: MONITORING_DOCTRINE,
    },
    {
        id: 'scheduling',
        label: 'Scheduled tasks',
        capability: 'Real runtime automation for one-shot, delayed, bounded, and time-critical future work. Two action types: "tool" (cheap, no model at fire time) or "agent" (wakes a model with your prompt). Ongoing recurring model-owned work belongs in Smart Monitor.',
        doctrine: SCHEDULING_DOCTRINE,
    },
    {
        id: 'microscripts',
        label: 'Microscripts',
        capability: 'Bounded Python automations for small stateful watchers: run short checks, request permitted operations through the parent runtime, notify or act when conditions are met, then pause/complete/expire so they do not run forever.',
        doctrine: MICROSCRIPTS_DOCTRINE,
    },
]

const MANIFEST_BY_ID = new Map(SUBSYSTEM_MANIFEST.map((entry) => [entry.id, entry]))

export function getSubsystemManifest(id: string): SubsystemManifestEntry | undefined {
    return MANIFEST_BY_ID.get(id as SubsystemId)
}

export const ALL_SUBSYSTEM_IDS: SubsystemId[] = SUBSYSTEM_MANIFEST.map((entry) => entry.id)
