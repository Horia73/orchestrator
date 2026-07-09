import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

const DAY_MS = 86_400_000
const KEEP_MARKER = '.orchestrator-keep'
const RUN_STATE_FILE = 'run-state.json'
const TERMINAL_RUN_STATUSES = new Set(['pushed', 'published-static'])

export interface FilesystemRetentionPolicy {
    projectRunDays: number
    workspaceTmpDays: number
}

export interface WorkspaceTmpMaintenanceItem {
    name: string
    path: string
    action: 'eligible' | 'removed' | 'kept' | 'error'
    reason: string
    bytes: number
    newestMtime: number | null
}

export interface WorkspaceTmpMaintenanceResult {
    root: string
    applied: boolean
    retentionDays: number
    removed: number
    reclaimedBytes: number
    items: WorkspaceTmpMaintenanceItem[]
}

export interface ProjectRunMaintenanceItem {
    runId: string
    path: string
    status: string
    action: 'eligible' | 'cleaned' | 'kept' | 'error'
    reason: string
    terminalAt: number | null
    bytes: number
}

export interface ProjectRunMaintenanceResult {
    root: string
    applied: boolean
    retentionDays: number
    cleaned: number
    reclaimedBytes: number
    items: ProjectRunMaintenanceItem[]
}

interface TreeInspection {
    bytes: number
    newestMtime: number
    protected: boolean
    error: string | null
}

interface ProjectRunState {
    runId?: unknown
    status?: unknown
    repoDir?: unknown
    sourceDir?: unknown
    projectDir?: unknown
    port?: unknown
    pinned?: unknown
    pushedAt?: unknown
    published?: unknown
    preview?: unknown
    [key: string]: unknown
}

interface ProjectRunCandidate {
    state: ProjectRunState
    statePath: string
    runDir: string
    repoDir: string
    terminalAt: number
}

const DEFAULT_POLICY: FilesystemRetentionPolicy = {
    projectRunDays: 30,
    workspaceTmpDays: 14,
}

function retentionDays(name: string, fallback: number): number {
    const raw = process.env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    // 0 explicitly disables automatic cleanup for this storage class.
    return Math.max(0, Math.min(3650, Math.floor(value)))
}

export function getFilesystemRetentionPolicy(): FilesystemRetentionPolicy {
    return {
        projectRunDays: retentionDays(
            'ORCHESTRATOR_PROJECT_RUN_RETENTION_DAYS',
            DEFAULT_POLICY.projectRunDays
        ),
        workspaceTmpDays: retentionDays(
            'ORCHESTRATOR_WORKSPACE_TMP_RETENTION_DAYS',
            DEFAULT_POLICY.workspaceTmpDays
        ),
    }
}

/**
 * Remove only top-level entries in workspace/tmp whose entire tree has been
 * untouched past the retention window. A .orchestrator-keep marker anywhere in
 * a tree, or a sibling <name>.keep file, makes the entry durable. Symlinks are
 * inspected and removed as links; they are never followed.
 */
export function maintainWorkspaceTmp(options: {
    workspaceDir: string
    now?: number
    retentionDays?: number
    apply?: boolean
}): WorkspaceTmpMaintenanceResult {
    const now = options.now ?? Date.now()
    const retentionDays = options.retentionDays ?? getFilesystemRetentionPolicy().workspaceTmpDays
    const apply = options.apply === true
    const root = path.join(options.workspaceDir, 'tmp')
    const result: WorkspaceTmpMaintenanceResult = {
        root,
        applied: apply,
        retentionDays,
        removed: 0,
        reclaimedBytes: 0,
        items: [],
    }

    if (retentionDays <= 0 || !isDirectory(root)) return result
    const cutoff = now - retentionDays * DAY_MS

    for (const entry of safeReadDir(root)) {
        const entryPath = path.join(root, entry.name)
        if (isKeepName(entry.name) || fs.existsSync(`${entryPath}.keep`)) {
            result.items.push(tmpItem(entry.name, entryPath, 'kept', 'pinned', null))
            continue
        }

        const inspected = inspectTree(entryPath)
        if (inspected.error) {
            result.items.push(tmpItem(entry.name, entryPath, 'error', inspected.error, inspected))
            continue
        }
        if (inspected.protected) {
            result.items.push(tmpItem(entry.name, entryPath, 'kept', 'keep-marker', inspected))
            continue
        }
        if (inspected.newestMtime >= cutoff) {
            result.items.push(tmpItem(entry.name, entryPath, 'kept', 'recent', inspected))
            continue
        }

        if (!apply) {
            result.items.push(tmpItem(entry.name, entryPath, 'eligible', 'expired', inspected))
            continue
        }

        try {
            fs.rmSync(entryPath, { recursive: true, force: true })
            result.removed += 1
            result.reclaimedBytes += inspected.bytes
            result.items.push(tmpItem(entry.name, entryPath, 'removed', 'expired', inspected))
        } catch (error) {
            result.items.push(tmpItem(
                entry.name,
                entryPath,
                'error',
                error instanceof Error ? error.message : String(error),
                inspected
            ))
        }
    }

    return result
}

