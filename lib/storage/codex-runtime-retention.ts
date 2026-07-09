import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import Database from 'better-sqlite3'

import {
    acquireCodexRuntimeMaintenanceLock,
    codexMaintenanceCliEnv,
    codexRuntimeCodexHome,
} from '@/lib/cli/codex-env'
import { resolveBin } from '@/lib/cli/resolve-bin'
import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

const DAY_MS = 86_400_000
const APP_SERVER_PREFIX = 'appserver:'
const DEFAULT_SESSION_RETENTION_DAYS = 30
const DEFAULT_DELETE_LIMIT = 200
const DEFAULT_LOG_VACUUM_MIN_BYTES = 256 * 1024 * 1024
const DEFAULT_LOG_VACUUM_MIN_RATIO = 0.2
const REQUEST_TIMEOUT_MS = 30_000

export interface CodexSessionCandidate {
    id: string
    rolloutPath: string
    bytes: number
    updatedAt: number
    archived: boolean
    depth: number
    descendantCount: number
}

export interface CodexLogDatabaseStats {
    path: string
    exists: boolean
    fileBytes: number
    pageBytes: number
    freeBytes: number
    freeRatio: number
    autoVacuum: number | null
}

export interface CodexRuntimeAudit {
    codexHome: string
    retentionDays: number
    totalThreads: number
    referencedThreads: number
    recentThreads: number
    missingRollouts: number
    protectedParents: number
    candidateBytes: number
    candidates: CodexSessionCandidate[]
    logs: CodexLogDatabaseStats
    errors: string[]
}

export interface CodexThreadDeleteResult {
    id: string
    ok: boolean
    error?: string
}

export interface CodexRuntimeMaintenanceResult {
    applied: boolean
    audit: CodexRuntimeAudit
    skippedReason: string | null
    deletedThreads: number
    reclaimedSessionBytes: number
    deleteResults: CodexThreadDeleteResult[]
    logsVacuumed: boolean
    logsVacuumError: string | null
    reclaimedLogBytes: number
    logsAfter: CodexLogDatabaseStats
}

interface ThreadRow {
    id: string
    rolloutPath: string
    updatedAt: number
    archived: number
}

interface EdgeRow {
    parentThreadId: string
    childThreadId: string
}

export interface MaintainCodexRuntimeOptions {
    stateDir?: string
    codexHome?: string
    appDbPaths?: string[]
    now?: number
    retentionDays?: number
    deleteLimit?: number
    apply?: boolean
    vacuumLogs?: boolean
    logVacuumMinBytes?: number
    logVacuumMinRatio?: number
    skipProcessCheck?: boolean
    deleteThreads?: (ids: string[]) => Promise<CodexThreadDeleteResult[]>
}

export function getCodexSessionRetentionDays(): number {
    return envInteger(
        'ORCHESTRATOR_CODEX_SESSION_RETENTION_DAYS',
        DEFAULT_SESSION_RETENTION_DAYS,
        0,
        3650
    )
}

export function getCodexSessionDeleteLimit(): number {
    return envInteger(
        'ORCHESTRATOR_CODEX_SESSION_DELETE_LIMIT',
        DEFAULT_DELETE_LIMIT,
        1,
        5000
    )
}

