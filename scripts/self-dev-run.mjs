#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const projectDir = process.cwd()
const stateRoot = path.join(projectDir, '.orchestrator', 'project-runs')
const portStatePath = path.join(stateRoot, 'ports.json')
const argv = process.argv.slice(2)
const command = argv[0]
const args = parseArgs(argv.slice(1))
const jsonOutput = boolArg('json')

const commands = new Set(['status', 'commit', 'rebase', 'push', 'update', 'cleanup'])

if (!command || command === 'help' || command === '--help') usage(0)
if (!commands.has(command)) usage(1)

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})

async function main() {
  const mutable = command !== 'status'
  const context = loadRunContext({ requireExplicit: mutable })

  switch (command) {
    case 'status':
      return printStatus(context)
    case 'commit':
      return commitRun(context)
    case 'rebase':
      return rebaseRun(context)
    case 'push':
      return pushRun(context)
    case 'update':
      return updateRun(context)
    case 'cleanup':
      return cleanupRun(context)
    default:
      usage(1)
  }
}

function printStatus(context) {
  const info = collectStatus(context)
  output(info, [
    `Run: ${info.runId}`,
    `State: ${info.status}`,
    `Repo: ${info.repoDir}`,
    `Branch: ${info.branch || '(unknown)'}`,
    `HEAD: ${info.head || '(unknown)'}`,
    `Port: ${info.port || '(none)'}`,
    `Dev URL: ${info.devUrl || '(none)'}`,
    `Changed files: ${info.statusShort.length}`,
    '',
    info.statusShort.length ? info.statusShort.join('\n') : 'Working tree clean.',
    info.diffStat ? `\nDiff stat:\n${info.diffStat}` : '',
  ].filter(Boolean).join('\n'))
}

function commitRun(context) {
  assertRepoReady(context)
  assertExpectedBranch(context)

  const message = stringArg('message') || stringArg('m')
  if (!message) fail('commit requires --message "<message>".')

  const status = gitCapture(['status', '--porcelain'], { cwd: context.state.repoDir })
  if (!status) {
    updateRunState(context, { status: 'no-changes', lastCheckedAt: new Date().toISOString() })
    return output({ committed: false, reason: 'clean' }, 'No changes to commit.')
  }

  gitRun(['add', '-A'], { cwd: context.state.repoDir })
  gitRun(['commit', '-m', message], { cwd: context.state.repoDir })

  const commit = gitCapture(['rev-parse', '--short=12', 'HEAD'], { cwd: context.state.repoDir })
  updateRunState(context, {
    status: 'committed',
    commit,
    committedAt: new Date().toISOString(),
  })
  output({ committed: true, commit }, `Committed ${commit}.`)
}

function rebaseRun(context) {
  assertRepoReady(context)
  assertExpectedBranch(context)

  const base = stringArg('base') || context.state.baseRef
  if (!base) fail('rebase requires --base <ref> or a baseRef in run-state.json.')

  try {
    if (base.startsWith('origin/')) gitRun(['fetch', 'origin'], { cwd: context.state.repoDir })
    gitRun(['rebase', base], { cwd: context.state.repoDir })
  } catch (error) {
    updateRunState(context, {
      status: 'rebase-failed',
      rebaseBase: base,
      rebaseFailedAt: new Date().toISOString(),
    })
    throw error
  }

  const commit = gitCapture(['rev-parse', '--short=12', 'HEAD'], { cwd: context.state.repoDir })
  updateRunState(context, {
    status: 'rebased',
    rebaseBase: base,
    commit,
    rebasedAt: new Date().toISOString(),
  })
  output({ rebased: true, base, commit }, `Rebased on ${base}. HEAD is ${commit}.`)
}

function pushRun(context) {
  assertRepoReady(context)
  assertExpectedBranch(context)

  const remote = stringArg('remote') || 'origin'
  const targetBranch = stringArg('target-branch') || stringArg('target')
  if (!targetBranch) fail('push requires --target-branch <branch>.')
  validateBranchName(targetBranch)

  try {
    gitRun(['push', remote, `HEAD:${targetBranch}`], { cwd: context.state.repoDir })
  } catch (error) {
    updateRunState(context, {
      status: 'push-failed',
      pushRemote: remote,
      pushTargetBranch: targetBranch,
      pushFailedAt: new Date().toISOString(),
    })
    throw error
  }

  const commit = gitCapture(['rev-parse', '--short=12', 'HEAD'], { cwd: context.state.repoDir })
  updateRunState(context, {
    status: 'pushed',
    pushRemote: remote,
    pushTargetBranch: targetBranch,
    commit,
    pushedAt: new Date().toISOString(),
  })
  output({ pushed: true, remote, targetBranch, commit }, `Pushed ${commit} to ${remote}/${targetBranch}.`)
}