/**
 * Audit or clean old terminal project runs. Automatic cleanup is deliberately
 * narrow: the run must be pushed or static-published, older than the window,
 * unpinned, inactive, inside its own run directory, and git-clean. Linked
 * worktrees keep their branch; standalone repositories are bundled first.
 */
export function maintainProjectRuns(options: {
    stateRoot?: string
    now?: number
    retentionDays?: number
    apply?: boolean
    measureBytes?: boolean
} = {}): ProjectRunMaintenanceResult {
    const now = options.now ?? Date.now()
    const retentionDays = options.retentionDays ?? getFilesystemRetentionPolicy().projectRunDays
    const apply = options.apply === true
    const measureBytes = options.measureBytes === true || apply
    const root = options.stateRoot ?? path.join(ORCHESTRATOR_STATE_DIR, 'project-runs')
    const result: ProjectRunMaintenanceResult = {
        root,
        applied: apply,
        retentionDays,
        cleaned: 0,
        reclaimedBytes: 0,
        items: [],
    }

    if (retentionDays <= 0 || !isDirectory(root)) return result
    const cutoff = now - retentionDays * DAY_MS

    for (const entry of safeReadDir(root)) {
        if (!entry.isDirectory()) continue
        const runDir = path.join(root, entry.name)
        const statePath = path.join(runDir, RUN_STATE_FILE)
        const assessed = assessProjectRun({ runDir, statePath, expectedRunId: entry.name, cutoff })
        if ('item' in assessed) {
            result.items.push(assessed.item)
            continue
        }

        const candidate = assessed.candidate
        const bytes = measureBytes ? inspectTree(runDir).bytes : 0
        if (!apply) {
            result.items.push(projectItem(candidate, 'eligible', 'expired-terminal-run', bytes))
            continue
        }

        try {
            cleanupProjectRun(candidate, root, now)
            const remainingBytes = measureBytes ? inspectTree(candidate.runDir).bytes : 0
            const reclaimedBytes = Math.max(0, bytes - remainingBytes)
            result.cleaned += 1
            result.reclaimedBytes += reclaimedBytes
            result.items.push(projectItem(candidate, 'cleaned', 'expired-terminal-run', reclaimedBytes))
        } catch (error) {
            result.items.push(projectItem(
                candidate,
                'error',
                error instanceof Error ? error.message : String(error),
                bytes
            ))
        }
    }

    return result
}

