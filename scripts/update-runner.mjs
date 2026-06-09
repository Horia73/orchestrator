#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const projectDir = process.cwd()
const stateDir = path.join(projectDir, '.orchestrator')
const jobId = readArg('--job-id') || process.env.ORCHESTRATOR_UPDATE_JOB_ID || `manual-${Date.now()}`
const targetTag = readArg('--target-tag')
const targetBranch = readArg('--target-branch')
const targetVersionArg = readArg('--target-version')
let targetVersion = targetVersionArg || normalizeVersion(targetTag) || '0.0.0'
const statePath = path.join(stateDir, 'update-state.json')
const logPath = path.join(stateDir, `update-${jobId}.log`)

if (!targetTag && !targetBranch) {
  console.error('Missing --target-tag or --target-branch')
  process.exit(2)
}
if (targetBranch) assertSafeBranchName(targetBranch)

fs.mkdirSync(stateDir, { recursive: true })
const logFd = fs.openSync(logPath, 'a')

try {
  const targetLabel = targetTag || `branch:${targetBranch}`
  log(`Starting update ${jobId} -> ${targetLabel}`)
  writeState({
    phase: 'updating',
    targetKind: targetBranch ? 'branch' : 'release',
    targetTag: targetLabel,
    targetBranch: targetBranch || null,
    startedAt: Date.now(),
    waitReason: 'Installing update.',
    logPath,
  })

  assertCleanWorktree()
  if (targetBranch) {
    run('git', ['fetch', 'origin', targetBranch, '--tags'])
    run('git', ['checkout', targetBranch])
    run('git', ['pull', '--ff-only', 'origin', targetBranch])
    targetVersion = readPackageVersion()
  } else {
    run('git', ['fetch', '--tags', 'origin'])
    run('git', ['checkout', '--detach', targetTag])
  }
  const targetCommit = capture('git', ['rev-parse', '--short=12', 'HEAD'])
  writeState({
    phase: 'updating',
    targetVersion,
    targetTag: targetLabel,
    targetBranch: targetBranch || null,
    targetCommit,
    waitReason: 'Installing update.',
    logPath,
  })
  run('npm', ['ci'])
  run('npm', ['run', 'browsers:install'])
  run('npm', ['run', 'build'])

  writeState({ phase: 'restarting', targetCommit, waitReason: 'Restarting service.', logPath })
  restartService()

  writeState({
    phase: 'completed',
    completedAt: Date.now(),
    waitReason: 'Update installed and restart requested.',
    logPath,
  })
  log('Update completed.')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  writeState({
    phase: 'failed',
    failedAt: Date.now(),
    error: message,
    waitReason: 'Update failed.',
    logPath,
  })
  log(`Update failed: ${message}`)
  process.exitCode = 1
} finally {
  fs.closeSync(logFd)
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  return process.argv[index + 1] || null
}

function normalizeVersion(value) {
  if (!value) return null
  const match = String(value).trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)
  return match?.[1] || null
}

function assertSafeBranchName(value) {
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    console.error(`Invalid --target-branch: ${value || '(empty)'}`)
    process.exit(2)
  }
}

function readPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'))
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : targetVersion
  } catch {
    return targetVersion
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'))
  } catch {
    const targetLabel = targetTag || `branch:${targetBranch}`
    return {
      id: jobId,
      phase: 'updating',
      targetVersion,
      targetTag: targetLabel,
      targetBranch: targetBranch || null,
      queuedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }
}

function writeState(patch) {
  const previous = readState()
  const targetLabel = targetTag || `branch:${targetBranch}`
  const next = {
    ...previous,
    id: jobId,
    targetVersion,
    targetTag: targetLabel,
    targetBranch: targetBranch || null,
    ...patch,
    updatedAt: Date.now(),
  }
  // Atomic replace: a crash mid-write must never leave a half-written state
  // file behind, since the app's update status endpoint reads it live.
  const tmpPath = `${statePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf-8')
  fs.renameSync(tmpPath, statePath)
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  fs.writeSync(logFd, line)
}

function run(command, args) {
  log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  return result.stdout.trim()
}

function assertCleanWorktree() {
  const status = capture('git', ['status', '--porcelain'])
  if (status) {
    throw new Error('Working tree has local changes. Managed update requires a clean install.')
  }
}

function restartService() {
  if (process.env.ORCHESTRATOR_SKIP_RESTART === '1') {
    log('Skipping restart because ORCHESTRATOR_SKIP_RESTART=1.')
    return
  }

  const manager = process.env.ORCHESTRATOR_SERVICE_MANAGER
  if (manager === 'systemd' || (!manager && process.platform === 'linux')) {
    run('systemctl', ['--user', 'restart', 'orchestrator.service'])
    return
  }

  if (manager === 'launchd' || (!manager && process.platform === 'darwin')) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : capture('id', ['-u'])
    run('launchctl', ['kickstart', '-k', `gui/${uid}/com.horia.orchestrator`])
    return
  }

  throw new Error('No supported service manager is configured for restart.')
}
