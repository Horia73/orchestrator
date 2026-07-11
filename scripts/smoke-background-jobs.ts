/**
 * Smoke test: tracked background jobs actually run, settle, and clean up.
 *
 * Covers the production regression where `spawn /bin/zsh ENOENT` silently
 * broke every job (SHELL unset + no zsh in the Docker image): shell
 * resolution, the happy exit path, spawn-failure settling (no eternal
 * 'running' rows), timeout kills, secret redaction, and retention pruning.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bg-jobs-'))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0
function check(label: string, condition: unknown, detail?: unknown): void {
    const ok = Boolean(condition)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

async function waitForSettled(
    getJob: (id: string) => { status: string } | null,
    id: string,
    timeoutMs: number,
): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const job = getJob(id)
        if (job && job.status !== 'running') return job.status
        if (Date.now() > deadline) return job?.status ?? 'missing'
        await new Promise(resolve => setTimeout(resolve, 100))
    }
}

async function main(): Promise<void> {
    const { resolveCommandShell } = await import('@/lib/cli/resolve-bin')
    const {
        startTrackedBackgroundJob,
        getBackgroundJob,
        readBackgroundJobLogTail,
        pruneExpiredBackgroundJobs,
        BACKGROUND_JOB_RETENTION_MS,
    } = await import('@/lib/ai/background-jobs')
    const { resolveEnvVarInjection } = await import('@/lib/ai/tools/env-vars')
    const db = (await import('@/lib/db')).default

    // ── Shell resolution ────────────────────────────────────────────────
    const shell = resolveCommandShell()
    check('resolveCommandShell returns an existing binary', fs.existsSync(shell), shell)

    const emptyInjection = resolveEnvVarInjection([])
    if (!emptyInjection.ok) throw new Error('empty injection failed')
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bg-cwd-'))

    // ── Happy path: run, exit 0, log + marker written ───────────────────
    const okJob = startTrackedBackgroundJob({
        command: 'echo smoke-bg-output',
        cwd: workDir,
        injection: emptyInjection.injection,
        conversationId: null,
        wakeOnExit: false,
    })
    check('job starts', okJob.ok && Boolean(okJob.job), okJob.error)
    if (okJob.job) {
        const status = await waitForSettled(getBackgroundJob, okJob.job.id, 15_000)
        const row = getBackgroundJob(okJob.job.id)
        check('job settles as exited', status === 'exited', status)
        check('exit code 0 recorded', row?.exitCode === 0, row?.exitCode)
        const log = row ? readBackgroundJobLogTail(row) : ''
        check('log captured output', log.includes('smoke-bg-output'), log.slice(-200))
        check('log has exit footer', log.includes('exited with code 0'), log.slice(-200))
        check(
            'exit marker written',
            Boolean(row?.exitMarkerPath) && fs.readFileSync(row!.exitMarkerPath!, 'utf-8').trim() === '0',
        )
    }

    // ── Spawn failure settles as failed (never eternal 'running') ───────
    const badCwdJob = startTrackedBackgroundJob({
        command: 'echo never-runs',
        cwd: path.join(workDir, 'does-not-exist'),
        injection: emptyInjection.injection,
        conversationId: null,
        wakeOnExit: false,
    })
    if (badCwdJob.ok && badCwdJob.job) {
        const status = await waitForSettled(getBackgroundJob, badCwdJob.job.id, 15_000)
        check('spawn failure settles as failed', status === 'failed', status)
        const row = getBackgroundJob(badCwdJob.job.id)
        const log = row ? readBackgroundJobLogTail(row) : ''
        check('spawn failure logged', log.includes('spawn error'), log.slice(-200))
    } else {
        // Synchronous spawn throw is also an acceptable failure surface.
        check('spawn failure reported synchronously', Boolean(badCwdJob.error), badCwdJob)
    }

    // ── Timeout kill ────────────────────────────────────────────────────
    const slowJob = startTrackedBackgroundJob({
        command: 'sleep 30',
        cwd: workDir,
        timeoutMs: 1_200,
        injection: emptyInjection.injection,
        conversationId: null,
        wakeOnExit: false,
    })
    check('slow job starts', slowJob.ok && Boolean(slowJob.job), slowJob.error)
    if (slowJob.job) {
        const status = await waitForSettled(getBackgroundJob, slowJob.job.id, 20_000)
        check('timed-out job settles as killed', status === 'killed', status)
        const row = getBackgroundJob(slowJob.job.id)
        const log = row ? readBackgroundJobLogTail(row) : ''
        check('timeout logged', log.includes('Timeout after'), log.slice(-200))
    }

    // ── Secret redaction (pipe path) ────────────────────────────────────
    process.env.ORCH_SMOKE_BG_SECRET = 'supersecret-bg-value-123'
    const secretInjection = resolveEnvVarInjection(['ORCH_SMOKE_BG_SECRET'])
    check('secret injection resolves', secretInjection.ok, secretInjection)
    if (secretInjection.ok) {
        const secretJob = startTrackedBackgroundJob({
            command: 'printf "leak:%s\\n" "$ORCH_SMOKE_BG_SECRET"',
            cwd: workDir,
            injection: secretInjection.injection,
            conversationId: null,
            wakeOnExit: false,
        })
        check('secret job starts', secretJob.ok && Boolean(secretJob.job), secretJob.error)
        if (secretJob.job) {
            const status = await waitForSettled(getBackgroundJob, secretJob.job.id, 15_000)
            check('secret job exits', status === 'exited', status)
            const row = getBackgroundJob(secretJob.job.id)
            const rawLog = row ? fs.readFileSync(row.logPath, 'utf-8') : ''
            check('secret value never reaches the log file', !rawLog.includes('supersecret-bg-value-123'), rawLog.slice(-200))
            check('command output still logged', rawLog.includes('leak:'), rawLog.slice(-200))
        }
    }

    // ── Retention pruning ───────────────────────────────────────────────
    const oldLogPath = path.join(workDir, 'old-job.log')
    fs.writeFileSync(oldLogPath, 'old log')
    const oldEndedAt = Date.now() - BACKGROUND_JOB_RETENTION_MS - 60_000
    db.prepare(
        `INSERT INTO background_jobs
            (id, conversationId, command, description, cwd, pid, logPath, exitMarkerPath,
             status, exitCode, wakeOnExit, startedAt, endedAt, notifiedAt)
         VALUES ('bg_smoke_old', NULL, 'echo old', NULL, NULL, NULL, ?, NULL,
                 'exited', 0, 0, ?, ?, NULL)`
    ).run(oldLogPath, oldEndedAt - 1_000, oldEndedAt)
    pruneExpiredBackgroundJobs()
    check('expired job row pruned', !getBackgroundJob('bg_smoke_old'))
    check('expired job log removed', !fs.existsSync(oldLogPath))
    check('recent jobs survive pruning', Boolean(okJob.job && getBackgroundJob(okJob.job.id)))

    console.log(failures === 0 ? '\n✓ smoke-background-jobs passed' : `\n✗ smoke-background-jobs FAILED (${failures})`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
