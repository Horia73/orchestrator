import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { findRecoverableSelfDevRuns } from '@/lib/self-dev/recovery'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-self-dev-recovery-'))
const now = Date.now()

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function addRun(args: {
    id: string
    ageMs: number
    dirty: boolean
    pid?: number
    status?: string
    stoppedAt?: string | null
    lastAttemptAt?: string
}) {
    const runDir = path.join(root, args.id)
    const repoDir = path.join(runDir, 'repo')
    fs.mkdirSync(repoDir, { recursive: true })
    git(repoDir, ['init', '-q'])
    git(repoDir, ['config', 'user.email', 'smoke@example.test'])
    git(repoDir, ['config', 'user.name', 'Smoke'])
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n')
    git(repoDir, ['add', 'tracked.txt'])
    git(repoDir, ['commit', '-qm', 'base'])
    if (args.dirty) fs.appendFileSync(path.join(repoDir, 'tracked.txt'), 'unfinished\n')

    const createdAt = new Date(now - args.ageMs).toISOString()
    fs.writeFileSync(path.join(runDir, 'run-state.json'), `${JSON.stringify({
        runId: args.id,
        kind: 'self',
        createdAt,
        repoDir,
        baseRef: 'HEAD',
        port: 3142,
        task: args.id,
        owner: { profileId: 'admin_horia', conversationId: `conversation-${args.id}` },
        preview: {
            status: args.status ?? 'running',
            pid: args.pid ?? 0,
            stoppedAt: args.stoppedAt ?? null,
            healthPath: '/',
        },
        recovery: args.lastAttemptAt ? { lastAttemptAt: args.lastAttemptAt } : undefined,
    }, null, 2)}\n`)
}

try {
    addRun({ id: 'older-dirty', ageMs: 60_000, dirty: true })
    addRun({ id: 'newest-dirty', ageMs: 10_000, dirty: true })
    addRun({ id: 'live-dirty', ageMs: 5_000, dirty: true, pid: 4242 })
    addRun({ id: 'clean', ageMs: 4_000, dirty: false })
    addRun({ id: 'stopped', ageMs: 3_000, dirty: true, stoppedAt: new Date(now - 1_000).toISOString() })
    addRun({ id: 'stale', ageMs: 80 * 60 * 60 * 1000, dirty: true })
    addRun({ id: 'cooldown', ageMs: 2_000, dirty: true, lastAttemptAt: new Date(now - 1_000).toISOString() })

    const candidates = findRecoverableSelfDevRuns({
        roots: [root],
        now,
        isPreviewAlive: state => state.preview?.pid === 4242,
    })
    assert.deepEqual(candidates.map(candidate => candidate.runId), ['newest-dirty', 'older-dirty'])
    assert.equal(candidates[0].owner.conversationId, 'conversation-newest-dirty')
    const prepareSource = fs.readFileSync(path.join(process.cwd(), 'scripts/self-dev-prepare.mjs'), 'utf8')
    assert.match(prepareSource, /ORCHESTRATOR_SELF_DEV_CONVERSATION_ID/)
    assert.match(prepareSource, /owner:\s*\{/)
    console.log('self-dev recovery smoke passed')
} finally {
    fs.rmSync(root, { recursive: true, force: true })
}
