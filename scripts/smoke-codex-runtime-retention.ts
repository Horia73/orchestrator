import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

import Database from 'better-sqlite3'

import {
    auditCodexRuntime,
    maintainCodexRuntime,
} from '@/lib/storage/codex-runtime-retention'

const DAY_MS = 86_400_000
const now = Date.UTC(2026, 6, 10, 12)
const oldSeconds = Math.floor((now - 45 * DAY_MS) / 1000)
const recentSeconds = Math.floor((now - 2 * DAY_MS) / 1000)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-retention-smoke-'))
const stateDir = path.join(sandbox, 'state')
const codexHome = path.join(sandbox, 'codex-home')
const appDbPath = path.join(stateDir, 'data.db')
const stateDbPath = path.join(codexHome, 'state_5.sqlite')

try {
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    createAppDatabase()
    createCodexStateDatabase()

    const oldOrphan = addThread('old-orphan', oldSeconds)
    const compressedOrphan = addThread('compressed-orphan', oldSeconds, { compressed: true })
    addThread('referenced', oldSeconds)
    addThread('recent-orphan', recentSeconds)
    addThread('protected-parent', oldSeconds)
    addThread('referenced-child', oldSeconds)
    const safeParent = addThread('safe-parent', oldSeconds)
    const safeChild = addThread('safe-child', oldSeconds)
    addMissingThread('missing-rollout', oldSeconds)
    addEdge('protected-parent', 'referenced-child')
    addEdge('safe-parent', 'safe-child')
    addReference('appserver:referenced')
    addReference('appserver:referenced-child', 'agent_threads')

    const audit = auditCodexRuntime({
        stateDir,
        codexHome,
        appDbPaths: [appDbPath],
        now,
        retentionDays: 30,
    })
    assert.deepEqual(audit.errors, [])
    assert.equal(audit.totalThreads, 9)
    assert.equal(audit.referencedThreads, 2)
    assert.equal(audit.recentThreads, 1)
    assert.equal(audit.missingRollouts, 1)
    assert.equal(audit.protectedParents, 1)
    assert.deepEqual(new Set(audit.candidates.map(candidate => candidate.id)), new Set([
        'old-orphan',
        'compressed-orphan',
        'safe-parent',
        'safe-child',
    ]))
    assert.equal(
        audit.candidateBytes,
        oldOrphan.bytes + compressedOrphan.bytes + safeParent.bytes + safeChild.bytes
    )
    assert.equal(audit.candidates.find(candidate => candidate.id === 'safe-parent')?.descendantCount, 1)
    assert.ok(audit.candidates.find(candidate => candidate.id === 'compressed-orphan')?.rolloutPath.endsWith('.zst'))

    const requestedDeletes: string[] = []
    const applied = await maintainCodexRuntime({
        stateDir,
        codexHome,
        appDbPaths: [appDbPath],
        now,
        retentionDays: 30,
        deleteLimit: 10,
        apply: true,
        vacuumLogs: false,
        skipProcessCheck: true,
        deleteThreads: async ids => {
            requestedDeletes.push(...ids)
            return ids.map(id => ({ id, ok: true }))
        },
    })
    assert.equal(applied.skippedReason, null)
    assert.equal(applied.deletedThreads, 3)
    assert.equal(
        applied.reclaimedSessionBytes,
        oldOrphan.bytes + compressedOrphan.bytes + safeChild.bytes
    )
    assert.deepEqual(
        new Set(requestedDeletes),
        new Set(['old-orphan', 'compressed-orphan', 'safe-child'])
    )
    assert.ok(!requestedDeletes.includes('safe-parent'), 'parents are deferred until descendants are gone')
    assert.ok(!requestedDeletes.includes('referenced'))
    assert.ok(!requestedDeletes.includes('referenced-child'))
    assert.ok(!requestedDeletes.includes('protected-parent'))

    const firstLock = await import('@/lib/cli/codex-env').then(module =>
        module.acquireCodexRuntimeMaintenanceLock(Date.now(), codexHome)
    )
    assert.ok(firstLock)
    try {
        const locked = await maintainCodexRuntime({
            stateDir,
            codexHome,
            appDbPaths: [appDbPath],
            now,
            retentionDays: 30,
            apply: true,
            vacuumLogs: false,
            skipProcessCheck: true,
            deleteThreads: async () => {
                throw new Error('must not run while locked')
            },
        })
        assert.equal(locked.skippedReason, 'maintenance-lock-held')
    } finally {
        firstLock?.()
    }

    createFragmentedLogsDatabase()
    const logsBefore = fs.statSync(path.join(codexHome, 'logs_2.sqlite')).size
    const vacuumed = await maintainCodexRuntime({
        stateDir,
        codexHome,
        appDbPaths: [appDbPath],
        now,
        retentionDays: 0,
        apply: true,
        vacuumLogs: true,
        logVacuumMinBytes: 1,
        logVacuumMinRatio: 0.01,
        skipProcessCheck: true,
    })
    assert.equal(vacuumed.logsVacuumed, true)
    assert.ok(vacuumed.reclaimedLogBytes > 0)
    assert.ok(vacuumed.logsAfter.fileBytes < logsBefore)
    assert.equal(vacuumed.logsAfter.autoVacuum, 2)

    console.log('Codex runtime retention smoke tests passed')
} finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
}