function assessProjectRun(input: {
    runDir: string
    statePath: string
    expectedRunId: string
    cutoff: number
}): { candidate: ProjectRunCandidate } | { item: ProjectRunMaintenanceItem } {
    const base = {
        runId: input.expectedRunId,
        path: input.runDir,
        status: 'invalid',
        terminalAt: null,
        bytes: 0,
    }
    if (!fs.existsSync(input.statePath)) {
        return { item: { ...base, action: 'kept', reason: 'missing-run-state' } }
    }

    let state: ProjectRunState
    try {
        state = JSON.parse(fs.readFileSync(input.statePath, 'utf-8')) as ProjectRunState
    } catch (error) {
        return {
            item: {
                ...base,
                action: 'error',
                reason: error instanceof Error ? error.message : String(error),
            },
        }
    }

    const runId = typeof state.runId === 'string' ? state.runId : input.expectedRunId
    const status = typeof state.status === 'string' ? state.status : 'unknown'
    const itemBase = { ...base, runId, status }
    if (runId !== input.expectedRunId) {
        return { item: { ...itemBase, action: 'kept', reason: 'run-id-mismatch' } }
    }
    if (state.pinned === true || fs.existsSync(path.join(input.runDir, KEEP_MARKER))) {
        return { item: { ...itemBase, action: 'kept', reason: 'pinned' } }
    }
    if (status === 'cleaned') {
        return { item: { ...itemBase, action: 'kept', reason: 'already-cleaned' } }
    }
    if (!TERMINAL_RUN_STATUSES.has(status)) {
        return { item: { ...itemBase, action: 'kept', reason: 'non-terminal' } }
    }

    const terminalAt = terminalTimestamp(state, status)
    if (terminalAt === null) {
        return { item: { ...itemBase, action: 'kept', reason: 'missing-terminal-timestamp' } }
    }
    if (terminalAt >= input.cutoff) {
        return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'recent' } }
    }
    if (typeof state.repoDir !== 'string' || !path.isAbsolute(state.repoDir)) {
        return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'invalid-repo-path' } }
    }

    const repoDir = path.resolve(state.repoDir)
    if (!isInside(input.runDir, repoDir) || repoDir === path.resolve(input.runDir)) {
        return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'repo-outside-run' } }
    }

    const processState = previewProcessState(state, repoDir)
    if (processState === 'active') {
        return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'active-preview' } }
    }
    if (processState === 'unverified') {
        return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'preview-process-unverified' } }
    }

    if (fs.existsSync(repoDir)) {
        const gitStatus = runGit(['status', '--porcelain'], repoDir)
        if (!gitStatus.ok) {
            return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'repo-status-unavailable' } }
        }
        if (gitStatus.stdout.trim()) {
            return { item: { ...itemBase, terminalAt, action: 'kept', reason: 'dirty-repo' } }
        }
    }

    return {
        candidate: {
            state,
            statePath: input.statePath,
            runDir: input.runDir,
            repoDir,
            terminalAt,
        },
    }
}

function cleanupProjectRun(candidate: ProjectRunCandidate, stateRoot: string, now: number): void {
    const { state, repoDir, runDir, statePath } = candidate
    let branchPreserved = false
    let sourceBundle: string | null = null
    if (fs.existsSync(repoDir)) {
        const controlDir = findWorktreeControlDir(state, repoDir)
        if (controlDir) {
            const removed = runGit(['worktree', 'remove', repoDir], controlDir)
            if (!removed.ok) throw new Error(`git worktree remove failed: ${removed.stderr || removed.stdout}`)
            branchPreserved = true
        } else {
            if (isFile(path.join(repoDir, '.git'))) {
                throw new Error('linked worktree control checkout is unavailable')
            }
            sourceBundle = path.join(runDir, 'source.bundle')
            const bundled = runGit(['bundle', 'create', sourceBundle, '--all'], repoDir)
            if (!bundled.ok) throw new Error(`git bundle create failed: ${bundled.stderr || bundled.stdout}`)
            branchPreserved = true
            fs.rmSync(repoDir, { recursive: true, force: true })
        }
    }

    // Keep a small audit record, but remove previews, logs, dependency trees,
    // and any other run-local cache. Unknown files outside the run directory
    // are never touched.
    for (const entry of safeReadDir(runDir)) {
        if (
            entry.name === RUN_STATE_FILE
            || entry.name === KEEP_MARKER
            || (sourceBundle && path.resolve(path.join(runDir, entry.name)) === path.resolve(sourceBundle))
        ) continue
        fs.rmSync(path.join(runDir, entry.name), { recursive: true, force: true })
    }

    releaseRunPort(stateRoot, state)
    const cleanedAt = new Date(now).toISOString()
    const preview = isRecord(state.preview)
        ? { ...state.preview, status: 'stopped', pid: null, stoppedAt: cleanedAt }
        : state.preview
    writeJsonAtomic(statePath, {
        ...state,
        status: 'cleaned',
        previousStatus: state.status,
        preview,
        cleanedAt,
        updatedAt: cleanedAt,
        retentionCleanup: {
            automatic: true,
            terminalAt: new Date(candidate.terminalAt).toISOString(),
            branchPreserved,
            sourceBundle,
        },
    })
}

function terminalTimestamp(state: ProjectRunState, status: string): number | null {
    if (status === 'pushed') return parseTimestamp(state.pushedAt)
    if (status === 'published-static' && isRecord(state.published)) {
        return parseTimestamp(state.published.publishedAt)
    }
    return null
}