export function auditCodexRuntime(options: MaintainCodexRuntimeOptions = {}): CodexRuntimeAudit {
    const stateDir = options.stateDir ?? ORCHESTRATOR_STATE_DIR
    const codexHome = options.codexHome ?? codexRuntimeCodexHome()
    const retentionDays = options.retentionDays ?? getCodexSessionRetentionDays()
    const now = options.now ?? Date.now()
    const errors: string[] = []
    const logs = inspectCodexLogs(codexHome)
    const empty: CodexRuntimeAudit = {
        codexHome,
        retentionDays,
        totalThreads: 0,
        referencedThreads: 0,
        recentThreads: 0,
        missingRollouts: 0,
        protectedParents: 0,
        candidateBytes: 0,
        candidates: [],
        logs,
        errors,
    }
    if (retentionDays <= 0) return empty

    const references = collectCodexReferences(
        options.appDbPaths ?? listAppDatabasePaths(stateDir),
        errors
    )
    if (errors.length > 0) return empty

    const stateDbPath = path.join(codexHome, 'state_5.sqlite')
    if (!fs.existsSync(stateDbPath)) return empty

    let db: Database.Database | null = null
    try {
        db = new Database(stateDbPath, { readonly: true, fileMustExist: true, timeout: 10_000 })
        db.pragma('query_only = ON')
        const threads = db.prepare(`
            SELECT id,
                   rollout_path AS rolloutPath,
                   COALESCE(updated_at_ms, updated_at * 1000) AS updatedAt,
                   archived
            FROM threads
        `).all() as ThreadRow[]
        const edges = tableExists(db, 'thread_spawn_edges')
            ? db.prepare(`
                SELECT parent_thread_id AS parentThreadId,
                       child_thread_id AS childThreadId
                FROM thread_spawn_edges
            `).all() as EdgeRow[]
            : []

        const cutoff = now - retentionDays * DAY_MS
        const children = new Map<string, string[]>()
        const parent = new Map<string, string>()
        for (const edge of edges) {
            const list = children.get(edge.parentThreadId) ?? []
            list.push(edge.childThreadId)
            children.set(edge.parentThreadId, list)
            parent.set(edge.childThreadId, edge.parentThreadId)
        }

        const baseCandidates = new Map<string, CodexSessionCandidate>()
        let referencedThreads = 0
        let recentThreads = 0
        let missingRollouts = 0
        for (const thread of threads) {
            const rollout = resolveRolloutPath(codexHome, thread.rolloutPath)
            if (!rollout) {
                missingRollouts += 1
                continue
            }
            const stat = fs.statSync(rollout)
            const updatedAt = Math.max(Number(thread.updatedAt) || 0, stat.mtimeMs)
            if (references.has(thread.id)) {
                referencedThreads += 1
                continue
            }
            if (updatedAt >= cutoff) {
                recentThreads += 1
                continue
            }
            baseCandidates.set(thread.id, {
                id: thread.id,
                rolloutPath: rollout,
                bytes: stat.size,
                updatedAt,
                archived: thread.archived === 1,
                depth: threadDepth(thread.id, parent),
                descendantCount: 0,
            })
        }

        // thread/delete recursively deletes descendants. A parent is eligible
        // only when every persisted descendant is eligible too; otherwise a
        // referenced/recent child would be removed indirectly.
        let protectedParents = 0
        const candidates = [...baseCandidates.values()].filter(candidate => {
            const descendants = collectDescendants(candidate.id, children)
            candidate.descendantCount = descendants.length
            const safe = descendants.every(id => baseCandidates.has(id))
            if (!safe) protectedParents += 1
            return safe
        })
        candidates.sort((a, b) => b.depth - a.depth || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))

        return {
            codexHome,
            retentionDays,
            totalThreads: threads.length,
            referencedThreads,
            recentThreads,
            missingRollouts,
            protectedParents,
            candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
            candidates,
            logs,
            errors,
        }
    } catch (error) {
        errors.push(`Codex state audit failed: ${error instanceof Error ? error.message : String(error)}`)
        return { ...empty, errors }
    } finally {
        db?.close()
    }
}

export async function maintainCodexRuntime(
    options: MaintainCodexRuntimeOptions = {}
): Promise<CodexRuntimeMaintenanceResult> {
    let audit = auditCodexRuntime(options)
    const base: CodexRuntimeMaintenanceResult = {
        applied: options.apply === true,
        audit,
        skippedReason: null,
        deletedThreads: 0,
        reclaimedSessionBytes: 0,
        deleteResults: [],
        logsVacuumed: false,
        logsVacuumError: null,
        reclaimedLogBytes: 0,
        logsAfter: audit.logs,
    }
    if (!options.apply) return base
    if (audit.errors.length > 0) return { ...base, skippedReason: 'audit-failed' }

    // Lock age is wall-clock state and must not follow an audit's simulated
    // --now value, otherwise a historical/future dry-run timestamp could age
    // out a live maintenance lock.
    const releaseLock = acquireCodexRuntimeMaintenanceLock(Date.now(), audit.codexHome)
    if (!releaseLock) return { ...base, skippedReason: 'maintenance-lock-held' }
    try {
        if (!options.skipProcessCheck && activeCodexAppServerProcesses(audit.codexHome).length > 0) {
            return { ...base, skippedReason: 'codex-app-server-active' }
        }

        // Re-read references after taking the launch lock so a just-completed
        // turn cannot become an unobserved reference between audit and delete.
        audit = auditCodexRuntime(options)
        base.audit = audit
        base.logsAfter = audit.logs
        if (audit.errors.length > 0) return { ...base, skippedReason: 'audit-failed' }

        const limit = options.deleteLimit ?? getCodexSessionDeleteLimit()
        const selected = selectCodexDeleteCandidates(audit, limit)
        if (selected.length > 0) {
            const deleteThreads = options.deleteThreads
                ?? (ids => deleteCodexThreadsViaAppServer(ids, audit.codexHome))
            let deleteResults: CodexThreadDeleteResult[]
            try {
                deleteResults = await deleteThreads(selected.map(candidate => candidate.id))
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                deleteResults = selected.map(candidate => ({
                    id: candidate.id,
                    ok: false,
                    error: detail,
                }))
            }
            base.deleteResults = deleteResults
            const successful = new Set(deleteResults.filter(result => result.ok).map(result => result.id))
            base.deletedThreads = successful.size
            base.reclaimedSessionBytes = selected
                .filter(candidate => successful.has(candidate.id))
                .reduce((sum, candidate) => sum + candidate.bytes, 0)
        }

        const shouldVacuum = options.vacuumLogs !== false
        if (shouldVacuum) {
            const before = inspectCodexLogs(audit.codexHome)
            try {
                base.logsVacuumed = vacuumCodexLogs({
                    stats: before,
                    minBytes: options.logVacuumMinBytes ?? DEFAULT_LOG_VACUUM_MIN_BYTES,
                    minRatio: options.logVacuumMinRatio ?? DEFAULT_LOG_VACUUM_MIN_RATIO,
                })
            } catch (error) {
                base.logsVacuumError = error instanceof Error ? error.message : String(error)
            }
            base.logsAfter = inspectCodexLogs(audit.codexHome)
            base.reclaimedLogBytes = Math.max(0, before.fileBytes - base.logsAfter.fileBytes)
        }
        return base
    } finally {
        releaseLock()
    }
}

