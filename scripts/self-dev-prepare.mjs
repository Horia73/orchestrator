#!/usr/bin/env node
import fs from 'fs'
import net from 'net'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'

const appDir = process.cwd()
const args = parseArgs(process.argv.slice(2))
const projectDir = resolveSourceDir()
const currentBranch = capture('git', ['branch', '--show-current'], { optional: true }) || 'master'
const baseBranch = stringArg('base-branch') || currentBranch || 'master'
const baseRef = stringArg('base-ref') || `origin/${baseBranch}`
const runId = sanitizeRunId(stringArg('run-id') || `self-${timestamp()}-${randomUUID().slice(0, 8)}`)
const branch = sanitizeBranchName(stringArg('branch') || `agent/${runId}`)
const task = stringArg('task') || 'Orchestrator self-development run.'
const portStart = intArg('port-start', 3101)
const portEnd = intArg('port-end', 3199)
const requestedPort = intArg('port', null)
const copyEnv = boolArg('copy-env')
const jsonOutput = boolArg('json')
const commandStdio = jsonOutput ? ['ignore', 'ignore', 'inherit'] : 'inherit'

const stateRoot = path.join(appDir, '.orchestrator', 'project-runs')
const runDir = path.join(stateRoot, runId)
const repoDir = path.join(runDir, 'repo')
const portStatePath = path.join(stateRoot, 'ports.json')

if (!isGitCheckout(projectDir)) {
  fail(`${projectDir} is not a git checkout.`)
}
if (fs.existsSync(runDir)) {
  fail(`Run directory already exists: ${runDir}`)
}
if (portStart < 1024 || portEnd < portStart || portEnd > 65535) {
  fail(`Invalid port range: ${portStart}-${portEnd}`)
}
if (requestedPort !== null && (requestedPort < portStart || requestedPort > portEnd)) {
  fail(`Requested port ${requestedPort} is outside ${portStart}-${portEnd}`)
}

fs.mkdirSync(runDir, { recursive: true })

try {
  run('git', ['fetch', 'origin', baseBranch, '--tags'], { stdio: commandStdio })
  run('git', ['worktree', 'add', repoDir, '-b', branch, baseRef], { stdio: commandStdio })

  const port = await reservePort(requestedPort)
  const devUrl = `http://127.0.0.1:${port}`
  const instructionsPath = path.join(repoDir, 'SELF_DEV_INSTRUCTIONS.md')
  const statePath = path.join(runDir, 'run-state.json')

  excludeLocalFile(repoDir, 'SELF_DEV_INSTRUCTIONS.md')
  fs.writeFileSync(instructionsPath, buildInstructions({
    repoDir,
    appDir,
    sourceDir: projectDir,
    runId,
    branch,
    baseRef,
    port,
    devUrl,
    task,
  }), 'utf-8')

  if (copyEnv) copyEnvFiles(repoDir)

  const coderPrompt = buildCoderPrompt({
    repoDir,
    instructionsPath,
    port,
    devUrl,
    task,
  })
  const state = {
    runId,
    kind: 'self',
    createdAt: new Date().toISOString(),
    appDir,
    projectDir,
    sourceDir: projectDir,
    repoDir,
    branch,
    baseRef,
    port,
    devUrl,
    instructionsPath,
    task,
    copyEnv,
    status: 'prepared',
    coderPrompt,
  }
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')

  if (jsonOutput) {
    console.log(JSON.stringify(state, null, 2))
  } else {
    console.log(`Prepared self-dev run ${runId}`)
    console.log(`Repo: ${repoDir}`)
    console.log(`Branch: ${branch}`)
    console.log(`Base: ${baseRef}`)
    console.log(`Port: ${port}`)
    console.log(`Dev URL: ${devUrl}`)
    console.log(`Instructions: ${instructionsPath}`)
    console.log(`State: ${statePath}`)
    console.log('')
    console.log('Coder prompt:')
    console.log(coderPrompt)
  }
} catch (err) {
  fs.rmSync(runDir, { recursive: true, force: true })
  fail(err instanceof Error ? err.message : String(err))
}

