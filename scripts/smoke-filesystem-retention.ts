import assert from 'assert'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
    maintainProjectRuns,
    maintainWorkspaceTmp,
} from '@/lib/storage/filesystem-retention'
import { resolveProjectRunsRoot } from './project-run-paths.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-retention-smoke-'))
const originalCwd = process.cwd()
const now = Date.UTC(2026, 6, 9, 12)
const oldIso = new Date(now - 40 * 86_400_000).toISOString()
const recentIso = new Date(now - 2 * 86_400_000).toISOString()
const stateRoot = path.join(sandbox, 'state', 'project-runs')
const workspaceDir = path.join(sandbox, 'workspace')
fs.mkdirSync(stateRoot, { recursive: true })

try {
    const originalRunsDir = process.env.ORCHESTRATOR_PROJECT_RUNS_DIR
    const originalAppDir = process.env.ORCHESTRATOR_APP_DIR
    process.env.ORCHESTRATOR_PROJECT_RUNS_DIR = '/tmp/shared-project-runs'
    assert.equal(resolveProjectRunsRoot('/tmp/source-checkout'), '/tmp/shared-project-runs')
    delete process.env.ORCHESTRATOR_PROJECT_RUNS_DIR
    process.env.ORCHESTRATOR_APP_DIR = '/app'
    assert.equal(resolveProjectRunsRoot('/orchestrator-source'), '/app/.orchestrator/project-runs')
    restoreEnv('ORCHESTRATOR_PROJECT_RUNS_DIR', originalRunsDir)
    restoreEnv('ORCHESTRATOR_APP_DIR', originalAppDir)

    const eligible = createRun('eligible', { status: 'pushed', pushedAt: oldIso })
    const dirty = createRun('dirty', { status: 'pushed', pushedAt: oldIso })
    fs.writeFileSync(path.join(dirty.repoDir, 'dirty.txt'), 'uncommitted\n')
    createRun('pinned', { status: 'pushed', pushedAt: oldIso, pinned: true })
    createRun('prepared', { status: 'prepared' })
    createRun('recent', { status: 'pushed', pushedAt: recentIso })
    const active = createRun('active', {
        status: 'pushed',
        pushedAt: oldIso,
        preview: { status: 'running', pid: process.pid },
    })

    // Make the current process a positively identified active preview without
    // spawning or killing any process in the smoke test.
    process.chdir(active.repoDir)
    const audit = maintainProjectRuns({
        stateRoot,
        now,
        retentionDays: 30,
        apply: false,
        measureBytes: true,
    })
    assert.equal(audit.cleaned, 0)
    assert.equal(runItem(audit.items, 'eligible').action, 'eligible')
    assert.equal(runItem(audit.items, 'dirty').reason, 'dirty-repo')
    assert.equal(runItem(audit.items, 'pinned').reason, 'pinned')
    assert.equal(runItem(audit.items, 'prepared').reason, 'non-terminal')
    assert.equal(runItem(audit.items, 'recent').reason, 'recent')
    assert.equal(runItem(audit.items, 'active').reason, 'active-preview')
    assert.ok(fs.existsSync(eligible.repoDir), 'audit must not mutate eligible runs')

    const applied = maintainProjectRuns({
        stateRoot,
        now,
        retentionDays: 30,
        apply: true,
        measureBytes: true,
    })
    assert.equal(applied.cleaned, 1)
    assert.ok(applied.reclaimedBytes > 0)
    assert.ok(!fs.existsSync(eligible.repoDir))
    const cleanedState = JSON.parse(fs.readFileSync(eligible.statePath, 'utf-8'))
    assert.equal(cleanedState.status, 'cleaned')
    assert.equal(cleanedState.previousStatus, 'pushed')
    assert.equal(cleanedState.retentionCleanup.automatic, true)
    assert.equal(cleanedState.retentionCleanup.branchPreserved, true)
    assert.ok(fs.existsSync(cleanedState.retentionCleanup.sourceBundle))
    const verifiedBundle = spawnSync(
        'git',
        ['bundle', 'verify', cleanedState.retentionCleanup.sourceBundle],
        { cwd: active.repoDir, encoding: 'utf-8', stdio: 'pipe' }
    )
    assert.equal(verifiedBundle.status, 0, verifiedBundle.stderr || verifiedBundle.stdout)
    assert.ok(fs.existsSync(dirty.repoDir), 'dirty terminal run must survive automatic cleanup')
    assert.ok(fs.existsSync(active.repoDir), 'active preview run must survive automatic cleanup')

    const tmpRoot = path.join(workspaceDir, 'tmp')
    fs.mkdirSync(tmpRoot, { recursive: true })
    const oldFile = path.join(tmpRoot, 'old.bin')
    const freshFile = path.join(tmpRoot, 'fresh.bin')
    const nestedFreshDir = path.join(tmpRoot, 'nested-fresh')
    const pinnedDir = path.join(tmpRoot, 'pinned-dir')
    const siblingPinned = path.join(tmpRoot, 'sibling-pinned.bin')
    fs.writeFileSync(oldFile, Buffer.alloc(32))
    fs.writeFileSync(freshFile, Buffer.alloc(16))
    fs.mkdirSync(nestedFreshDir)
    fs.writeFileSync(path.join(nestedFreshDir, 'fresh-child.txt'), 'fresh')
    fs.mkdirSync(pinnedDir)
    fs.writeFileSync(path.join(pinnedDir, '.orchestrator-keep'), 'keep')
    fs.writeFileSync(siblingPinned, 'keep me')
    fs.writeFileSync(`${siblingPinned}.keep`, '')

    setOld(oldFile)
    setOld(nestedFreshDir)
    setOld(pinnedDir)
    setOld(path.join(pinnedDir, '.orchestrator-keep'))
    setOld(siblingPinned)
    setOld(`${siblingPinned}.keep`)
    const freshTime = new Date(now - 60_000)
    fs.utimesSync(freshFile, freshTime, freshTime)
    fs.utimesSync(path.join(nestedFreshDir, 'fresh-child.txt'), freshTime, freshTime)

    const tmpAudit = maintainWorkspaceTmp({ workspaceDir, now, retentionDays: 30, apply: false })
    assert.equal(tmpByName(tmpAudit.items, 'old.bin').action, 'eligible')
    assert.equal(tmpByName(tmpAudit.items, 'fresh.bin').reason, 'recent')
    assert.equal(tmpByName(tmpAudit.items, 'nested-fresh').reason, 'recent')
    assert.equal(tmpByName(tmpAudit.items, 'pinned-dir').reason, 'keep-marker')
    assert.equal(tmpByName(tmpAudit.items, 'sibling-pinned.bin').reason, 'pinned')
    assert.ok(fs.existsSync(oldFile), 'tmp audit must be dry-run')

    const tmpApplied = maintainWorkspaceTmp({ workspaceDir, now, retentionDays: 30, apply: true })
    assert.equal(tmpApplied.removed, 1)
    assert.ok(!fs.existsSync(oldFile))
    assert.ok(fs.existsSync(freshFile))
    assert.ok(fs.existsSync(path.join(nestedFreshDir, 'fresh-child.txt')))
    assert.ok(fs.existsSync(pinnedDir))
    assert.ok(fs.existsSync(siblingPinned))

    console.log('filesystem retention smoke tests passed')
} finally {
    process.chdir(originalCwd)
    fs.rmSync(sandbox, { recursive: true, force: true })
}