function createAppDatabase(): void {
    const db = new Database(appDbPath)
    try {
        for (const table of ['conversations', 'agent_threads']) {
            db.exec(`
                CREATE TABLE ${table} (
                    lastInteractionProvider TEXT,
                    lastInteractionId TEXT
                )
            `)
        }
    } finally {
        db.close()
    }
}

function createCodexStateDatabase(): void {
    const db = new Database(stateDbPath)
    try {
        db.exec(`
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                updated_at_ms INTEGER,
                archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE thread_spawn_edges (
                parent_thread_id TEXT NOT NULL,
                child_thread_id TEXT NOT NULL
            );
        `)
    } finally {
        db.close()
    }
}

function addThread(
    id: string,
    updatedAtSeconds: number,
    options: { compressed?: boolean } = {}
): { path: string; bytes: number } {
    const storedPath = path.join(codexHome, 'sessions', `${id}.jsonl`)
    const filePath = options.compressed ? `${storedPath}.zst` : storedPath
    const content = Buffer.from(`${id}\n`.repeat(20))
    fs.writeFileSync(filePath, content)
    const time = new Date(updatedAtSeconds * 1000)
    fs.utimesSync(filePath, time, time)
    const db = new Database(stateDbPath)
    try {
        db.prepare(`
            INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, archived)
            VALUES (?, ?, ?, NULL, 0)
        `).run(id, storedPath, updatedAtSeconds)
    } finally {
        db.close()
    }
    return { path: filePath, bytes: content.length }
}

function addMissingThread(id: string, updatedAtSeconds: number): void {
    const db = new Database(stateDbPath)
    try {
        db.prepare(`
            INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, archived)
            VALUES (?, ?, ?, NULL, 0)
        `).run(id, path.join(codexHome, 'sessions', `${id}.jsonl`), updatedAtSeconds)
    } finally {
        db.close()
    }
}

function addEdge(parent: string, child: string): void {
    const db = new Database(stateDbPath)
    try {
        db.prepare(`
            INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id)
            VALUES (?, ?)
        `).run(parent, child)
    } finally {
        db.close()
    }
}

function addReference(id: string, table = 'conversations'): void {
    const db = new Database(appDbPath)
    try {
        db.prepare(`
            INSERT INTO ${table} (lastInteractionProvider, lastInteractionId)
            VALUES ('codex', ?)
        `).run(id)
    } finally {
        db.close()
    }
}

function createFragmentedLogsDatabase(): void {
    const db = new Database(path.join(codexHome, 'logs_2.sqlite'))
    try {
        db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, payload BLOB)')
        const insert = db.prepare('INSERT INTO logs (payload) VALUES (?)')
        const transaction = db.transaction(() => {
            for (let index = 0; index < 64; index += 1) insert.run(Buffer.alloc(64 * 1024, index))
        })
        transaction()
        db.exec('DELETE FROM logs WHERE id <= 60')
    } finally {
        db.close()
    }
}
