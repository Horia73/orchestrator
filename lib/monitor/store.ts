import { randomUUID } from 'crypto'

import db from '@/lib/db'
import { emitAppEvent } from '@/lib/events'

import {
    CadencePolicySchema,
    CreateMonitorWatchInputSchema,
    MonitorActionSchema,
    MonitorRuleSchema,
    MonitorWatchSchema,
    NotifyPolicySchema,
    SuppressPatternSchema,
    UpdateMonitorWatchInputSchema,
    WatchEventKindSchema,
    WatchEventSchema,
    WatchStateSchema,
    assertRuleDepth,
    type CadencePolicy,
    type CreateMonitorWatchInput,
    type MonitorAction,
    type MonitorRule,
    type MonitorWatch,
    type NotifyPolicy,
    type SuppressPattern,
    type UpdateMonitorWatchInput,
    type WatchEvent,
    type WatchEventKind,
    type WatchSource,
    type WatchState,
} from './schema'
import { RULE_KINDS_BY_SOURCE, ruleMatchesSource } from './rules'

// ---------------------------------------------------------------------------
// Smart Monitor SQLite store.
//
// Tables defined here at module load (same pattern as lib/watchlist/store.ts).
// The watch row stores most of the domain object as JSON columns — rules,
// policies, state, and suppress patterns are small documents we never query
// inside SQL, so JSON keeps the schema flat and forward-compatible. The two
// columns we do index on (`enabled`, `nextCheckAt`) drive the engine's hot
// loop and the auto-arm decision.
// ---------------------------------------------------------------------------