function parseArgs(argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      out.set(raw.slice(2, eq), raw.slice(eq + 1))
      continue
    }
    const key = raw.slice(2)
    const next = argv[i + 1]
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

function intArg(name, fallback) {
  const value = args.get(name)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

function sanitizeRunId(value) {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) fail('run-id is empty after sanitization.')
  return clean.slice(0, 80)
}

function sanitizeBranchName(value) {
  const branch = value.trim()
  if (
    !branch ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    fail(`Invalid branch name: ${value || '(empty)'}`)
  }
  return branch
}

function isGitCheckout(cwd) {
  return capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd, optional: true }) === 'true'
}

function resolveSourceDir() {
  const candidates = [
    ['--source-dir', stringArg('source-dir')],
    ['ORCHESTRATOR_SELF_DEV_SOURCE_DIR', process.env.ORCHESTRATOR_SELF_DEV_SOURCE_DIR],
    ['ORCHESTRATOR_SOURCE_DIR', process.env.ORCHESTRATOR_SOURCE_DIR],
    ['default Docker source mount', '/orchestrator-source'],
    ['cwd', appDir],
  ]
  const seen = new Set()
  const attempts = []

  for (const [label, raw] of candidates) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) continue
    const candidate = path.resolve(expandHome(raw.trim()))
    if (seen.has(candidate)) continue
    seen.add(candidate)

    if (!fs.existsSync(candidate)) {
      attempts.push(`${label}: ${candidate} (missing)`)
      if (label === '--source-dir') break
      continue
    }

    const topLevel = captureAt('git', ['rev-parse', '--show-toplevel'], { cwd: candidate, optional: true })
    if (topLevel) return path.resolve(topLevel)
    attempts.push(`${label}: ${candidate} (not a git checkout)`)
    if (label === '--source-dir') break
  }

  fail([
    'No git source checkout found for self-development.',
    `Running app directory: ${appDir}`,
    `Checked: ${attempts.join('; ') || '(none)'}`,
    'In Docker installs, mount the host checkout and set ORCHESTRATOR_SELF_DEV_SOURCE_DIR to the mounted path, usually /orchestrator-source.',
  ].join('\n'))
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || projectDir,
    env: process.env,
    stdio: options.stdio || 'inherit',
    encoding: 'utf-8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result
}

function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
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
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result.stdout.trim()
}

function captureAt(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
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
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result.stdout.trim()
}

function expandHome(value) {
  if (value === '~') return process.env.HOME || value
  if (value.startsWith('~/')) return path.join(process.env.HOME || '', value.slice(2))
  return value
}

async function reservePort(preferredPort) {
  const state = readPortState()
  for (const port of Object.keys(state.allocations)) {
    const allocation = state.allocations[port]
    if (!allocation?.repoDir || fs.existsSync(allocation.repoDir)) continue
    delete state.allocations[port]
  }

  const candidates = preferredPort !== null
    ? [preferredPort]
    : Array.from({ length: portEnd - portStart + 1 }, (_, index) => portStart + index)

  for (const port of candidates) {
    if (port === 3000) continue
    if (state.allocations[String(port)]) continue
    if (!(await isPortFree(port))) continue
    state.allocations[String(port)] = {
      runId,
      repoDir,
      assignedAt: new Date().toISOString(),
    }
    writePortState(state)
    return port
  }
  if (preferredPort !== null) {
    throw new Error(`Requested port ${preferredPort} is not available`)
  }
  throw new Error(`No free port in ${portStart}-${portEnd}`)
}

function readPortState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(portStatePath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && parsed.allocations && typeof parsed.allocations === 'object') {
      return parsed
    }
  } catch {
    // Missing or corrupt state: rewrite below.
  }
  return { version: 1, allocations: {} }
}

