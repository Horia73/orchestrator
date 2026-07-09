#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'

import { ADMIN_PROFILE_ID } from '@/lib/profiles/constants'
import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'
import {
    getCodexSessionDeleteLimit,
    maintainCodexRuntime,
    selectCodexDeleteCandidates,
} from '@/lib/storage/codex-runtime-retention'
import {
    getFilesystemRetentionPolicy,
    maintainProjectRuns,
    maintainWorkspaceTmp,
} from '@/lib/storage/filesystem-retention'

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 1) {
    const raw = process.argv[index]
    if (!raw.startsWith('--')) continue
    const equals = raw.indexOf('=')
    if (equals >= 0) {
        args.set(raw.slice(2, equals), raw.slice(equals + 1))
        continue
    }
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) {
        args.set(raw.slice(2), next)
        index += 1
    } else {
        args.set(raw.slice(2), 'true')
    }
}

const apply = args.get('apply') === 'true'
const json = args.get('json') === 'true'
const summary = args.get('summary') === 'true'
const releaseLock = apply ? acquireMaintenanceLock() : () => undefined
if (!releaseLock) {
    console.log('Filesystem retention skipped: another maintenance process holds the lock.')
    process.exit(0)
}

try {
const now = numberArg('now') ?? Date.now()
const policy = getFilesystemRetentionPolicy()
const projectRunDays = numberArg('project-days') ?? policy.projectRunDays
const workspaceTmpDays = numberArg('tmp-days') ?? policy.workspaceTmpDays
const codexDeleteLimit = numberArg('codex-limit') ?? getCodexSessionDeleteLimit()
const requestedProfile = args.get('profile')?.trim()
const profiles = discoverProfileWorkspaces()
    .filter(profile => !requestedProfile || profile.profileId === requestedProfile)

if (requestedProfile && profiles.length === 0) {
    throw new Error(`Unknown profile: ${requestedProfile}`)
}

const projectRuns = maintainProjectRuns({
    stateRoot: args.get('state-root')
        ? path.resolve(args.get('state-root')!)
        : path.join(ORCHESTRATOR_STATE_DIR, 'project-runs'),
    now,
    retentionDays: projectRunDays,
    apply,
    measureBytes: true,
})
const workspaceTmp = profiles.map(profile => ({
    profileId: profile.profileId,
    result: maintainWorkspaceTmp({
        workspaceDir: profile.workspaceDir,
        now,
        retentionDays: workspaceTmpDays,
        apply,
    }),
}))
const codexRuntime = args.get('skip-codex') === 'true'
    ? null
    : await maintainCodexRuntime({
        stateDir: ORCHESTRATOR_STATE_DIR,
        now,
        retentionDays: numberArg('codex-days') ?? undefined,
        deleteLimit: codexDeleteLimit,
        apply,
        vacuumLogs: args.get('skip-codex-vacuum') !== 'true',
    })

const payload = {
    mode: apply ? 'apply' : 'audit',
    now: new Date(now).toISOString(),
    policy: {
        projectRunDays,
        workspaceTmpDays,
        codexSessionDays: codexRuntime?.audit.retentionDays ?? null,
        codexSessionDeleteLimit: codexRuntime ? codexDeleteLimit : null,
    },
    projectRuns,
    workspaceTmp,
    codexRuntime,
}

if (json) {
    console.log(JSON.stringify(payload, null, 2))
} else {
    const projectCandidates = projectRuns.items.filter(item => item.action === 'eligible').length
    console.log(`${apply ? 'Applied' : 'Audited'} filesystem retention at ${payload.now}`)
    console.log(
        `Project runs: ${apply ? `${projectRuns.cleaned} cleaned` : `${projectCandidates} eligible`}`
        + `, ${formatBytes(apply ? projectRuns.reclaimedBytes : eligibleBytes(projectRuns.items))}`
    )
    if (!summary) {
        for (const item of projectRuns.items) {
            if (item.reason === 'non-terminal' || item.reason === 'recent' || item.reason === 'already-cleaned') continue
            console.log(`  ${item.runId}: ${item.action} (${item.reason}, ${formatBytes(item.bytes)})`)
        }
    }
    for (const profile of workspaceTmp) {
        const eligible = profile.result.items.filter(item => item.action === 'eligible')
        const bytes = apply
            ? profile.result.reclaimedBytes
            : eligible.reduce((sum, item) => sum + item.bytes, 0)
        console.log(
            `Workspace tmp [${profile.profileId}]: `
            + `${apply ? `${profile.result.removed} removed` : `${eligible.length} eligible`}`
            + `, ${formatBytes(bytes)}`
        )
        if (!summary) {
            for (const item of profile.result.items) {
                if (!['eligible', 'removed', 'error'].includes(item.action)) continue
                console.log(`  ${item.name}: ${item.action} (${item.reason}, ${formatBytes(item.bytes)})`)
            }
        }
    }
    if (codexRuntime) {
        const selected = selectCodexDeleteCandidates(codexRuntime.audit, codexDeleteLimit)
        const bytes = apply
            ? codexRuntime.reclaimedSessionBytes
            : selected.reduce((sum, candidate) => sum + candidate.bytes, 0)
        console.log(
            `Codex sessions: ${apply
                ? `${codexRuntime.deletedThreads} deleted`
                : `${selected.length} eligible`}`
            + `, ${formatBytes(bytes)}`
            + (codexRuntime.skippedReason ? ` (skipped: ${codexRuntime.skippedReason})` : '')
        )
        const logState = codexRuntime.logsVacuumed
            ? `vacuumed, ${formatBytes(codexRuntime.reclaimedLogBytes)} reclaimed`
            : `${formatBytes(codexRuntime.audit.logs.freeBytes)} reusable pages`
        console.log(`Codex logs: ${logState}`)
        if (!summary) {
            for (const result of codexRuntime.deleteResults.filter(result => !result.ok)) {
                console.log(`  ${result.id}: error (${result.error ?? 'unknown delete failure'})`)
            }
            for (const error of codexRuntime.audit.errors) console.log(`  audit error: ${error}`)
            if (codexRuntime.logsVacuumError) {
                console.log(`  Codex log compaction error: ${codexRuntime.logsVacuumError}`)
            }
        }
    }
    const errors = projectRuns.items.filter(item => item.action === 'error').length
        + workspaceTmp.reduce(
            (sum, profile) => sum + profile.result.items.filter(item => item.action === 'error').length,
            0
        )
        + (codexRuntime?.audit.errors.length ?? 0)
        + (codexRuntime?.deleteResults.filter(result => !result.ok).length ?? 0)
        + (codexRuntime?.logsVacuumError ? 1 : 0)
    if (errors > 0) console.log(`Maintenance errors: ${errors}`)
    if (!apply) console.log('Dry-run only. Re-run with --apply to perform eligible cleanup.')
}
} finally {
    releaseLock()
}