db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_watches (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        rule TEXT NOT NULL,
        allowedActions TEXT NOT NULL,
        cadence TEXT NOT NULL,
        notify TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        suppressPatterns TEXT NOT NULL,
        lastCheckedAt INTEGER,
        nextCheckAt INTEGER,
        lastFiredAt INTEGER,
        consecutiveErrors INTEGER NOT NULL DEFAULT 0,
        lastError TEXT,
        createdBy TEXT NOT NULL DEFAULT 'orchestrator',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_watches_due ON monitor_watches(enabled, nextCheckAt);
    CREATE INDEX IF NOT EXISTS idx_monitor_watches_source ON monitor_watches(source);

    CREATE TABLE IF NOT EXISTS monitor_watch_events (
        id TEXT PRIMARY KEY,
        watchId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        FOREIGN KEY (watchId) REFERENCES monitor_watches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_watch_events_watch ON monitor_watch_events(watchId, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_watch_events_kind ON monitor_watch_events(watchId, kind, ts DESC);
`)

// Per-watch event ring cap. Beyond this we prune the oldest events on insert
// so a noisy watch does not grow the table indefinitely. Generous enough that
// the detail panel can still show a meaningful history (hundreds of ticks).
const MAX_EVENTS_PER_WATCH = 500

// ---------------------------------------------------------------------------
// row <-> domain
// ---------------------------------------------------------------------------

interface MonitorWatchRow {
    id: string
    title: string
    source: string
    target: string
    rule: string
    allowedActions: string
    cadence: string
    notify: string
    enabled: number
    state: string
    suppressPatterns: string
    lastCheckedAt: number | null
    nextCheckAt: number | null
    lastFiredAt: number | null
    consecutiveErrors: number
    lastError: string | null
    createdBy: string
    createdAt: number
    updatedAt: number
}

interface WatchEventRow {
    id: string
    watchId: string
    ts: number
    kind: string
    payload: string | null
}

function parseRuleJson(raw: string): MonitorRule {
    const parsed = MonitorRuleSchema.parse(JSON.parse(raw))
    assertRuleDepth(parsed)
    return parsed
}

function parseActionsJson(raw: string): MonitorAction[] {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((a) => MonitorActionSchema.parse(a))
}

function parseSuppressJson(raw: string): SuppressPattern[] {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((p) => SuppressPatternSchema.parse(p))
}

function watchFromRow(row: MonitorWatchRow): MonitorWatch {
    return MonitorWatchSchema.parse({
        id: row.id,
        title: row.title,
        source: row.source,
        target: row.target,
        rule: parseRuleJson(row.rule),
        allowedActions: parseActionsJson(row.allowedActions),
        cadence: CadencePolicySchema.parse(JSON.parse(row.cadence)),
        notify: NotifyPolicySchema.parse(JSON.parse(row.notify)),
        enabled: row.enabled === 1,
        state: WatchStateSchema.parse(JSON.parse(row.state)),
        suppressPatterns: parseSuppressJson(row.suppressPatterns),
        lastCheckedAt: row.lastCheckedAt ?? null,
        nextCheckAt: row.nextCheckAt ?? null,
        lastFiredAt: row.lastFiredAt ?? null,
        consecutiveErrors: row.consecutiveErrors,
        lastError: row.lastError ?? null,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    })
}

function eventFromRow(row: WatchEventRow): WatchEvent {
    return WatchEventSchema.parse({
        id: row.id,
        watchId: row.watchId,
        ts: row.ts,
        kind: row.kind,
        payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    })
}

function emitWatchesChanged(watchId?: string, reason?: string) {
    emitAppEvent({ type: 'monitor_watches.changed', watchId, reason })
}

function emitWatchEventsChanged(watchId: string, eventId?: string) {
    emitAppEvent({ type: 'monitor_watch_events.changed', watchId, eventId })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getMonitorWatch(id: string): MonitorWatch | null {
    const row = db
        .prepare('SELECT * FROM monitor_watches WHERE id = ?')
        .get(id) as MonitorWatchRow | undefined
    return row ? watchFromRow(row) : null
}

export interface ListMonitorWatchesOptions {
    source?: WatchSource
    enabled?: boolean
}

export function listMonitorWatches(
    options: ListMonitorWatchesOptions = {},
): MonitorWatch[] {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (options.source !== undefined) {
        where.push('source = @source')
        params.source = options.source
    }
    if (options.enabled !== undefined) {
        where.push('enabled = @enabled')
        params.enabled = options.enabled ? 1 : 0
    }
    const sql = `SELECT * FROM monitor_watches${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC`
    const rows = db.prepare(sql).all(params) as MonitorWatchRow[]
    return rows.map(watchFromRow)
}

/** Enabled watches whose nextCheckAt has come due (or which were never checked
 *  yet — nextCheckAt is null). Used by the engine inside the hot tick. */
export function listDueWatches(now: number): MonitorWatch[] {
    const rows = db
        .prepare(
            `SELECT * FROM monitor_watches
             WHERE enabled = 1
               AND (nextCheckAt IS NULL OR nextCheckAt <= @now)
             ORDER BY (nextCheckAt IS NULL) DESC, nextCheckAt ASC, createdAt ASC`,
        )
        .all({ now }) as MonitorWatchRow[]
    return rows.map(watchFromRow)
}

export function countEnabledWatches(): number {
    const row = db
        .prepare('SELECT COUNT(*) AS n FROM monitor_watches WHERE enabled = 1')
        .get() as { n: number }
    return row.n
}

/** Earliest pending nextCheckAt across all enabled watches — or null if no
 *  watch is scheduled. The engine's master tick is fixed at MIN_CADENCE_SECONDS
 *  (cheap, no model in the hot loop), so this is NOT what drives the master
 *  timer. It is used by the UI ("next due in Ns") and by the engine to decide
 *  whether to no-op a given tick when no watch is yet due. A row with NULL
 *  nextCheckAt (never checked) is treated as "due now" so newly-added watches
 *  get picked up on the next master tick. */
export function getNextDueTime(): number | null {
    const row = db
        .prepare(
            `SELECT MIN(nextCheckAt) AS next
             FROM monitor_watches
             WHERE enabled = 1 AND nextCheckAt IS NOT NULL`,
        )
        .get() as { next: number | null }
    const hasUnscheduled = db
        .prepare(
            `SELECT 1 FROM monitor_watches WHERE enabled = 1 AND nextCheckAt IS NULL LIMIT 1`,
        )
        .get() as { 1: number } | undefined
    // An unscheduled enabled watch means "wake now". Match the engine's
    // expectation by returning a time in the immediate past.
    if (hasUnscheduled) return Math.min(row.next ?? Number.POSITIVE_INFINITY, Date.now())
    return row.next ?? null
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function applyCadenceDefaults(partial: CadencePolicy | undefined): CadencePolicy {
    return CadencePolicySchema.parse(partial ?? {})
}

function applyNotifyDefaults(partial: NotifyPolicy | undefined): NotifyPolicy {
    return NotifyPolicySchema.parse(partial ?? {})
}

function assertRuleSourceCompat(rule: MonitorRule, source: WatchSource): void {
    // `custom` slot is intentionally unconstrained — adapter-less today.
    if (source === 'custom') return
    if (!ruleMatchesSource(rule, source)) {
        const allowed = (RULE_KINDS_BY_SOURCE[source] as readonly MonitorRule['kind'][]).join(', ')
        throw new Error(
            `Rule contains predicate(s) not supported by source "${source}". Allowed kinds for this source: ${allowed || '(none)'}`,
        )
    }
}

export function createMonitorWatch(input: CreateMonitorWatchInput): MonitorWatch {
    const validated = CreateMonitorWatchInputSchema.parse(input)
    assertRuleDepth(validated.rule)
    assertRuleSourceCompat(validated.rule, validated.source)

    const now = Date.now()
    const id = `mw_${randomUUID()}`
    const cadence = applyCadenceDefaults(validated.cadence)
    const notify = applyNotifyDefaults(validated.notify)
    const state = WatchStateSchema.parse({})

    const row: MonitorWatchRow = {
        id,
        title: validated.title,
        source: validated.source,
        target: validated.target,
        rule: JSON.stringify(validated.rule),
        allowedActions: JSON.stringify(validated.allowedActions),
        cadence: JSON.stringify(cadence),
        notify: JSON.stringify(notify),
        enabled: validated.enabled ? 1 : 0,
        state: JSON.stringify(state),
        suppressPatterns: JSON.stringify([]),
        lastCheckedAt: null,
        // Unscheduled — the engine will pick this up on its next master tick
        // and assign a real nextCheckAt based on cadence.current.
        nextCheckAt: null,
        lastFiredAt: null,
        consecutiveErrors: 0,
        lastError: null,
        createdBy: validated.createdBy,
        createdAt: now,
        updatedAt: now,
    }

    const insert = db.prepare(`
        INSERT INTO monitor_watches (
            id, title, source, target, rule, allowedActions, cadence, notify, enabled,
            state, suppressPatterns, lastCheckedAt, nextCheckAt, lastFiredAt,
            consecutiveErrors, lastError, createdBy, createdAt, updatedAt
        ) VALUES (
            @id, @title, @source, @target, @rule, @allowedActions, @cadence, @notify, @enabled,
            @state, @suppressPatterns, @lastCheckedAt, @nextCheckAt, @lastFiredAt,
            @consecutiveErrors, @lastError, @createdBy, @createdAt, @updatedAt
        )
    `)
    insert.run(row)

    // Bootstrap audit log so the detail panel is never empty.
    recordWatchEvent(id, 'check', { bootstrap: true, message: 'watch created' }, now)

    emitWatchesChanged(id, 'created')
    return watchFromRow(row)
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export function updateMonitorWatch(
    id: string,
    patch: UpdateMonitorWatchInput,
): MonitorWatch | null {
    const validated = UpdateMonitorWatchInputSchema.parse(patch)
    if (validated.rule) assertRuleDepth(validated.rule)

    const existing = getMonitorWatch(id)
    if (!existing) return null

    if (validated.rule) assertRuleSourceCompat(validated.rule, existing.source)

    // Partial cadence/notify merge with re-validation so the model can flip
    // a single field without re-sending the whole policy. We re-parse via the
    // full schema so the .refine() constraints (min<=max, current within range)
    // run even on partial updates.
    const nextCadence: CadencePolicy = validated.cadence
        ? CadencePolicySchema.parse({ ...existing.cadence, ...validated.cadence })
        : existing.cadence
    const nextNotify: NotifyPolicy = validated.notify
        ? NotifyPolicySchema.parse({ ...existing.notify, ...validated.notify })
        : existing.notify

    const next: MonitorWatch = {
        ...existing,
        title: validated.title ?? existing.title,
        target: validated.target ?? existing.target,
        rule: validated.rule ?? existing.rule,
        allowedActions: validated.allowedActions ?? existing.allowedActions,
        cadence: nextCadence,
        notify: nextNotify,
        enabled: validated.enabled ?? existing.enabled,
        updatedAt: Date.now(),
    }

    db.prepare(`
        UPDATE monitor_watches
        SET title = @title,
            target = @target,
            rule = @rule,
            allowedActions = @allowedActions,
            cadence = @cadence,
            notify = @notify,
            enabled = @enabled,
            updatedAt = @updatedAt
        WHERE id = @id
    `).run({
        id,
        title: next.title,
        target: next.target,
        rule: JSON.stringify(next.rule),
        allowedActions: JSON.stringify(next.allowedActions),
        cadence: JSON.stringify(next.cadence),
        notify: JSON.stringify(next.notify),
        enabled: next.enabled ? 1 : 0,
        updatedAt: next.updatedAt,
    })

    emitWatchesChanged(id, 'updated')
    return getMonitorWatch(id)
}

export function setWatchEnabled(id: string, enabled: boolean): MonitorWatch | null {
    const existing = getMonitorWatch(id)
    if (!existing) return null
    if (existing.enabled === enabled) return existing
    db.prepare(
        `UPDATE monitor_watches SET enabled = @enabled, updatedAt = @updatedAt WHERE id = @id`,
    ).run({ id, enabled: enabled ? 1 : 0, updatedAt: Date.now() })
    emitWatchesChanged(id, enabled ? 'enabled' : 'disabled')
    return getMonitorWatch(id)
}

// ---------------------------------------------------------------------------
// Engine-facing mutators (state, checkpoint, cadence, suppression)
// ---------------------------------------------------------------------------

/** Replace the watch's private state wholesale. Engine calls this at the end
 *  of each tick after merging deltas. */
export function setWatchState(id: string, state: WatchState): boolean {
    const validated = WatchStateSchema.parse(state)
    const result = db
        .prepare(
            `UPDATE monitor_watches SET state = @state, updatedAt = @updatedAt WHERE id = @id`,
        )
        .run({
            id,
            state: JSON.stringify(validated),
            updatedAt: Date.now(),
        })
    if (result.changes === 0) return false
    emitWatchesChanged(id, 'state')
    return true
}

export interface WatchCheckpointPatch {
    lastCheckedAt?: number
    nextCheckAt?: number | null
    lastFiredAt?: number
    consecutiveErrors?: number
    lastError?: string | null
}

/** Update the engine bookkeeping columns in one statement. Only the provided
 *  fields are touched (other columns keep their values). */
export function setWatchCheckpoint(id: string, patch: WatchCheckpointPatch): boolean {
    const sets: string[] = []
    const params: Record<string, unknown> = { id, updatedAt: Date.now() }
    if (patch.lastCheckedAt !== undefined) {
        sets.push('lastCheckedAt = @lastCheckedAt')
        params.lastCheckedAt = patch.lastCheckedAt
    }
    if (patch.nextCheckAt !== undefined) {
        sets.push('nextCheckAt = @nextCheckAt')
        params.nextCheckAt = patch.nextCheckAt
    }
    if (patch.lastFiredAt !== undefined) {
        sets.push('lastFiredAt = @lastFiredAt')
        params.lastFiredAt = patch.lastFiredAt
    }
    if (patch.consecutiveErrors !== undefined) {
        sets.push('consecutiveErrors = @consecutiveErrors')
        params.consecutiveErrors = patch.consecutiveErrors
    }
    if (patch.lastError !== undefined) {
        sets.push('lastError = @lastError')
        params.lastError = patch.lastError
    }
    if (sets.length === 0) return false
    sets.push('updatedAt = @updatedAt')
    const result = db
        .prepare(`UPDATE monitor_watches SET ${sets.join(', ')} WHERE id = @id`)
        .run(params)
    if (result.changes === 0) return false
    emitWatchesChanged(id, 'checkpoint')
    return true
}

/** Adjust the cadence.current value (engine self-pacing), clamped to the
 *  watch's [min, max] bounds. No-op if adaptive is off. */
export function setWatchCadenceCurrent(
    id: string,
    desiredSeconds: number,
    opts: { force?: boolean } = {},
): MonitorWatch | null {
    const existing = getMonitorWatch(id)
    if (!existing) return null
    if (!opts.force && !existing.cadence.adaptive) return existing
    const clamped = Math.max(existing.cadence.min, Math.min(existing.cadence.max, Math.round(desiredSeconds)))
    if (clamped === existing.cadence.current) return existing
    const nextCadence = CadencePolicySchema.parse({ ...existing.cadence, current: clamped })
    db.prepare(
        `UPDATE monitor_watches SET cadence = @cadence, updatedAt = @updatedAt WHERE id = @id`,
    ).run({
        id,
        cadence: JSON.stringify(nextCadence),
        updatedAt: Date.now(),
    })
    recordWatchEvent(id, 'cadence_change', {
        from: existing.cadence.current,
        to: clamped,
    })
    emitWatchesChanged(id, 'cadence')
    return getMonitorWatch(id)
}

// ---------------------------------------------------------------------------
// Suppress patterns
// ---------------------------------------------------------------------------

export interface AddSuppressPatternInput {
    reason: string
    rule: MonitorRule
    expiresAt?: number | null
}

export function addSuppressPattern(
    id: string,
    input: AddSuppressPatternInput,
): SuppressPattern | null {
    assertRuleDepth(input.rule)
    const existing = getMonitorWatch(id)
    if (!existing) return null
    const pattern = SuppressPatternSchema.parse({
        id: `sp_${randomUUID()}`,
        createdAt: Date.now(),
        reason: input.reason,
        rule: input.rule,
        expiresAt: input.expiresAt ?? null,
    })
    const next = [...existing.suppressPatterns, pattern]
    db.prepare(
        `UPDATE monitor_watches SET suppressPatterns = @sp, updatedAt = @updatedAt WHERE id = @id`,
    ).run({
        id,
        sp: JSON.stringify(next),
        updatedAt: Date.now(),
    })
    recordWatchEvent(id, 'feedback', { added_suppress: pattern.id, reason: pattern.reason })
    emitWatchesChanged(id, 'suppress_added')
    return pattern
}

export function removeSuppressPattern(id: string, patternId: string): boolean {
    const existing = getMonitorWatch(id)
    if (!existing) return false
    const filtered = existing.suppressPatterns.filter((p) => p.id !== patternId)
    if (filtered.length === existing.suppressPatterns.length) return false
    db.prepare(
        `UPDATE monitor_watches SET suppressPatterns = @sp, updatedAt = @updatedAt WHERE id = @id`,
    ).run({
        id,
        sp: JSON.stringify(filtered),
        updatedAt: Date.now(),
    })
    recordWatchEvent(id, 'feedback', { removed_suppress: patternId })
    emitWatchesChanged(id, 'suppress_removed')
    return true
}

/** Engine-side: a suppress pattern just dropped a candidate; bump its counters
 *  so the UI can show "this pattern suppressed N events". */
export function incrementSuppressPatternMatch(id: string, patternId: string): void {
    const existing = getMonitorWatch(id)
    if (!existing) return
    let touched = false
    const next = existing.suppressPatterns.map((p) => {
        if (p.id !== patternId) return p
        touched = true
        return {
            ...p,
            matchCount: p.matchCount + 1,
            lastMatchedAt: Date.now(),
        }
    })
    if (!touched) return
    db.prepare(
        `UPDATE monitor_watches SET suppressPatterns = @sp, updatedAt = @updatedAt WHERE id = @id`,
    ).run({
        id,
        sp: JSON.stringify(next),
        updatedAt: Date.now(),
    })
    // Intentionally no emit here — fires once per suppressed candidate, would
    // be a noisy event source. The detail panel reads suppressPatterns when
    // the user opens it.
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function deleteMonitorWatch(id: string): boolean {
    const result = db.prepare('DELETE FROM monitor_watches WHERE id = ?').run(id)
    if (result.changes === 0) return false
    emitWatchesChanged(id, 'deleted')
    return true
}

// ---------------------------------------------------------------------------
// Watch events (audit log)
// ---------------------------------------------------------------------------

export function recordWatchEvent(
    watchId: string,
    kind: WatchEventKind,
    payload?: Record<string, unknown> | null,
    ts?: number,
): WatchEvent | null {
    WatchEventKindSchema.parse(kind)
    const exists = db
        .prepare('SELECT 1 FROM monitor_watches WHERE id = ? LIMIT 1')
        .get(watchId) as { 1: number } | undefined
    if (!exists) return null

    const event: WatchEvent = WatchEventSchema.parse({
        id: `mwe_${randomUUID()}`,
        watchId,
        ts: ts ?? Date.now(),
        kind,
        payload: payload ?? null,
    })

    db.prepare(
        `INSERT INTO monitor_watch_events (id, watchId, ts, kind, payload)
         VALUES (@id, @watchId, @ts, @kind, @payload)`,
    ).run({
        id: event.id,
        watchId: event.watchId,
        ts: event.ts,
        kind: event.kind,
        payload: event.payload ? JSON.stringify(event.payload) : null,
    })

    pruneWatchEvents(watchId)

    emitWatchEventsChanged(watchId, event.id)
    return event
}

export interface ListWatchEventsOptions {
    limit?: number
    before?: number
    kinds?: WatchEventKind[]
}

export function listWatchEvents(
    watchId: string,
    options: ListWatchEventsOptions = {},
): WatchEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
    const where: string[] = ['watchId = @watchId']
    const params: Record<string, unknown> = { watchId, limit }
    if (options.before !== undefined) {
        where.push('ts < @before')
        params.before = options.before
    }
    if (options.kinds && options.kinds.length > 0) {
        const placeholders = options.kinds
            .map((_, i) => {
                const key = `kind_${i}`
                params[key] = options.kinds![i]
                return `@${key}`
            })
            .join(', ')
        where.push(`kind IN (${placeholders})`)
    }
    const rows = db
        .prepare(
            `SELECT * FROM monitor_watch_events
             WHERE ${where.join(' AND ')}
             ORDER BY ts DESC, id DESC
             LIMIT @limit`,
        )
        .all(params) as WatchEventRow[]
    return rows.map(eventFromRow)
}

/** Trim a watch's audit log down to the most-recent MAX_EVENTS_PER_WATCH. We
 *  do this lazily on each insert rather than via a background sweeper so the
 *  bound is enforced even after long offline periods. */
function pruneWatchEvents(watchId: string): void {
    db.prepare(
        `DELETE FROM monitor_watch_events
         WHERE watchId = @watchId
           AND id NOT IN (
             SELECT id FROM monitor_watch_events
             WHERE watchId = @watchId
             ORDER BY ts DESC, id DESC
             LIMIT @keep
           )`,
    ).run({ watchId, keep: MAX_EVENTS_PER_WATCH })
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
    CadencePolicy,
    CreateMonitorWatchInput,
    MonitorAction,
    MonitorRule,
    MonitorWatch,
    NotifyPolicy,
    SuppressPattern,
    UpdateMonitorWatchInput,
    WatchEvent,
    WatchEventKind,
    WatchSource,
    WatchState,
} from './schema'

export { EMPTY_WATCH_STATE } from './schema'