export function inspectCodexLogs(codexHome = codexRuntimeCodexHome()): CodexLogDatabaseStats {
    const dbPath = path.join(codexHome, 'logs_2.sqlite')
    const missing: CodexLogDatabaseStats = {
        path: dbPath,
        exists: false,
        fileBytes: 0,
        pageBytes: 0,
        freeBytes: 0,
        freeRatio: 0,
        autoVacuum: null,
    }
    if (!fs.existsSync(dbPath)) return missing

    let db: Database.Database | null = null
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 })
        const pageCount = Number(db.pragma('page_count', { simple: true }))
        const freePages = Number(db.pragma('freelist_count', { simple: true }))
        const pageSize = Number(db.pragma('page_size', { simple: true }))
        const pageBytes = pageCount * pageSize
        const freeBytes = freePages * pageSize
        return {
            path: dbPath,
            exists: true,
            fileBytes: fs.statSync(dbPath).size,
            pageBytes,
            freeBytes,
            freeRatio: pageBytes > 0 ? freeBytes / pageBytes : 0,
            autoVacuum: Number(db.pragma('auto_vacuum', { simple: true })),
        }
    } catch {
        return { ...missing, exists: true, fileBytes: fs.statSync(dbPath).size }
    } finally {
        db?.close()
    }
}

function vacuumCodexLogs(input: {
    stats: CodexLogDatabaseStats
    minBytes: number
    minRatio: number
}): boolean {
    const { stats } = input
    if (
        !stats.exists
        || stats.freeBytes < input.minBytes
        || stats.freeRatio < input.minRatio
    ) return false

    const fsStats = fs.statfsSync(path.dirname(stats.path))
    const availableBytes = Number(fsStats.bavail) * Number(fsStats.bsize)
    const requiredBytes = Math.ceil(stats.fileBytes * 1.25) + 128 * 1024 * 1024
    if (availableBytes < requiredBytes) return false

    const db = new Database(stats.path, { timeout: 60_000 })
    try {
        db.pragma('busy_timeout = 60000')
        db.pragma('wal_checkpoint(TRUNCATE)')
        if (stats.autoVacuum === 2) {
            db.exec('PRAGMA incremental_vacuum')
        } else {
            db.exec('PRAGMA auto_vacuum = INCREMENTAL')
            db.exec('VACUUM')
        }
        return true
    } finally {
        db.close()
    }
}

export function selectCodexDeleteCandidates(
    audit: CodexRuntimeAudit,
    limit = getCodexSessionDeleteLimit()
): CodexSessionCandidate[] {
    // Deleting a Codex parent recursively deletes its descendants. Only direct
    // leaves are removed in a pass, so the configured limit is a real upper
    // bound on deleted threads rather than merely on API calls. Their now-leaf
    // parents can be collected by a later daily pass.
    return audit.candidates
        .filter(candidate => candidate.descendantCount === 0)
        .slice(0, Math.max(0, limit))
}