function writePortState(state) {
  fs.mkdirSync(path.dirname(portStatePath), { recursive: true })
  const tmp = `${portStatePath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, portStatePath)
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function excludeLocalFile(repoPath, relativePath) {
  const gitDir = capture('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath })
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoPath, gitDir)
  const excludePath = path.join(absoluteGitDir, 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : ''
  const line = `/${relativePath}`
  if (!existing.split('\n').includes(line)) {
    fs.appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${line}\n`, 'utf-8')
  }
}

function copyEnvFiles(repoPath) {
  for (const name of ['.env', '.env.local']) {
    const source = path.join(projectDir, name)
    const target = path.join(repoPath, name)
    if (!fs.existsSync(source) || fs.existsSync(target)) continue
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o600)
  }
}

function buildInstructions(values) {
  return [
    '# Self Dev Instructions',
    '',
    `Task: ${values.task}`,
    '',
    '## Workspace Boundary',
    '',
    `Work only in this isolated repository:`,
    '',
    '```text',
    values.repoDir,
    '```',
    '',
    `Do not edit the source checkout:`,
    '',
    '```text',
    values.sourceDir,
    '```',
    '',
    values.appDir !== values.sourceDir
      ? [
        'Do not edit the running app directory either:',
        '',
        '```text',
        values.appDir,
        '```',
        '',
      ].join('\n')
      : '',
    'Do not commit or push. Leave the repository in a commit-ready state; the orchestrator performs the final gate, commit, rebase, push, and update.',
    '',
    '## Git Preflight',
    '',
    'Before editing, confirm you are in the isolated worktree and inspect branch/status:',
    '',
    '```bash',
    'git branch --show-current',
    'git status --short',
    'git status -sb',
    '```',
    '',
    'Do not pull, rebase, reset, stash, or discard local work unless the orchestrator explicitly asks you to.',
    '',
    '## Development Server',
    '',
    'Port 3000 is reserved for the live Orchestrator app.',
    '',
    'Do not run `npm run dev` in this repository because this project script kills port 3000 before starting.',
    '',
    'If you need a Next.js dev server, run:',
    '',
    '```bash',
    `npx next dev --turbopack -H 127.0.0.1 -p ${values.port}`,
    '```',
    '',
    `Use this URL for testing: ${values.devUrl}`,
    '',
    'For non-Next tools, bind to `127.0.0.1` and use the assigned port. Do not use port 3000.',
    '',
    'Stop any dev server you started before returning.',
    '',
    '## Verification',
    '',
    'Inspect the codebase and choose the right checks. For this repository, run at least:',
    '',
    '```bash',
    'npm run typecheck',
    'npm run build',
    '```',
    '',
    'Run targeted smoke tests for touched subsystems when they exist.',
    '',
    'If checks fail because of unrelated pre-existing errors, report the exact failures and still verify your changed area as narrowly as possible.',
    '',
    '## Final Report',
    '',
    'Return a concise report with:',
    '',
    '- files changed;',
    '- commands run;',
    '- dev URL used, if any;',
    '- blockers or residual risks.',
    '',
  ].join('\n')
}

function buildCoderPrompt(values) {
  return [
    `Task: ${values.task}`,
    '',
    `Work only in this isolated worktree: ${values.repoDir}`,
    '',
    `Read and follow this file before changing anything: ${values.instructionsPath}`,
    '',
    'Hard boundaries:',
    `- Do not modify the source checkout ${projectDir}.`,
    ...(appDir !== projectDir ? [`- Do not modify the running app directory ${appDir}.`] : []),
    '- Before editing, run `git branch --show-current` and `git status --short` in the isolated worktree.',
    '- Do not commit or push.',
    '- Do not use port 3000.',
    '- Do not run `npm run dev`; if you need a Next.js dev server, use:',
    `  npx next dev --turbopack -H 127.0.0.1 -p ${values.port}`,
    `- Test URL: ${values.devUrl}`,
    '',
    'You own implementation and testing. Inspect the repo yourself, choose the needed checks, fix failures you introduce, and stop any dev server before returning.',
    '',
    'When done, report files changed, checks run, dev URL used if any, and blockers/risks.',
  ].join('\n')
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
