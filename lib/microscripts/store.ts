import { createHash, randomUUID } from 'crypto'

import db from '@/lib/db'
import { emitAppEvent } from '@/lib/events'

import {
    CreateMicroscriptInputSchema,
    MicroscriptManifestSchema,
    MicroscriptSchema,
    UpdateMicroscriptInputSchema,
    type CreateMicroscriptInput,
    type Microscript,
    type MicroscriptManifest,
    type MicroscriptRunRecord,
    type MicroscriptSchedule,
    type MicroscriptStatus,
    type UpdateMicroscriptInput,
} from './schema'

// ---------------------------------------------------------------------------
// SQLite store.
// ---------------------------------------------------------------------------

db.exec(`
    CREATE TABLE IF NOT EXISTS microscripts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        code TEXT NOT NULL,
        codeHash TEXT NOT NULL,
        manifest TEXT NOT NULL,
        state TEXT NOT NULL,
        nextRunAt INTEGER,
        lastRunAt INTEGER,
        lastRunStatus TEXT,
        lastRunError TEXT,
        runCount INTEGER NOT NULL DEFAULT 0,
        consecutiveFailures INTEGER NOT NULL DEFAULT 0,
        createdBy TEXT NOT NULL DEFAULT 'orchestrator',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_microscripts_due ON microscripts(enabled, status, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_microscripts_updated ON microscripts(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS microscript_runs (
        id TEXT PRIMARY KEY,
        scriptId TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        summary TEXT NOT NULL,
        error TEXT,
        phases INTEGER NOT NULL,
        operations INTEGER NOT NULL,
        surfaced INTEGER NOT NULL DEFAULT 0,
        conversationId TEXT,
        FOREIGN KEY (scriptId) REFERENCES microscripts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_microscript_runs_script ON microscript_runs(scriptId, startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_microscript_runs_started ON microscript_runs(startedAt DESC);

    CREATE TABLE IF NOT EXISTS microscript_events (
        id TEXT PRIMARY KEY,
        scriptId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        FOREIGN KEY (scriptId) REFERENCES microscripts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_microscript_events_script ON microscript_events(scriptId, ts DESC);
`)

const DEFAULT_TEMPORARY_LIFETIME_MS = 24 * 60 * 60_000
const MAX_EVENTS_PER_SCRIPT = 500

interface MicroscriptRow {
    id: string
    title: string
    enabled: number
    status: string
    code: string
    codeHash: string
    manifest: string
    state: string
    nextRunAt: number | null
    lastRunAt: number | null
    lastRunStatus: string | null
    lastRunError: string | null
    runCount: number
    consecutiveFailures: number
    createdBy: string
    createdAt: number
    updatedAt: number
}

type MicroscriptRunRow = Omit<MicroscriptRunRecord, 'surfaced'> & { surfaced: number }

export interface MicroscriptEvent {
    id: string
    scriptId: string
    ts: number
    kind: string
    payload: Record<string, unknown> | null
}

function emitMicroscriptsChanged(scriptId: string | undefined, reason: string): void {
    emitAppEvent({ type: 'microscripts.changed', scriptId, reason })
}

function emitMicroscriptRunsChanged(scriptId: string, runId?: string): void {
    emitAppEvent({ type: 'microscript_runs.changed', scriptId, runId })
}

function codeHash(code: string): string {
    return createHash('sha256').update(code).digest('hex')
}

function safeJsonObject(raw: string): Record<string, unknown> {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
}

function scriptFromRow(row: MicroscriptRow): Microscript {
    return MicroscriptSchema.parse({
        id: row.id,
        title: row.title,
        enabled: row.enabled === 1,
        status: row.status,
        code: row.code,
        codeHash: row.codeHash,
        manifest: MicroscriptManifestSchema.parse(JSON.parse(row.manifest)),
        state: safeJsonObject(row.state),
        nextRunAt: row.nextRunAt ?? null,
        lastRunAt: row.lastRunAt ?? null,
        lastRunStatus: row.lastRunStatus ?? null,
        lastRunError: row.lastRunError ?? null,
        runCount: row.runCount,
        consecutiveFailures: row.consecutiveFailures,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    })
}