function createRun(
    runId: string,
    statePatch: Record<string, unknown>
): { runDir: string; repoDir: string; statePath: string } {
    const runDir = path.join(stateRoot, runId)
    const repoDir = path.join(runDir, 'repo')
    const statePath = path.join(runDir, 'run-state.json')
    fs.mkdirSync(repoDir, { recursive: true })
    git(['init', '-b', 'main'], repoDir)
    git(['config', 'user.email', 'smoke@example.invalid'], repoDir)
    git(['config', 'user.name', 'Retention Smoke'], repoDir)
    fs.writeFileSync(path.join(repoDir, 'README.md'), `${runId}\n`)
    git(['add', 'README.md'], repoDir)
    git(['commit', '-m', 'initial'], repoDir)
    fs.writeFileSync(statePath, `${JSON.stringify({
        runId,
        createdAt: oldIso,
        projectDir: sandbox,
        repoDir,
        branch: 'main',
        pinned: false,
        ...statePatch,
    }, null, 2)}\n`)
    return { runDir, repoDir, statePath }
}

function git(args: string[], cwd: string): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
}

function runItem<T extends { runId: string }>(items: T[], runId: string): T {
    const item = items.find(candidate => candidate.runId === runId)
    assert.ok(item, `missing run item ${runId}`)
    return item
}

function tmpByName<T extends { name: string }>(items: T[], name: string): T {
    const item = items.find(candidate => candidate.name === name)
    assert.ok(item, `missing tmp item ${name}`)
    return item
}

function setOld(filePath: string): void {
    const oldTime = new Date(now - 40 * 86_400_000)
    fs.utimesSync(filePath, oldTime, oldTime)
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}
