import { resolveAppOrigin } from '@/lib/app-origin'

import { evaluateRule, type GmailCandidate } from '../rules'
import type { WatchState } from '../schema'
import { buildGmailQueryFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type PendingRevalidationInput,
    type PendingRevalidationResult,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// Gmail source adapter.
//
// Cheap-check shape:
//   1. Ask the existing Gmail integration if it is connected; if not, return
//      ok=false with a reason (engine surfaces "reconnect Gmail to resume").
//   2. Translate the watch's rule into a Gmail server-side query via
//      buildGmailQueryFromRule(), then AND a time-window filter
//      ("newer_than:Nh") so we never page through unbounded history.
//   3. First tick on a new watch (no `lastFetchedAt`) is a PRIMING pass that
//      sets the watermark and produces zero matches. We only notify on mail
//      that arrives AFTER the watch was created. This matches the product
//      promise: nothing happens by default; the user decides what's worth
//      monitoring from now on.
//   4. Subsequent ticks: fetch messages since the watermark, drop anything
//      whose id is in our seen-ring (handles overlap from generous query
//      windows), evaluate the full client-side rule (server query is just a
//      pre-filter), and return matches.
//
// All Gmail message ids surfaced as matches become candidates for the
// learning loop's suppress patterns and for the model's wake-prompt
// consolidation; the engine handles that.
// ---------------------------------------------------------------------------

const SEEN_RING_CAP = 200
const MIN_QUERY_WINDOW_HOURS = 1
const MAX_QUERY_WINDOW_HOURS = 24
const MAX_FETCH = 25 // Gmail API max for one paged call in our wrapper

interface GmailExtraState {
    /** Epoch ms of the most-recently-seen message; we fetch newer than this. */
    lastSeenAt?: number
    /** Bounded LRU of Gmail message ids we've already surfaced. Prevents
     *  duplicate notifications when the query window overlaps with mail we
     *  already processed last tick. */
    lastSeenIds?: string[]
    /** Whether the priming tick has run. Until true, the next cheap-check
     *  consumes the priming pass and notifies nothing. */
    primed?: boolean
}

const GMAIL_KEY = 'gmail'

function readGmailExtra(state: WatchState): GmailExtraState {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[GMAIL_KEY]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as GmailExtraState
}

function mergeGmailExtra(state: WatchState, patch: GmailExtraState): Record<string, unknown> {
    const next = { ...(state.extra ?? {}) } as Record<string, unknown>
    const prev = readGmailExtra(state)
    next[GMAIL_KEY] = { ...prev, ...patch }
    return next
}

function parseGmailDate(raw: string): number {
    // Gmail's "internalDate"-derived header is RFC 2822 — Date.parse handles it.
    const ts = Date.parse(raw)
    return Number.isFinite(ts) ? ts : 0
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function gmailNotFound(err: unknown): boolean {
    return err instanceof Error && /\bGmail API failed \(404\)\b/.test(err.message)
}

function staleReasonFromLabels(originalLabels: string[], currentLabels: string[]): string | null {
    const original = new Set(originalLabels)
    const current = new Set(currentLabels)
    if (current.has('TRASH')) return 'Gmail message is now in Trash.'
    if (current.has('SPAM')) return 'Gmail message is now in Spam.'
    if (original.has('UNREAD') && !current.has('UNREAD')) return 'Gmail message is no longer unread.'
    if (original.has('INBOX') && !current.has('INBOX')) return 'Gmail message is no longer in the Inbox.'
    return null
}

function pickWindowHours(cadenceSeconds: number, lastSeenAt: number | undefined, now: number): number {
    // Choose a query window large enough to cover this tick's cadence plus a
    // generous buffer for missed ticks (laptop closed). Bounded so the query
    // never blows past 24h of history.
    if (lastSeenAt) {
        const gapHours = (now - lastSeenAt) / 3_600_000
        return Math.max(MIN_QUERY_WINDOW_HOURS, Math.min(MAX_QUERY_WINDOW_HOURS, Math.ceil(gapHours + 0.5)))
    }
    const cadenceHours = cadenceSeconds / 3600
    return Math.max(MIN_QUERY_WINDOW_HOURS, Math.min(MAX_QUERY_WINDOW_HOURS, Math.ceil(cadenceHours * 4)))
}

export const gmailSourceAdapter: SourceAdapter = {
    source: 'gmail',
    supportedRuleKinds: ['gmail_from', 'gmail_subject_contains', 'gmail_label', 'gmail_query'],
    supportedActionKinds: ['notify_inbox', 'gmail_archive', 'gmail_mark_read', 'gmail_label_add', 'gmail_send'],

    async isAvailable(): Promise<AvailabilityResult> {
        try {
            const { getGmailIntegrationStatus } = await import('@/lib/integrations/gmail')
            const status = await getGmailIntegrationStatus(resolveAppOrigin())
            if (!status.configured) return { available: false, reason: 'Gmail OAuth not configured.' }
            if (!status.connected) return { available: false, reason: 'Gmail not connected — sign in to resume.' }
            if (status.needsReconnect) return { available: false, reason: 'Gmail token expired — reconnect to resume.' }
            return { available: true }
        } catch (err) {
            return { available: false, reason: err instanceof Error ? err.message : 'Gmail status check failed.' }
        }
    },

    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('gmail', async () => {
            const { watch, now, timeoutMs } = input
            const ruleQuery = buildGmailQueryFromRule(watch.rule)
            if (!ruleQuery) {
                return {
                    ok: false,
                    error: 'Gmail watch has no Gmail rule predicates.',
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {},
                    fetchedAt: now,
                }
            }

            const extra = readGmailExtra(watch.state)
            const isPriming = !extra.primed

            // Priming tick: don't fetch yet, just mark primed and set the
            // watermark to "now". The engine schedules the next tick at
            // cadence.current — that's when we actually start reporting.
            if (isPriming) {
                return {
                    ok: true,
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {
                        lastFetchedAt: now,
                        extra: mergeGmailExtra(watch.state, { primed: true, lastSeenAt: now, lastSeenIds: [] }),
                    },
                    fetchedAt: now,
                }
            }

            const windowHours = pickWindowHours(watch.cadence.current, extra.lastSeenAt, now)
            const fullQuery = `(${ruleQuery}) newer_than:${windowHours}h`

            const { gmailSearchMessages } = await import('@/lib/integrations/gmail')
            const response = await withTimeout(
                gmailSearchMessages(fullQuery, MAX_FETCH),
                timeoutMs,
                'gmail search',
            )

            const seenIds = new Set(extra.lastSeenIds ?? [])
            const newlySeenIds: string[] = []
            const matches: MatchedCandidate[] = []
            let candidatesSeen = 0
            let newWatermark = extra.lastSeenAt ?? 0

            for (const m of response.results) {
                if (seenIds.has(m.id)) continue
                const ts = parseGmailDate(m.date)
                if (extra.lastSeenAt && ts !== 0 && ts <= extra.lastSeenAt) continue

                candidatesSeen += 1
                newlySeenIds.push(m.id)
                if (ts > newWatermark) newWatermark = ts

                const candidate: GmailCandidate = {
                    source: 'gmail',
                    id: m.id,
                    threadId: m.threadId,
                    labels: m.labelIds,
                    from: m.from,
                    to: m.to,
                    subject: m.subject,
                    snippet: m.snippet,
                    timestamp: ts || now,
                }

                if (evaluateRule(watch.rule, candidate)) {
                    matches.push({
                        candidate,
                        summary: `${m.from} — ${m.subject || '(no subject)'}`,
                        externalId: m.id,
                        details: {
                            messageId: m.id,
                            threadId: m.threadId,
                            from: m.from,
                            subject: m.subject,
                            snippet: m.snippet,
                            labels: m.labelIds,
                            date: m.date,
                        },
                    })
                }
            }

            // LRU truncate: keep the most recent SEEN_RING_CAP ids across this
            // tick's newcomers and last tick's ring.
            const mergedIds = [...newlySeenIds, ...(extra.lastSeenIds ?? [])].slice(0, SEEN_RING_CAP)

            return {
                ok: true,
                matches,
                candidatesSeen,
                stateUpdate: {
                    lastFetchedAt: now,
                    extra: mergeGmailExtra(watch.state, {
                        primed: true,
                        lastSeenAt: newWatermark || now,
                        lastSeenIds: mergedIds,
                    }),
                },
                fetchedAt: now,
            }
        })
    },

    revalidatePending(input: PendingRevalidationInput): Promise<PendingRevalidationResult> {
        return (async () => {
            const { watch, pending, now, timeoutMs } = input
            const details = pending.details ?? {}
            const messageId =
                typeof details.messageId === 'string'
                    ? details.messageId
                    : typeof pending.externalId === 'string'
                        ? pending.externalId
                        : null
            if (!messageId) {
                return { active: true, checkedAt: now, error: 'Gmail pending item has no message id to recheck.' }
            }

            try {
                const { gmailGetMessageMetadata } = await import('@/lib/integrations/gmail')
                const m = await withTimeout(
                    gmailGetMessageMetadata(messageId),
                    timeoutMs,
                    'gmail pending recheck',
                )
                const originalLabels = stringArray(details.labels)
                const staleReason = staleReasonFromLabels(originalLabels, m.labelIds)
                if (staleReason) {
                    return { active: false, reason: staleReason, checkedAt: now }
                }

                const ts = parseGmailDate(m.date)
                const candidate: GmailCandidate = {
                    source: 'gmail',
                    id: m.id,
                    threadId: m.threadId,
                    labels: m.labelIds,
                    from: m.from,
                    to: m.to,
                    subject: m.subject,
                    snippet: m.snippet,
                    timestamp: ts || now,
                }
                if (!evaluateRule(watch.rule, candidate)) {
                    return { active: false, reason: 'Gmail message no longer matches the watch rule.', checkedAt: now }
                }

                return {
                    active: true,
                    checkedAt: now,
                    summary: `${m.from} — ${m.subject || '(no subject)'}`,
                    details: {
                        ...details,
                        messageId: m.id,
                        threadId: m.threadId,
                        from: m.from,
                        subject: m.subject,
                        snippet: m.snippet,
                        labels: m.labelIds,
                        date: m.date,
                    },
                }
            } catch (err) {
                if (gmailNotFound(err)) {
                    return { active: false, reason: 'Gmail message no longer exists.', checkedAt: now }
                }
                return {
                    active: true,
                    checkedAt: now,
                    error: err instanceof Error ? err.message : String(err),
                }
            }
        })()
    },
}