export function activeCodexAppServerProcesses(
    codexHome = codexRuntimeCodexHome()
): number[] {
    if (process.platform === 'linux' && fs.existsSync('/proc')) {
        const pids: number[] = []
        for (const name of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue
            const pid = Number(name)
            if (pid === process.pid) continue
            try {
                const command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf-8').replaceAll('\0', ' ')
                if (!/\bcodex\b/.test(command) || !/\bapp-server\b/.test(command)) continue
                if (processUsesDifferentCodexHome(`/proc/${name}/environ`, codexHome)) continue
                pids.push(pid)
            } catch {
                // Process exited between directory listing and cmdline read.
            }
        }
        return pids
    }

    const ps = spawnSync('ps', ['eww', '-axo', 'pid=,command='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (ps.status !== 0) return []
    return ps.stdout.split(/\r?\n/).flatMap(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        if (!match || !/\bcodex\b/.test(match[2]) || !/\bapp-server\b/.test(match[2])) return []
        if (commandUsesDifferentCodexHome(match[2], codexHome)) return []
        const pid = Number(match[1])
        return pid === process.pid ? [] : [pid]
    })
}

async function deleteCodexThreadsViaAppServer(
    ids: string[],
    codexHome: string
): Promise<CodexThreadDeleteResult[]> {
    if (ids.length === 0) return []
    const bin = resolveBin('codex')
    if (bin === 'codex') {
        return ids.map(id => ({ id, ok: false, error: 'Codex CLI is not installed.' }))
    }

    const proc = spawn(bin, [
        'app-server',
        '--listen', 'stdio://',
        '-c', 'features.multi_agent=false',
        '-c', 'features.apps=false',
        '-c', 'features.plugins=false',
        '-c', 'features.skills=false',
    ], {
        cwd: process.cwd(),
        env: codexMaintenanceCliEnv({ DISABLE_TELEMETRY: '1' }, codexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
    })

    let nextId = 1
    let stdoutBuffer = ''
    let stderrTail = ''
    let exited = false
    const pending = new Map<number, {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
    }>()

    const failPending = (error: Error) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer)
            request.reject(error)
        }
        pending.clear()
    }
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (exited || !proc.stdin || proc.stdin.destroyed) {
            return Promise.reject(new Error('Codex app-server is not available.'))
        }
        const id = nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id)
                reject(new Error(`${method} timed out.`))
            }, REQUEST_TIMEOUT_MS)
            pending.set(id, { resolve, reject, timer })
            proc.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
        })
    }

    proc.stdout?.setEncoding('utf-8')
    proc.stderr?.setEncoding('utf-8')
    proc.stdout?.on('data', chunk => {
        stdoutBuffer += chunk.toString()
        for (;;) {
            const newline = stdoutBuffer.indexOf('\n')
            if (newline < 0) break
            const line = stdoutBuffer.slice(0, newline).trim()
            stdoutBuffer = stdoutBuffer.slice(newline + 1)
            if (!line.startsWith('{')) continue
            let message: Record<string, unknown>
            try {
                message = JSON.parse(line) as Record<string, unknown>
            } catch {
                continue
            }
            if (typeof message.id !== 'number') continue
            const waiting = pending.get(message.id)
            if (!waiting) continue
            pending.delete(message.id)
            clearTimeout(waiting.timer)
            if (message.error && typeof message.error === 'object') {
                const detail = message.error as Record<string, unknown>
                waiting.reject(new Error(typeof detail.message === 'string' ? detail.message : 'Codex request failed.'))
            } else {
                waiting.resolve(message.result)
            }
        }
    })
    proc.stderr?.on('data', chunk => {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000)
    })
    proc.once('error', error => {
        exited = true
        failPending(error)
    })
    proc.once('exit', code => {
        exited = true
        failPending(new Error(`Codex app-server exited with ${code ?? 'unknown'}${stderrTail ? `: ${stderrTail.trim()}` : ''}`))
    })

    const results: CodexThreadDeleteResult[] = []
    try {
        await request('initialize', {
            clientInfo: { name: 'orchestrator-maintenance', title: 'Orchestrator maintenance', version: '0.0.1' },
            capabilities: { experimentalApi: true },
        })
        for (const id of ids) {
            try {
                await request('thread/delete', { threadId: id })
                results.push({ id, ok: true })
            } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        for (const id of ids) results.push({ id, ok: false, error: detail })
    } finally {
        proc.stdin?.end()
        if (!exited) {
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => {
                    try { proc.kill('SIGTERM') } catch { /* already gone */ }
                    resolve()
                }, 1500)
                proc.once('exit', () => {
                    clearTimeout(timer)
                    resolve()
                })
            })
        }
    }
    return dedupeDeleteResults(results, ids)
}