async function updateRun(context) {
  const branch = stringArg('branch') || stringArg('target-branch')
  if (!branch) fail('update requires --branch <branch>.')
  validateBranchName(branch)

  const url = stringArg('url') || 'http://127.0.0.1:3000/api/update/apply'
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'branch', branch }),
  })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // Keep non-JSON responses readable.
  }
  if (!response.ok) {
    updateRunState(context, {
      status: 'update-request-failed',
      updateBranch: branch,
      updateUrl: url,
      updateFailedAt: new Date().toISOString(),
    })
    fail(`Update request failed with HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }

  updateRunState(context, {
    status: 'update-requested',
    updateBranch: branch,
    updateUrl: url,
    updateRequestedAt: new Date().toISOString(),
  })
  output({ updateRequested: true, branch, url, response: body }, `Requested branch update from ${branch}.`)
}

function cleanupRun(context) {
  const force = boolArg('force')
  const deleteBranch = boolArg('delete-branch')
  const removeState = boolArg('remove-state')
  const repoDir = context.state.repoDir
  const linkedWorktree = isLinkedWorktree(repoDir)
  let deletedBranch = false

  if (fs.existsSync(repoDir)) {
    const status = gitCapture(['status', '--porcelain'], { cwd: repoDir, optional: true })
    if (status && !force) {
      fail('Worktree has uncommitted changes. Use --force only after deciding they can be discarded.')
    }
    if (linkedWorktree) {
      const commandArgs = ['worktree', 'remove']
      if (force) commandArgs.push('--force')
      commandArgs.push(repoDir)
      gitRun(commandArgs, { cwd: projectDir })
    } else {
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  }

  if (deleteBranch && context.state.branch && linkedWorktree) {
    gitRun(['branch', '-D', context.state.branch], { cwd: projectDir })
    deletedBranch = true
  }

  releasePort(context.state)

  if (removeState) {
    fs.rmSync(context.runDir, { recursive: true, force: true })
  } else {
    updateRunState(context, {
      status: 'cleaned',
      cleanedAt: new Date().toISOString(),
    })
  }

  output(
    {
      cleaned: true,
      removedRepo: true,
      removedLinkedWorktree: linkedWorktree,
      deletedBranch,
      removedState: removeState,
      releasedPort: context.state.port ?? null,
    },
    `Cleaned run ${context.state.runId}.`,
  )
}

function isLinkedWorktree(repoDir) {
  const resolved = path.resolve(repoDir)
  const raw = gitCapture(['worktree', 'list', '--porcelain'], { cwd: projectDir, optional: true })
  return raw.split('\n').some(line => {
    if (!line.startsWith('worktree ')) return false
    return path.resolve(line.slice('worktree '.length)) === resolved
  })
}

function loadRunContext(options) {
  const statePathArg = stringArg('state')
  const runIdArg = stringArg('run-id')

  if (!statePathArg && !runIdArg && options.requireExplicit) {
    fail('Pass --run-id <id> or --state <path> for this command.')
  }

  const statePath = statePathArg
    ? path.resolve(projectDir, statePathArg)
    : runIdArg
      ? path.join(stateRoot, runIdArg, 'run-state.json')
      : latestRunStatePath()

  if (!statePath) fail('No project run-state.json found.')
  const state = readJson(statePath)
  if (!state || typeof state !== 'object') fail(`Invalid run state: ${statePath}`)
  if (typeof state.runId !== 'string') fail(`Run state is missing runId: ${statePath}`)
  if (typeof state.repoDir !== 'string' || !path.isAbsolute(state.repoDir)) {
    fail(`Run state has invalid repoDir: ${statePath}`)
  }

  const runDir = path.dirname(statePath)
  return { state, statePath, runDir }
}

function latestRunStatePath() {
  if (!fs.existsSync(stateRoot)) return null
  const candidates = fs.readdirSync(stateRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(stateRoot, entry.name, 'run-state.json'))
    .filter(candidate => fs.existsSync(candidate))
    .map(candidate => {
      const state = readJson(candidate, { optional: true })
      const createdAt = typeof state?.createdAt === 'string' ? Date.parse(state.createdAt) : 0
      return { path: candidate, createdAt, mtimeMs: fs.statSync(candidate).mtimeMs }
    })
    .sort((a, b) => (b.createdAt || b.mtimeMs) - (a.createdAt || a.mtimeMs))
  return candidates[0]?.path ?? null
}

function collectStatus(context) {
  const repoDir = context.state.repoDir
  const exists = fs.existsSync(repoDir)
  return {
    runId: context.state.runId,
    status: context.state.status ?? 'unknown',
    statePath: context.statePath,
    repoDir,
    exists,
    branch: exists ? gitCapture(['branch', '--show-current'], { cwd: repoDir, optional: true }) : null,
    head: exists ? gitCapture(['rev-parse', '--short=12', 'HEAD'], { cwd: repoDir, optional: true }) : null,
    port: context.state.port ?? null,
    devUrl: context.state.devUrl ?? null,
    statusShort: exists
      ? splitLines(gitCapture(['status', '--short'], { cwd: repoDir, optional: true }))
      : [],
    diffStat: exists ? gitCapture(['diff', '--stat'], { cwd: repoDir, optional: true }) : '',
  }
}

function assertRepoReady(context) {
  const repoDir = context.state.repoDir
  if (!fs.existsSync(repoDir)) fail(`Worktree does not exist: ${repoDir}`)
  const inside = gitCapture(['rev-parse', '--is-inside-work-tree'], { cwd: repoDir, optional: true })
  if (inside !== 'true') fail(`Not a git checkout: ${repoDir}`)
}

function assertExpectedBranch(context) {
  if (boolArg('allow-branch-mismatch')) return
  const expected = context.state.branch
  if (!expected) return
  const actual = gitCapture(['branch', '--show-current'], { cwd: context.state.repoDir, optional: true })
  if (actual && actual !== expected) {
    fail(`Expected branch ${expected}, found ${actual}. Use --allow-branch-mismatch to override.`)
  }
}

function updateRunState(context, patch) {
  const next = { ...context.state, ...patch, updatedAt: new Date().toISOString() }
  const tmp = `${context.statePath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, context.statePath)
  context.state = next
}

function releasePort(state) {
  const portState = readJson(portStatePath, { optional: true }) ?? { version: 1, allocations: {} }
  if (!portState.allocations || typeof portState.allocations !== 'object') return

  for (const [port, allocation] of Object.entries(portState.allocations)) {
    const samePort = String(state.port ?? '') === port
    const sameRun = allocation?.runId === state.runId
    const sameRepo = allocation?.repoDir === state.repoDir
    if (samePort || sameRun || sameRepo) delete portState.allocations[port]
  }

  fs.mkdirSync(path.dirname(portStatePath), { recursive: true })
  const tmp = `${portStatePath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(portState, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, portStatePath)
}

function parseArgs(values) {
  const out = new Map()
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i]
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      out.set(raw.slice(2, eq), raw.slice(eq + 1))
      continue
    }
    const key = raw.slice(2)
    const next = values[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      i += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function stringArg(name) {
  const value = args.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function boolArg(name) {
  return args.get(name) === 'true'
}

function readJson(filePath, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    if (options.optional) return null
    throw error
  }
}

function splitLines(value) {
  return value ? value.split('\n').filter(Boolean) : []
}

function gitRun(commandArgs, options = {}) {
  const result = spawnSync('git', commandArgs, {
    cwd: options.cwd || projectDir,
    env: process.env,
    stdio: 'inherit',
    encoding: 'utf-8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result
}

function gitCapture(commandArgs, options = {}) {
  const result = spawnSync('git', commandArgs, {
    cwd: options.cwd || projectDir,
    env: process.env,
    stdio: ['ignore', 'pipe', options.optional ? 'ignore' : 'inherit'],
    encoding: 'utf-8',
  })
  if (result.error) {
    if (options.optional) return ''
    throw result.error
  }
  if (result.status !== 0) {
    if (options.optional) return ''
    throw new Error(`git ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result.stdout.trim()
}

function validateBranchName(value) {
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    fail(`Invalid branch name: ${value || '(empty)'}`)
  }
}

function output(json, text) {
  if (jsonOutput) {
    console.log(JSON.stringify(json, null, 2))
  } else {
    console.log(text)
  }
}

function usage(exitCode) {
  const prefix = process.env.npm_lifecycle_event
    ? `npm run ${process.env.npm_lifecycle_event} --`
    : 'node scripts/self-dev-run.mjs'
  const text = [
    'Usage:',
    `  ${prefix} status [--run-id <id>|--state <path>] [--json]`,
    `  ${prefix} commit --run-id <id> --message "<message>"`,
    `  ${prefix} rebase --run-id <id> [--base origin/master]`,
    `  ${prefix} push --run-id <id> --target-branch master`,
    `  ${prefix} update --run-id <id> --branch master [--url http://127.0.0.1:3000/api/update/apply]`,
    `  ${prefix} cleanup --run-id <id> [--delete-branch] [--force] [--remove-state]`,
  ].join('\n')
  if (exitCode === 0) {
    console.log(text)
  } else {
    console.error(text)
  }
  process.exit(exitCode)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