function numberArg(name: string): number | null {
    const raw = args.get(name)
    if (!raw) return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number.`)
    return Math.floor(value)
}

function discoverProfileWorkspaces(): Array<{ profileId: string; workspaceDir: string }> {
    const found = [{
        profileId: ADMIN_PROFILE_ID,
        workspaceDir: path.join(ORCHESTRATOR_STATE_DIR, 'workspace'),
    }]
    const profilesRoot = path.join(ORCHESTRATOR_STATE_DIR, 'profiles')
    let entries: fs.Dirent[] = []
    try {
        entries = fs.readdirSync(profilesRoot, { withFileTypes: true })
    } catch {
        return found
    }
    for (const entry of entries) {
        if (
            !entry.isDirectory()
            || entry.name === ADMIN_PROFILE_ID
            || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(entry.name)
        ) continue
        found.push({
            profileId: entry.name,
            workspaceDir: path.join(profilesRoot, entry.name, 'workspace'),
        })
    }
    return found
}

function eligibleBytes(items: Array<{ action: string; bytes: number }>): number {
    return items
        .filter(item => item.action === 'eligible')
        .reduce((sum, item) => sum + item.bytes, 0)
}

function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = -1
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024
        unit += 1
    }
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

function acquireMaintenanceLock(): (() => void) | null {
    fs.mkdirSync(ORCHESTRATOR_STATE_DIR, { recursive: true })
    const lockPath = path.join(ORCHESTRATOR_STATE_DIR, '.filesystem-retention.lock')
    const staleAfterMs = 6 * 60 * 60_000

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600)
            fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
            fs.closeSync(fd)
            return () => {
                try {
                    fs.rmSync(lockPath, { force: true })
                } catch {
                    // A stale lock is harmless; the next run will age it out.
                }
            }
        } catch (error) {
            if (!isAlreadyExists(error)) throw error
            const stale = (() => {
                try {
                    return Date.now() - fs.statSync(lockPath).mtimeMs > staleAfterMs
                } catch {
                    return true
                }
            })()
            if (!stale) return null
            fs.rmSync(lockPath, { force: true })
        }
    }
    return null
}

function isAlreadyExists(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}
