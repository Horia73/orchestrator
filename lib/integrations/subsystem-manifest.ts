import { MONITORING_DOCTRINE } from '@/lib/integrations/doctrines/monitoring'
import { SCHEDULING_DOCTRINE } from '@/lib/integrations/doctrines/scheduling'
import { WATCHLIST_DOCTRINE } from '@/lib/integrations/doctrines/watchlist'

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

export type SubsystemId = 'watchlist' | 'monitoring' | 'scheduling'

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
        capability: '"Tell me when X happens at <source>" subscriptions. One consolidated 15-minute heartbeat silently evaluates user-configured watches across Gmail / Google Calendar / WhatsApp / Home Assistant / Web / Weather; wakes the orchestrator only when a candidate survives suppress patterns and quiet hours.',
        doctrine: MONITORING_DOCTRINE,
    },
    {
        id: 'scheduling',
        label: 'Scheduled tasks',
        capability: 'Real runtime automation for "do X at/in/every <time>" — one-shot or recurring. Two action types: "tool" (cheap, no model at fire time) or "agent" (wakes a model with your prompt). Runs are silent by default; results reach the Inbox only via notify_inbox or errors.',
        doctrine: SCHEDULING_DOCTRINE,
    },
]

const MANIFEST_BY_ID = new Map(SUBSYSTEM_MANIFEST.map((entry) => [entry.id, entry]))

export function getSubsystemManifest(id: string): SubsystemManifestEntry | undefined {
    return MANIFEST_BY_ID.get(id as SubsystemId)
}

export const ALL_SUBSYSTEM_IDS: SubsystemId[] = SUBSYSTEM_MANIFEST.map((entry) => entry.id)