function runFromRow(row: MicroscriptRunRow): MicroscriptRunRecord {
    return {
        ...row,
        surfaced: row.surfaced === 1,
        error: row.error ?? null,
        conversationId: row.conversationId ?? null,
    }
}

function eventFromRow(row: {
    id: string
    scriptId: string
    ts: number
    kind: string
    payload: string | null
}): MicroscriptEvent {
    return {
        id: row.id,
        scriptId: row.scriptId,
        ts: row.ts,
        kind: row.kind,
        payload: row.payload ? safeJsonObject(row.payload) : null,
    }
}

function normalizeManifestForCreate(input: MicroscriptManifest, now: number): MicroscriptManifest {
    const parsed = MicroscriptManifestSchema.parse(input)
    if (!parsed.stop.persistent && parsed.stop.expiresAt === null) {
        return {
            ...parsed,
            stop: {
                ...parsed.stop,
                expiresAt: now + DEFAULT_TEMPORARY_LIFETIME_MS,
            },
        }
    }
    return parsed
}

function nextRunForSchedule(schedule: MicroscriptSchedule, now: number): number | null {
    if (schedule.kind === 'manual') return null
    const startAt = schedule.startAt ?? now
    if (startAt > now) return startAt
    const elapsed = now - startAt
    const steps = Math.floor(elapsed / schedule.everyMs) + 1
    return startAt + steps * schedule.everyMs
}

function serializeState(state: Record<string, unknown>): string {
    let serialized = JSON.stringify(state ?? {})
    if (serialized.length > 100_000) serialized = serialized.slice(0, 100_000)
    return serialized
}

function serializeManifest(manifest: MicroscriptManifest): string {
    return JSON.stringify(MicroscriptManifestSchema.parse(manifest))
}

export function getMicroscript(id: string): Microscript | null {
    const row = db
        .prepare('SELECT * FROM microscripts WHERE id = ?')
        .get(id) as MicroscriptRow | undefined
    return row ? scriptFromRow(row) : null
}

export function listMicroscripts(options: {
    enabled?: boolean
    status?: MicroscriptStatus
} = {}): Microscript[] {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (options.enabled !== undefined) {
        where.push('enabled = @enabled')
        params.enabled = options.enabled ? 1 : 0
    }
    if (options.status !== undefined) {
        where.push('status = @status')
        params.status = options.status
    }
    const rows = db
        .prepare(`SELECT * FROM microscripts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updatedAt DESC`)
        .all(params) as MicroscriptRow[]
    return rows.map(scriptFromRow)
}

