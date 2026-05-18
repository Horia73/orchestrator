#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const projectDir = process.cwd()
const stateDir = path.join(projectDir, '.orchestrator')
const jobId = readArg('--job-id') || process.env.ORCHESTRATOR_UPDATE_JOB_ID || `manual-${Date.now()}`
const targetTag = readArg('--target-tag')
const targetVersion = readArg('--target-version') || normalizeVersion(targetTag) || targetTag
const statePath = path.join(stateDir, 'update-state.json')
const logPath = path.join(stateDir, `update-${jobId}.log`)

if (!targetTag || !targetVersion) {
  console.error('Missing --target-tag / --target-version')
  process.exit(2)
}

fs.mkdirSync(stateDir, { recursive: true })
const logFd = fs.openSync(logPath, 'a')

try {
  log(`Starting update ${jobId} -> ${targetTag}`)
  writeState({ phase: 'updating', startedAt: Date.now(), waitReason: 'Installing update.', logPath })

  assertCleanWorktree()
  run('git', ['fetch', '--tags', 'origin'])
  run('git', ['checkout', '--detach', targetTag])
  run('npm', ['ci'])
  run('npm', ['run', 'browsers:install'])
  run('npm', ['run', 'build'])

  writeState({ phase: 'restarting', waitReason: 'Restarting service.', logPath })
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

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'))
  } catch {
    return {
      id: jobId,
      phase: 'updating',
      targetVersion,
      targetTag,
      queuedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }
}

function writeState(patch) {
  const previous = readState()
  const next = {
    ...previous,
    id: jobId,
    targetVersion,
    targetTag,
    ...patch,
    updatedAt: Date.now(),
  }
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf-8')
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
