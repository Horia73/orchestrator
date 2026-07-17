import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

import { durableAiWorkerId } from '@/lib/ai/worker-generations'
import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

const HEARTBEAT_MS = 10_000
const OWNER_STALE_MS = 90_000
const POLL_MS = 100

interface FleetLimits {
    total: number
    main: number
    provider: number
}

interface FleetAcquireOptions {
    topLevel: boolean
    provider?: string
    limits: FleetLimits
    onQueued?: () => void
}

export interface FleetRunPermit {
    releaseForChildren(): void
    reacquireForResume(): Promise<void>
    dispose(): void
}

interface FleetState {
    db: Database.Database | null
    ownerId: string
    heartbeat: ReturnType<typeof setInterval> | null
    exitHookInstalled: boolean
}

const globalForFleet = globalThis as unknown as {
    __orchestratorFleetConcurrency?: FleetState
}

const state = globalForFleet.__orchestratorFleetConcurrency ?? {
    db: null,
    ownerId: `${durableAiWorkerId() ?? 'worker'}-${process.pid}-${randomUUID()}`,
    heartbeat: null,
    exitHookInstalled: false,
}
if (!globalForFleet.__orchestratorFleetConcurrency) {
    globalForFleet.__orchestratorFleetConcurrency = state
}

/** Cross-process companion to the in-memory priority gate. It is enabled only
 * for generation-aware durable workers. SQLite BEGIN IMMEDIATE makes capacity
 * checks + lease insertion atomic across blue and green, so overlap cannot
 * double RAM or provider limits. */
export async function acquireFleetRun(opts: FleetAcquireOptions): Promise<FleetRunPermit> {
    if (!fleetGateEnabled()) return noopPermit()
    const db = fleetDb()
    const leaseId = randomUUID()
    let queued = false
    const notifyQueued = () => {
        if (queued) return
        queued = true
        try {
            opts.onQueued?.()
        } catch {
            // UI observers never own admission correctness.
        }
    }

    while (!tryAcquire(db, leaseId, opts, true)) {
        notifyQueued()
        await delay(POLL_MS)
    }

    let disposed = false
    let holdsTotalAndProvider = true
    return {
        releaseForChildren() {
            if (disposed || !holdsTotalAndProvider) return
            holdsTotalAndProvider = false
            db.prepare(`UPDATE leases SET holdsTotal = 0, provider = NULL WHERE id = ? AND ownerId = ?`)
                .run(leaseId, state.ownerId)
        },
        async reacquireForResume() {
            if (disposed || holdsTotalAndProvider) return
            while (!tryAcquire(db, leaseId, opts, false)) {
                notifyQueued()
                await delay(POLL_MS)
            }
            holdsTotalAndProvider = true
        },
        dispose() {
            if (disposed) return
            disposed = true
            db.prepare(`DELETE FROM leases WHERE id = ? AND ownerId = ?`).run(leaseId, state.ownerId)
        },
    }
}

export function getFleetConcurrencyStats(): {
    enabled: boolean
    totalActive: number
    mainActive: number
    providers: Record<string, number>
} {
    if (!fleetGateEnabled()) return { enabled: false, totalActive: 0, mainActive: 0, providers: {} }
    const db = fleetDb()
    reapStaleOwners(db)
    const row = db.prepare(`
        SELECT
            COALESCE(SUM(holdsTotal), 0) AS totalActive,
            COALESCE(SUM(holdsMain), 0) AS mainActive
        FROM leases
    `).get() as { totalActive: number; mainActive: number }
    const providers: Record<string, number> = {}
    for (const provider of db.prepare(`
        SELECT provider, COUNT(*) AS active
        FROM leases
        WHERE provider IS NOT NULL
        GROUP BY provider
    `).all() as Array<{ provider: string; active: number }>) {
        providers[provider.provider] = provider.active
    }
    return {
        enabled: true,
        totalActive: row.totalActive,
        mainActive: row.mainActive,
        providers,
    }
}

