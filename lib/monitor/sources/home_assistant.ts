import { evaluateRule, type HomeAssistantCandidate } from '../rules'
import type { WatchState } from '../schema'
import { extractEntityIdsFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// Home Assistant source adapter.
//
// One HA watch can reference multiple entities (rule composes ha_* leaves
// for different entity_ids via any_of/all_of). Each tick:
//   1. Check connectivity (REST + token reachable).
//   2. For each entity referenced by the rule, fetch its current state.
//   3. Pair with previous state stored in WatchState.extra.ha[entity].
//   4. Build one HomeAssistantCandidate per entity (current + previous).
//   5. Evaluate the watch's rule against each candidate. Transition rules
//      (state_equals, threshold) fire only when the entity crossed the
//      condition since last tick — see lib/monitor/rules.ts for semantics.
//   6. Persist the new states as "previous" for next tick.
//
// No priming pass — HA users expect "alert if the door is open" to fire
// immediately if it's open right now. If that produces noise, the model
// can add a suppress pattern. This is the inverse of Gmail (where priming
// is critical to avoid blasting the entire inbox on watch creation).
// ---------------------------------------------------------------------------

const HA_KEY = 'home_assistant'

interface HaPrevious {
    state: string
    attributes: Record<string, unknown>
    lastChanged: number | null
    /** Pre-parsed numeric value when `state` looked like a number. */
    numericValue: number | null
}

interface HaExtra {
    /** Per-entity previous snapshots. Key = entity_id. */
    entities?: Record<string, HaPrevious>
}

function readHaExtra(state: WatchState): HaExtra {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[HA_KEY]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as HaExtra
}

function mergeHaExtra(state: WatchState, nextEntities: Record<string, HaPrevious>): Record<string, unknown> {
    const next = { ...(state.extra ?? {}) } as Record<string, unknown>
    const prev = readHaExtra(state)
    next[HA_KEY] = { entities: { ...(prev.entities ?? {}), ...nextEntities } }
    return next
}

function parseNumeric(raw: string): number | null {
    if (raw === '' || raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

function parseHaTimestamp(raw: string | undefined): number | null {
    if (!raw) return null
    const ts = Date.parse(raw)
    return Number.isFinite(ts) ? ts : null
}

export const homeAssistantSourceAdapter: SourceAdapter = {
    source: 'home_assistant',
    supportedRuleKinds: ['ha_state_equals', 'ha_state_changes', 'ha_attribute_changes', 'ha_threshold'],
    supportedActionKinds: ['notify_inbox', 'ha_call_service'],

    async isAvailable(): Promise<AvailabilityResult> {
        try {
            const { getHomeAssistantIntegrationStatus } = await import('@/lib/integrations/home-assistant')
            // Pass validate=false: the master tick runs frequently and we don't
            // want to ping HA twice (once to check status, once to fetch). The
            // cheap-check itself will surface any connectivity issue.
            const status = await getHomeAssistantIntegrationStatus(false)
            if (!status.configured) return { available: false, reason: 'Home Assistant not configured — set URL and token.' }
            if (status.needsReconnect) return { available: false, reason: 'Home Assistant token needs reconnect.' }
            return { available: true }
        } catch (err) {
            return { available: false, reason: err instanceof Error ? err.message : 'Home Assistant status check failed.' }
        }
    },

    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('home_assistant', async () => {
            const { watch, now, timeoutMs } = input
            const entityIds = extractEntityIdsFromRule(watch.rule)
            if (entityIds.length === 0) {
                return {
                    ok: false,
                    error: 'Home Assistant watch has no entity_id predicates.',
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {},
                    fetchedAt: now,
                }
            }

            const { homeAssistantGetState } = await import('@/lib/integrations/home-assistant')
            const extra = readHaExtra(watch.state)
            const perEntityBudget = Math.max(2000, Math.floor(timeoutMs / Math.max(1, entityIds.length)))

            const matches: MatchedCandidate[] = []
            const errors: string[] = []
            const newPrevious: Record<string, HaPrevious> = {}
            let candidatesSeen = 0

            for (const entityId of entityIds) {
                try {
                    const current = await withTimeout(
                        homeAssistantGetState(entityId),
                        perEntityBudget,
                        `HA get_state ${entityId}`,
                    )
                    candidatesSeen += 1
                    const prev = extra.entities?.[entityId]
                    const attributes: Record<string, unknown> = current.attributes ?? {}
                    const numericValue = parseNumeric(current.state)

                    const candidate: HomeAssistantCandidate = {
                        source: 'home_assistant',
                        entityId: current.entity_id,
                        state: current.state,
                        attributes,
                        numericValue,
                        previousState: prev?.state ?? null,
                        previousAttributes: prev?.attributes ?? null,
                        previousNumericValue: prev?.numericValue ?? null,
                        lastChanged: parseHaTimestamp(current.last_changed) ?? parseHaTimestamp(current.last_updated),
                    }

                    // Persist NEW previous BEFORE deciding match, so the next
                    // tick has accurate prior even if we end up not firing.
                    newPrevious[entityId] = {
                        state: current.state,
                        attributes,
                        lastChanged: candidate.lastChanged,
                        numericValue,
                    }

                    if (evaluateRule(watch.rule, candidate)) {
                        const prevStr = prev?.state ?? '(first observation)'
                        matches.push({
                            candidate,
                            summary: `${entityId}: ${prevStr} → ${current.state}`,
                            externalId: `${entityId}@${candidate.lastChanged ?? now}`,
                            details: {
                                entityId,
                                previousState: prev?.state ?? null,
                                state: current.state,
                                numericValue,
                                attributes,
                                lastChanged: current.last_changed ?? null,
                            },
                        })
                    }
                } catch (err) {
                    errors.push(
                        err instanceof Error
                            ? `${entityId}: ${err.message}`
                            : `${entityId}: ${String(err)}`,
                    )
                }
            }

            return {
                ok: errors.length === 0,
                error: errors.length > 0 ? errors.join('; ') : undefined,
                matches,
                candidatesSeen,
                stateUpdate: {
                    lastFetchedAt: now,
                    extra: mergeHaExtra(watch.state, newPrevious),
                },
                fetchedAt: now,
            }
        })
    },
}