export function countRunnableMicroscripts(): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS n
             FROM microscripts
             WHERE enabled = 1 AND status IN ('active', 'error')`,
        )
        .get() as { n: number }
    return row.n
}

export function createMicroscript(input: CreateMicroscriptInput): Microscript {
    const parsed = CreateMicroscriptInputSchema.parse(input)
    const now = Date.now()
    const manifest = normalizeManifestForCreate(parsed.manifest, now)
    const id = `ms_${randomUUID()}`
    const enabled = parsed.enabled
    const status: MicroscriptStatus = enabled ? 'active' : 'paused'
    const nextRunAt = enabled ? nextRunForSchedule(manifest.schedule, now) : null

    db.prepare(
        `
        INSERT INTO microscripts (
            id, title, enabled, status, code, codeHash, manifest, state,
            nextRunAt, lastRunAt, lastRunStatus, lastRunError, runCount,
            consecutiveFailures, createdBy, createdAt, updatedAt
        ) VALUES (
            @id, @title, @enabled, @status, @code, @codeHash, @manifest, @state,
            @nextRunAt, NULL, NULL, NULL, 0,
            0, @createdBy, @createdAt, @updatedAt
        )
        `,
    ).run({
        id,
        title: parsed.title,
        enabled: enabled ? 1 : 0,
        status,
        code: parsed.code,
        codeHash: codeHash(parsed.code),
        manifest: serializeManifest(manifest),
        state: serializeState(parsed.initialState),
        nextRunAt,
        createdBy: parsed.createdBy,
        createdAt: now,
        updatedAt: now,
    })

    recordMicroscriptEvent(id, 'created', {
        schedule: manifest.schedule,
        expiresAt: manifest.stop.expiresAt,
        persistent: manifest.stop.persistent,
    })
    const created = getMicroscript(id)
    if (!created) throw new Error(`Failed to create microscript ${id}`)
    emitMicroscriptsChanged(id, 'created')
    return created
}

export function updateMicroscript(id: string, patch: UpdateMicroscriptInput): Microscript | null {
    const current = getMicroscript(id)
    if (!current) return null
    const parsed = UpdateMicroscriptInputSchema.parse(patch)
    const now = Date.now()

    const title = parsed.title ?? current.title
    const code = parsed.code ?? current.code
    const manifest = parsed.manifest
        ? normalizeManifestForCreate(parsed.manifest, now)
        : current.manifest
    const enabled = parsed.enabled ?? current.enabled
    const state = parsed.state ?? current.state
    const scheduleChanged = parsed.manifest !== undefined
    const enabledChanged = parsed.enabled !== undefined && parsed.enabled !== current.enabled

    let status: MicroscriptStatus = current.status
    let nextRunAt = current.nextRunAt
    if (!enabled) {
        status = 'paused'
        nextRunAt = null
    } else if (enabledChanged || scheduleChanged || current.status === 'paused' || current.status === 'completed' || current.status === 'expired') {
        status = 'active'
        nextRunAt = nextRunForSchedule(manifest.schedule, now)
    }

    db.prepare(
        `
        UPDATE microscripts
        SET title = @title, enabled = @enabled, status = @status,
            code = @code, codeHash = @codeHash, manifest = @manifest,
            state = @state, nextRunAt = @nextRunAt, updatedAt = @updatedAt
        WHERE id = @id
        `,
    ).run({
        id,
        title,
        enabled: enabled ? 1 : 0,
        status,
        code,
        codeHash: codeHash(code),
        manifest: serializeManifest(manifest),
        state: serializeState(state),
        nextRunAt,
        updatedAt: now,
    })

    recordMicroscriptEvent(id, 'updated', {
        codeChanged: parsed.code !== undefined,
        manifestChanged: parsed.manifest !== undefined,
        enabledChanged,
    })
    emitMicroscriptsChanged(id, 'updated')
    return getMicroscript(id)
}

export function deleteMicroscript(id: string): boolean {
    const result = db.prepare('DELETE FROM microscripts WHERE id = ?').run(id)
    const deleted = result.changes > 0
    if (deleted) emitMicroscriptsChanged(id, 'deleted')
    return deleted
}

export function setMicroscriptStatus(id: string, status: MicroscriptStatus, options: {
    enabled?: boolean
    nextRunAt?: number | null
    error?: string | null
    reason?: string
} = {}): Microscript | null {
    const current = getMicroscript(id)
    if (!current) return null
    const enabled = options.enabled ?? current.enabled
    db.prepare(
        `
        UPDATE microscripts
        SET status = @status, enabled = @enabled, nextRunAt = @nextRunAt,
            lastRunError = COALESCE(@error, lastRunError), updatedAt = @now
        WHERE id = @id
        `,
    ).run({
        id,
        status,
        enabled: enabled ? 1 : 0,
        nextRunAt: options.nextRunAt ?? null,
        error: options.error ?? null,
        now: Date.now(),
    })
    recordMicroscriptEvent(id, status, { reason: options.reason ?? null })
    emitMicroscriptsChanged(id, status)
    return getMicroscript(id)
}

export function listDueMicroscripts(now: number, limit = 10): Microscript[] {
    const rows = db
        .prepare(
            `
            SELECT * FROM microscripts
            WHERE enabled = 1
              AND status IN ('active', 'error')
              AND nextRunAt IS NOT NULL
              AND nextRunAt <= @now
            ORDER BY nextRunAt ASC, createdAt ASC
            LIMIT @limit
            `,
        )
        .all({ now, limit: Math.max(1, Math.min(50, Math.floor(limit))) }) as MicroscriptRow[]
    return rows.map(scriptFromRow)
}

export function claimMicroscriptForRun(id: string, now: number): Microscript | null {
    const tx = db.transaction((): Microscript | null => {
        const row = db
            .prepare('SELECT * FROM microscripts WHERE id = ?')
            .get(id) as MicroscriptRow | undefined
        if (!row) return null
        if (row.enabled !== 1 || !['active', 'error'].includes(row.status)) return null
        const script = scriptFromRow(row)
        if (script.nextRunAt == null || script.nextRunAt > now) return null
        db.prepare(
            `
            UPDATE microscripts
            SET status = 'running', nextRunAt = NULL, updatedAt = @now
            WHERE id = @id
            `,
        ).run({ id, now })
        return script
    })
    const claimed = tx()
    if (claimed) emitMicroscriptsChanged(id, 'running')
    return claimed
}

export interface FinishMicroscriptRunInput {
    ok: boolean
    trigger: 'schedule' | 'manual'
    startedAt: number
    summary: string
    error?: string | null
    state?: Record<string, unknown>
    status?: MicroscriptStatus
    enabled?: boolean
    nextRunAt?: number | null
    phases: number
    operations: number
    surfaced: boolean
    conversationId: string | null
}

export function finishMicroscriptRun(id: string, input: FinishMicroscriptRunInput): Microscript | null {
    const current = getMicroscript(id)
    if (!current) return null
    const now = Date.now()
    const nextFailures = input.ok ? 0 : current.consecutiveFailures + 1
    let nextStatus: MicroscriptStatus = input.status ?? (input.ok ? 'active' : 'error')
    let enabled = input.enabled ?? current.enabled
    let nextRunAt = input.nextRunAt ?? null

    if (!input.ok && nextFailures >= current.manifest.limits.maxConsecutiveFailures) {
        nextStatus = 'paused'
        enabled = false
        nextRunAt = null
    }
    if (input.ok && current.manifest.limits.maxRuns && current.runCount + 1 >= current.manifest.limits.maxRuns) {
        nextStatus = 'completed'
        enabled = false
        nextRunAt = null
    }

    const tx = db.transaction(() => {
        db.prepare(
            `
            UPDATE microscripts
            SET status = @status, enabled = @enabled, state = @state,
                nextRunAt = @nextRunAt, lastRunAt = @lastRunAt,
                lastRunStatus = @lastRunStatus, lastRunError = @lastRunError,
                runCount = runCount + 1, consecutiveFailures = @consecutiveFailures,
                updatedAt = @updatedAt
            WHERE id = @id
            `,
        ).run({
            id,
            status: nextStatus,
            enabled: enabled ? 1 : 0,
            state: serializeState(input.state ?? current.state),
            nextRunAt,
            lastRunAt: now,
            lastRunStatus: input.ok ? 'ok' : 'error',
            lastRunError: input.ok ? null : input.error ?? 'Unknown error',
            consecutiveFailures: nextFailures,
            updatedAt: now,
        })

        const runId = `msrun_${randomUUID()}`
        db.prepare(
            `
            INSERT INTO microscript_runs (
                id, scriptId, startedAt, endedAt, status, trigger, summary,
                error, phases, operations, surfaced, conversationId
            ) VALUES (
                @id, @scriptId, @startedAt, @endedAt, @status, @trigger, @summary,
                @error, @phases, @operations, @surfaced, @conversationId
            )
            `,
        ).run({
            id: runId,
            scriptId: id,
            startedAt: input.startedAt,
            endedAt: now,
            status: input.ok ? 'ok' : 'error',
            trigger: input.trigger,
            summary: input.summary.slice(0, 20_000),
            error: input.error ?? null,
            phases: input.phases,
            operations: input.operations,
            surfaced: input.surfaced ? 1 : 0,
            conversationId: input.conversationId,
        })
        recordMicroscriptEvent(id, input.ok ? 'run_ok' : 'run_error', {
            runId,
            trigger: input.trigger,
            summary: input.summary.slice(0, 1_000),
            error: input.error ?? null,
            nextRunAt,
            status: nextStatus,
        })
        emitMicroscriptRunsChanged(id, runId)
    })
    tx()
    emitMicroscriptsChanged(id, input.ok ? 'run-ok' : 'run-error')
    return getMicroscript(id)
}

export function recoverRunningMicroscripts(now = Date.now()): Microscript[] {
    const rows = db
        .prepare("SELECT * FROM microscripts WHERE status = 'running'")
        .all() as MicroscriptRow[]
    const recovered: Microscript[] = []
    for (const row of rows) {
        const script = scriptFromRow(row)
        const nextRunAt = script.enabled ? nextRunForSchedule(script.manifest.schedule, now) : null
        db.prepare(
            `
            UPDATE microscripts
            SET status = @status, nextRunAt = @nextRunAt,
                lastRunStatus = 'error', lastRunError = @error, updatedAt = @now
            WHERE id = @id
            `,
        ).run({
            id: script.id,
            status: script.enabled ? 'error' : 'paused',
            nextRunAt,
            error: 'Interrupted by process restart.',
            now,
        })
        recordMicroscriptEvent(script.id, 'recovered', { reason: 'Interrupted by process restart.', nextRunAt })
        recovered.push(script)
    }
    if (recovered.length > 0) emitMicroscriptsChanged(undefined, 'recovered')
    return recovered
}

export function expireDueMicroscripts(now = Date.now()): Microscript[] {
    const rows = db
        .prepare("SELECT * FROM microscripts WHERE enabled = 1 AND status IN ('active', 'error') AND manifest LIKE '%expiresAt%'")
        .all() as MicroscriptRow[]
    const expired: Microscript[] = []
    for (const row of rows) {
        const script = scriptFromRow(row)
        const expiresAt = script.manifest.stop.expiresAt
        if (expiresAt === null || expiresAt > now) continue
        db.prepare(
            `
            UPDATE microscripts
            SET enabled = 0, status = 'expired', nextRunAt = NULL, updatedAt = @now
            WHERE id = @id
            `,
        ).run({ id: script.id, now })
        recordMicroscriptEvent(script.id, 'expired', { expiresAt })
        expired.push(script)
    }
    if (expired.length > 0) emitMicroscriptsChanged(undefined, 'expired')
    return expired
}

export function computeDefaultNextRun(script: Microscript, now: number): number | null {
    return nextRunForSchedule(script.manifest.schedule, now)
}

export function recordMicroscriptEvent(
    scriptId: string,
    kind: string,
    payload: Record<string, unknown> | null = null,
): MicroscriptEvent {
    const id = `mse_${randomUUID()}`
    const ts = Date.now()
    db.prepare(
        `
        INSERT INTO microscript_events (id, scriptId, ts, kind, payload)
        VALUES (@id, @scriptId, @ts, @kind, @payload)
        `,
    ).run({
        id,
        scriptId,
        ts,
        kind,
        payload: payload ? JSON.stringify(payload) : null,
    })

    db.prepare(
        `
        DELETE FROM microscript_events
        WHERE scriptId = @scriptId
          AND id NOT IN (
            SELECT id FROM microscript_events
            WHERE scriptId = @scriptId
            ORDER BY ts DESC, id DESC
            LIMIT @limit
          )
        `,
    ).run({ scriptId, limit: MAX_EVENTS_PER_SCRIPT })

    return { id, scriptId, ts, kind, payload }
}

export function listMicroscriptEvents(scriptId: string, limit = 100): MicroscriptEvent[] {
    const rows = db
        .prepare(
            `
            SELECT * FROM microscript_events
            WHERE scriptId = ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
            `,
        )
        .all(scriptId, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
            id: string
            scriptId: string
            ts: number
            kind: string
            payload: string | null
        }>
    return rows.map(eventFromRow)
}

export function listMicroscriptRuns(scriptId: string, limit = 50): MicroscriptRunRecord[] {
    const rows = db
        .prepare(
            `
            SELECT * FROM microscript_runs
            WHERE scriptId = ?
            ORDER BY startedAt DESC, id DESC
            LIMIT ?
            `,
        )
        .all(scriptId, Math.max(1, Math.min(200, Math.floor(limit)))) as MicroscriptRunRow[]
    return rows.map(runFromRow)
}

export function getMicroscriptRun(runId: string): MicroscriptRunRecord | null {
    const row = db
        .prepare('SELECT * FROM microscript_runs WHERE id = ?')
        .get(runId) as MicroscriptRunRow | undefined
    return row ? runFromRow(row) : null
}