function fleetGateEnabled(): boolean {
    return process.env.ORCHESTRATOR_AI_WORKER_PROCESS === '1' && durableAiWorkerId() !== null
}

function fleetDb(): Database.Database {
    if (state.db) return state.db
    const configured = process.env.ORCHESTRATOR_AI_FLEET_GATE_PATH?.trim()
    const dbPath = configured
        ? path.resolve(configured)
        : path.join(ORCHESTRATOR_STATE_DIR, 'runtime', 'ai-fleet-concurrency.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { timeout: 10_000 })
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 10000')
    db.pragma('foreign_keys = ON')
    db.exec(`
        CREATE TABLE IF NOT EXISTS owners (
            id TEXT PRIMARY KEY,
            workerId TEXT NOT NULL,
            pid INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leases (
            id TEXT PRIMARY KEY,
            ownerId TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
            holdsTotal INTEGER NOT NULL,
            holdsMain INTEGER NOT NULL,
            provider TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fleet_leases_owner ON leases(ownerId);
        CREATE INDEX IF NOT EXISTS idx_fleet_leases_provider ON leases(provider);
    `)
    state.db = db
    heartbeat(db)
    state.heartbeat = setInterval(() => heartbeat(db), HEARTBEAT_MS)
    state.heartbeat.unref?.()
    if (!state.exitHookInstalled) {
        state.exitHookInstalled = true
        process.once('exit', () => {
            try {
                state.db?.prepare(`DELETE FROM owners WHERE id = ?`).run(state.ownerId)
            } catch {
                // Process teardown is best-effort; stale-owner reaping is the backstop.
            }
        })
    }
    return db
}

function heartbeat(db: Database.Database): void {
    const now = Date.now()
    db.prepare(`
        INSERT INTO owners (id, workerId, pid, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt
    `).run(state.ownerId, durableAiWorkerId() ?? 'worker', process.pid, now)
    reapStaleOwners(db, now)
}

function reapStaleOwners(db: Database.Database, now = Date.now()): void {
    db.prepare(`DELETE FROM owners WHERE updatedAt < ?`).run(now - OWNER_STALE_MS)
}

function tryAcquire(
    db: Database.Database,
    leaseId: string,
    opts: FleetAcquireOptions,
    insert: boolean,
): boolean {
    const provider = opts.provider?.trim().toLowerCase() || null
    const transaction = db.transaction(() => {
        heartbeat(db)
        const totals = db.prepare(`
            SELECT
                COALESCE(SUM(holdsTotal), 0) AS totalActive,
                COALESCE(SUM(holdsMain), 0) AS mainActive
            FROM leases
            WHERE id != ?
        `).get(leaseId) as { totalActive: number; mainActive: number }
        if (totals.totalActive >= opts.limits.total) return false
        if (opts.topLevel && totals.mainActive >= opts.limits.main) return false
        if (provider) {
            const providerRow = db.prepare(`
                SELECT COUNT(*) AS active FROM leases WHERE id != ? AND provider = ?
            `).get(leaseId, provider) as { active: number }
            if (providerRow.active >= opts.limits.provider) return false
        }
        if (insert) {
            db.prepare(`
                INSERT INTO leases (id, ownerId, holdsTotal, holdsMain, provider)
                VALUES (?, ?, 1, ?, ?)
            `).run(leaseId, state.ownerId, opts.topLevel ? 1 : 0, provider)
        } else {
            const result = db.prepare(`
                UPDATE leases SET holdsTotal = 1, provider = ?
                WHERE id = ? AND ownerId = ?
            `).run(provider, leaseId, state.ownerId)
            if (result.changes !== 1) return false
        }
        return true
    })
    try {
        return transaction()
    } catch (error) {
        console.warn('[fleet-concurrency] lease transaction failed; retrying', error)
        return false
    }
}

function noopPermit(): FleetRunPermit {
    return {
        releaseForChildren() {},
        async reacquireForResume() {},
        dispose() {},
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