function collectCodexReferences(dbPaths: string[], errors: string[]): Set<string> {
    const references = new Set<string>()
    for (const dbPath of dbPaths) {
        let db: Database.Database | null = null
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 })
            db.pragma('query_only = ON')
            for (const table of ['conversations', 'agent_threads']) {
                if (!tableExists(db, table)) continue
                const rows = db.prepare(`
                    SELECT lastInteractionId AS id
                    FROM ${table}
                    WHERE lastInteractionId IS NOT NULL
                      AND (
                        lastInteractionProvider = 'codex'
                        OR lastInteractionId LIKE 'appserver:%'
                      )
                `).all() as Array<{ id: string }>
                for (const row of rows) references.add(normalizeSessionId(row.id))
            }
        } catch (error) {
            errors.push(`Could not read runtime references from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            db?.close()
        }
    }
    return references
}

function listAppDatabasePaths(stateDir: string): string[] {
    const paths: string[] = []
    const root = path.join(stateDir, 'data.db')
    if (fs.existsSync(root)) paths.push(root)
    const profilesRoot = path.join(stateDir, 'profiles')
    try {
        for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const dbPath = path.join(profilesRoot, entry.name, 'data.db')
            if (fs.existsSync(dbPath)) paths.push(dbPath)
        }
    } catch {
        // Profiles are optional on single-profile installs.
    }
    return paths
}

function resolveRolloutPath(codexHome: string, storedPath: string): string | null {
    const resolved = path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(codexHome, storedPath))
    const sessionsRoot = path.join(codexHome, 'sessions')
    const archivedRoot = path.join(codexHome, 'archived_sessions')
    if (!isInside(sessionsRoot, resolved) && !isInside(archivedRoot, resolved)) return null
    if (isFile(resolved)) return resolved
    const compressed = resolved.endsWith('.zst') ? resolved : `${resolved}.zst`
    return isFile(compressed) ? compressed : null
}

function collectDescendants(id: string, children: Map<string, string[]>): string[] {
    const found: string[] = []
    const pending = [...(children.get(id) ?? [])]
    const seen = new Set<string>()
    while (pending.length > 0) {
        const child = pending.pop()!
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
        pending.push(...(children.get(child) ?? []))
    }
    return found
}

function threadDepth(id: string, parent: Map<string, string>): number {
    let depth = 0
    let current = id
    const seen = new Set<string>()
    while (parent.has(current) && !seen.has(current)) {
        seen.add(current)
        current = parent.get(current)!
        depth += 1
    }
    return depth
}

function tableExists(db: Database.Database, table: string): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
}

function normalizeSessionId(id: string): string {
    return id.startsWith(APP_SERVER_PREFIX) ? id.slice(APP_SERVER_PREFIX.length) : id
}

function dedupeDeleteResults(
    results: CodexThreadDeleteResult[],
    expectedIds: string[]
): CodexThreadDeleteResult[] {
    const byId = new Map<string, CodexThreadDeleteResult>()
    for (const result of results) if (!byId.has(result.id)) byId.set(result.id, result)
    return expectedIds.map(id => byId.get(id) ?? { id, ok: false, error: 'No deletion result returned.' })
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile()
    } catch {
        return false
    }
}

function isInside(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.floor(value)))
}

function processUsesDifferentCodexHome(environPath: string, expectedCodexHome: string): boolean {
    try {
        const env = Object.fromEntries(
            fs.readFileSync(environPath, 'utf-8')
                .split('\0')
                .filter(Boolean)
                .map(entry => {
                    const equals = entry.indexOf('=')
                    return equals < 0 ? [entry, ''] : [entry.slice(0, equals), entry.slice(equals + 1)]
                })
        )
        const actual = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : '')
        return Boolean(actual) && path.resolve(actual) !== path.resolve(expectedCodexHome)
    } catch {
        // If another user's process cannot be inspected, preserve safety by
        // treating it as potentially attached to this runtime.
        return false
    }
}

function commandUsesDifferentCodexHome(command: string, expectedCodexHome: string): boolean {
    const explicit = /(?:^|\s)CODEX_HOME=([^\s]+)/.exec(command)?.[1]
    const home = /(?:^|\s)HOME=([^\s]+)/.exec(command)?.[1]
    const actual = explicit || (home ? path.join(home, '.codex') : '')
    return Boolean(actual) && path.resolve(actual) !== path.resolve(expectedCodexHome)
}