function previewProcessState(state: ProjectRunState, repoDir: string): 'inactive' | 'active' | 'unverified' {
    if (!isRecord(state.preview) || !Number.isInteger(state.preview.pid)) return 'inactive'
    const pid = state.preview.pid as number
    try {
        process.kill(pid, 0)
    } catch {
        return 'inactive'
    }

    const procCwd = `/proc/${pid}/cwd`
    try {
        const cwd = fs.realpathSync.native(procCwd)
        const realRepoDir = fs.realpathSync.native(repoDir)
        return isInside(realRepoDir, cwd) ? 'active' : 'inactive'
    } catch {
        // On macOS, lsof is the most reliable non-mutating cwd probe.
        const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
        if (lsof.status === 0) {
            const cwd = lsof.stdout
                .split(/\r?\n/)
                .find(line => line.startsWith('n'))
                ?.slice(1)
            if (cwd) {
                const realRepoDir = fs.realpathSync.native(repoDir)
                return isInside(realRepoDir, cwd) ? 'active' : 'inactive'
            }
        }
        return 'unverified'
    }
}

function findWorktreeControlDir(state: ProjectRunState, repoDir: string): string | null {
    const candidates = [state.sourceDir, state.projectDir]
        .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))
    for (const candidate of candidates) {
        if (!isDirectory(candidate)) continue
        const listed = runGit(['worktree', 'list', '--porcelain'], candidate)
        if (!listed.ok) continue
        const linked = listed.stdout.split(/\r?\n/).some(line =>
            line.startsWith('worktree ')
            && path.resolve(line.slice('worktree '.length)) === path.resolve(repoDir)
        )
        if (linked) return candidate
    }
    return null
}

function releaseRunPort(stateRoot: string, state: ProjectRunState): void {
    const portStatePath = path.join(stateRoot, 'ports.json')
    if (!fs.existsSync(portStatePath)) return
    let portState: unknown
    try {
        portState = JSON.parse(fs.readFileSync(portStatePath, 'utf-8'))
    } catch {
        return
    }
    if (!isRecord(portState) || !isRecord(portState.allocations)) return

    const allocations = { ...portState.allocations }
    let changed = false
    for (const [port, rawAllocation] of Object.entries(allocations)) {
        const allocation = isRecord(rawAllocation) ? rawAllocation : {}
        if (
            String(state.port ?? '') === port
            || allocation.runId === state.runId
            || allocation.repoDir === state.repoDir
        ) {
            delete allocations[port]
            changed = true
        }
    }
    if (changed) writeJsonAtomic(portStatePath, { ...portState, allocations })
}

function inspectTree(root: string): TreeInspection {
    const result: TreeInspection = {
        bytes: 0,
        newestMtime: 0,
        protected: false,
        error: null,
    }
    const pending = [root]
    while (pending.length > 0) {
        const current = pending.pop()!
        let stat: fs.Stats
        try {
            stat = fs.lstatSync(current)
        } catch (error) {
            result.error = error instanceof Error ? error.message : String(error)
            return result
        }
        result.bytes += stat.size
        result.newestMtime = Math.max(result.newestMtime, stat.mtimeMs)
        if (path.basename(current) === KEEP_MARKER) result.protected = true
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        try {
            for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry))
        } catch (error) {
            result.error = error instanceof Error ? error.message : String(error)
            return result
        }
    }
    return result
}

function tmpItem(
    name: string,
    entryPath: string,
    action: WorkspaceTmpMaintenanceItem['action'],
    reason: string,
    inspected: TreeInspection | null
): WorkspaceTmpMaintenanceItem {
    return {
        name,
        path: entryPath,
        action,
        reason,
        bytes: inspected?.bytes ?? 0,
        newestMtime: inspected?.newestMtime || null,
    }
}

function projectItem(
    candidate: ProjectRunCandidate,
    action: ProjectRunMaintenanceItem['action'],
    reason: string,
    bytes: number
): ProjectRunMaintenanceItem {
    return {
        runId: String(candidate.state.runId),
        path: candidate.runDir,
        status: String(candidate.state.status),
        action,
        reason,
        terminalAt: candidate.terminalAt,
        bytes,
    }
}

function isKeepName(name: string): boolean {
    return name === KEEP_MARKER || name === '.keep' || name === '.gitkeep' || name.endsWith('.keep')
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

function safeReadDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory()
    } catch {
        return false
    }
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

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
        ok: !result.error && result.status === 0,
        stdout: result.stdout || '',
        stderr: result.error?.message || result.stderr || '',
    }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, filePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
