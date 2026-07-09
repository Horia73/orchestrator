#!/usr/bin/env node
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { resolveProjectRunsRoot } from './project-run-paths.mjs'

const projectDir = process.cwd()
const stateRoot = resolveProjectRunsRoot(projectDir)
const portStatePath = path.join(stateRoot, 'ports.json')
const argv = process.argv.slice(2)
const command = argv[0]
const args = parseArgs(argv.slice(1))
const jsonOutput = boolArg('json')

const commands = new Set(['status', 'start', 'stop', 'restart', 'preview', 'logs', 'seed', 'publish-static', 'commit', 'rebase', 'push', 'update', 'pin', 'unpin', 'cleanup'])
const PREVIEW_TOKEN_BYTES = 24
const PREVIEW_START_TIMEOUT_MS = 90_000
const PREVIEW_POLL_MS = 750
const LOG_TAIL_DEFAULT_LINES = 120

if (!command || command === 'help' || command === '--help') usage(0)
if (!commands.has(command)) usage(1)

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})

async function main() {
  const mutable = !['status', 'preview', 'logs'].includes(command)
  const context = loadRunContext({ requireExplicit: mutable })

  switch (command) {
    case 'status':
      return printStatus(context)
    case 'start':
      return startPreview(context)
    case 'stop':
      return stopPreview(context)
    case 'restart':
      await stopPreview(context, { quiet: true })
      return startPreview(context)
    case 'preview':
      return printPreview(context)
    case 'logs':
      return printLogs(context)
    case 'seed':
      return seedPreview(context)
    case 'publish-static':
      return await publishStatic(context)
    case 'commit':
      return commitRun(context)
    case 'rebase':
      return rebaseRun(context)
    case 'push':
      return pushRun(context)
    case 'update':
      return updateRun(context)
    case 'pin':
      return pinRun(context, true)
    case 'unpin':
      return pinRun(context, false)
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
    `Pinned: ${info.pinned ? 'yes' : 'no'}`,
    `Repo: ${info.repoDir}`,
    `Branch: ${info.branch || '(unknown)'}`,
    `HEAD: ${info.head || '(unknown)'}`,
    `Port: ${info.port || '(none)'}`,
    `Dev URL: ${info.devUrl || '(none)'}`,
    `Preview: ${info.preview.running ? 'running' : info.preview.status}`,
    info.preview.publicUrl ? `Preview URL: ${info.preview.publicUrl}` : null,
    info.preview.lanUrl ? `LAN URL: ${info.preview.lanUrl}` : null,
    info.preview.logPath ? `Preview log: ${info.preview.logPath}` : null,
    `Changed files: ${info.statusShort.length}`,
    '',
    info.statusShort.length ? info.statusShort.join('\n') : 'Working tree clean.',
    info.diffStat ? `\nDiff stat:\n${info.diffStat}` : '',
  ].filter(Boolean).join('\n'))
}

async function startPreview(context) {
  if (!supportsManagedPreview(context)) fail('Managed dev preview is not available for this run.')
  assertRepoReady(context)
  assertExpectedBranch(context)

  const port = Number(context.state.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    fail(`Run state has invalid preview port: ${context.state.port ?? '(missing)'}`)
  }

  let preview = ensurePreviewMetadata(context)
  const healthPath = normalizeHealthPath(stringArg('health-path') || preview.healthPath || '/')
  if (preview.healthPath !== healthPath) {
    updatePreviewState(context, { healthPath })
    preview = ensurePreviewMetadata(context)
  }

  const current = previewInfo(context)
  if (current.running) {
    try {
      await waitForPreview(context, port, preview.basePath, healthPath)
    } catch (error) {
      updatePreviewState(context, {
        status: 'unhealthy',
        pid: current.pid,
        checkedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    updatePreviewState(context, {
      status: 'running',
      pid: current.pid,
      checkedAt: new Date().toISOString(),
    })
    return output(previewOutput(context, { running: true }), previewSummary(context, true))
  }

  const selfRun = isSelfRun(context)

  // Self-development previews run a copy of the Orchestrator app and therefore
  // need a snapshot of live state plus the app's node_modules. Generic project
  // runs (new sites / external repos) just run the project's own dev server in
  // the prepared repo, so they skip both.
  if (selfRun) {
    const refreshState = boolArg('refresh-state')
    if (refreshState || !fs.existsSync(preview.stateDir)) {
      await snapshotPreviewState(context, preview.stateDir)
    } else {
      ensurePreviewStateDirs(preview.stateDir)
    }
    ensureNodeModulesLink(context)
  }

  await assertPortAvailable(port)

  fs.mkdirSync(path.dirname(preview.logPath), { recursive: true })
  const outFd = fs.openSync(preview.logPath, 'a')

  let child
  let commandLabel
  if (selfRun) {
    const nextBin = resolveNextBin(context)
    const commandArgs = ['dev', '--turbopack', '-H', '127.0.0.1', '-p', String(port)]
    commandLabel = `${nextBin} ${commandArgs.join(' ')}`
    child = spawn(nextBin, commandArgs, {
      cwd: context.state.repoDir,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: previewProcessEnv({ context, preview, port }),
    })
  } else {
    commandLabel = resolveProjectDevCommand(context, port)
    // shell:true so package-manager scripts (`npm run dev`, `pnpm dev`) work as
    // written; detached:true makes the child a process-group leader so stop can
    // reap the whole tree (npm/pnpm wrappers fork the real dev server).
    child = spawn(commandLabel, {
      cwd: context.state.repoDir,
      detached: true,
      shell: true,
      stdio: ['ignore', outFd, outFd],
      env: projectPreviewProcessEnv({ context, preview, port }),
    })
  }
  child.unref()
  fs.closeSync(outFd)

  updatePreviewState(context, {
    ...preview,
    status: 'starting',
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    healthPath,
    command: commandLabel,
  })

  try {
    await waitForPreview(context, port, preview.basePath, healthPath)
  } catch (error) {
    const alive = child.pid ? isPidAlive(child.pid) : false
    const detail = !selfRun ? await describeProjectPreviewFailure(port, preview.basePath) : ''
    updatePreviewState(context, {
      status: alive ? 'starting' : 'failed',
      checkedAt: new Date().toISOString(),
      lastError: `${error instanceof Error ? error.message : String(error)}${detail}`,
    })
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
  }

  updatePreviewState(context, {
    status: 'running',
    checkedAt: new Date().toISOString(),
  })
  output(previewOutput(context, { running: true }), previewSummary(context, true))
}

async function stopPreview(context, options = {}) {
  if (!supportsManagedPreview(context) && !context.state.preview) {
    if (!options.quiet) output({ runId: context.state.runId, running: false, status: 'unavailable' }, 'No managed preview is configured for this run.')
    return
  }
  const info = previewInfo(context)
  if (!info.pid || !info.running) {
    updatePreviewState(context, {
      status: 'stopped',
      pid: null,
      stoppedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
    })
    if (!options.quiet) output(previewOutput(context, { running: false }), `Preview for ${context.state.runId} is stopped.`)
    return
  }

  signalPreviewProcess(info.pid, 'SIGTERM')

  const stopped = await waitForPidExit(info.pid, 5000)
  if (!stopped && boolArg('force')) {
    signalPreviewProcess(info.pid, 'SIGKILL')
    await waitForPidExit(info.pid, 2000)
  } else if (!stopped) {
    updatePreviewState(context, {
      status: 'stop-failed',
      checkedAt: new Date().toISOString(),
      lastError: `PID ${info.pid} did not exit after SIGTERM.`,
    })
    fail(`Preview PID ${info.pid} did not exit. Re-run stop with --force if it can be killed.`)
  }

  updatePreviewState(context, {
    status: 'stopped',
    pid: null,
    stoppedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
  })
  if (!options.quiet) output(previewOutput(context, { running: false }), `Stopped preview for ${context.state.runId}.`)
}

function printPreview(context) {
  if (!supportsManagedPreview(context)) fail('Managed dev preview is not available for this run.')
  const info = previewOutput(context)
  output(info, previewSummary(context, info.running))
}

function printLogs(context) {
  if (!supportsManagedPreview(context)) fail('Managed dev preview is not available for this run.')
  const preview = ensurePreviewMetadata(context)
  const lines = intArg('lines', LOG_TAIL_DEFAULT_LINES)
  const body = tailFile(preview.logPath, Math.max(1, lines))
  output({ runId: context.state.runId, logPath: preview.logPath, lines, body }, body || `No preview log found at ${preview.logPath}.`)
}

async function seedPreview(context) {
  if (!supportsManagedPreview(context)) fail('Managed dev preview is not available for this run.')

  const preview = ensurePreviewMetadata(context)
  if (!fs.existsSync(preview.stateDir)) {
    await snapshotPreviewState(context, preview.stateDir)
  } else {
    ensurePreviewStateDirs(preview.stateDir)
  }

  const patches = []
  const profiles = splitCommaList(stringArg('profile'))
  for (const profile of profiles) {
    if (profile === 'location-intelligence') {
      patches.push(locationIntelligenceSeedPatch())
      continue
    }
    fail(`Unknown preview seed profile: ${profile}`)
  }

  const configJson = stringArg('config-json')
  if (configJson) patches.push(parseJsonObject(configJson, '--config-json'))

  const configPatch = stringArg('config-patch')
  if (configPatch) patches.push(readConfigPatch(configPatch, context))

  if (!patches.length) {
    fail('seed requires --profile location-intelligence, --config-json <json>, or --config-patch <path-or-json>.')
  }

  const configPath = path.join(preview.stateDir, 'workspace', 'config.json')
  const current = fs.existsSync(configPath) ? readJson(configPath) : {}
  if (!isPlainObject(current)) fail(`Preview config is not a JSON object: ${configPath}`)

  const next = patches.reduce((acc, patch) => deepMerge(acc, patch), current)
  next.updatedAt = Date.now()
  writeJsonAtomic(configPath, next)

  updatePreviewState(context, {
    seededAt: new Date().toISOString(),
    seedProfiles: profiles,
    configPath,
  })

  output(
    {
      runId: context.state.runId,
      stateDir: preview.stateDir,
      configPath,
      profiles,
      appliedPatches: patches.length,
    },
    [
      `Seeded preview state for ${context.state.runId}.`,
      profiles.length ? `Profiles: ${profiles.join(', ')}` : null,
      `Config: ${configPath}`,
    ].filter(Boolean).join('\n'),
  )
}

async function publishStatic(context) {
  if (isSelfRun(context)) fail('publish-static is for standalone project runs, not Orchestrator self-development.')
  assertRepoReady(context)
  assertExpectedBranch(context)

  const slug = sanitizePublishSlug(stringArg('slug') || context.state.name || context.state.runId)
  const publishedBasePath = `/published-apps/${slug}`
  const buildCommand = resolveProjectBuildCommand(context, publishedBasePath)

  runShellCommand(buildCommand, {
    cwd: context.state.repoDir,
    env: projectPublishProcessEnv({ publishedBasePath }),
  })

  const sourceDir = resolveStaticOutputDir(context)
  const indexPath = path.join(sourceDir, 'index.html')
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
    fail(`Static output must contain index.html: ${sourceDir}`)
  }

  const workspaceDir = resolvePublishWorkspaceDir(context)
  const rootDir = path.join(workspaceDir, 'published-apps')
  const destDir = path.join(rootDir, slug)
  const rootReal = ensureRealDir(rootDir)
  const destResolved = path.resolve(destDir)
  if (!isInside(rootReal, destResolved)) fail(`Refusing to publish outside ${rootReal}`)

  const tmpDir = path.join(rootDir, `.${slug}.tmp-${process.pid}-${Date.now()}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, tmpDir, {
    recursive: true,
    dereference: false,
    filter: (entry) => shouldCopyStaticPublishEntry(entry),
  })

  const profileId = inferPublishProfileId(context, workspaceDir)
  const metadata = {
    slug,
    runId: context.state.runId,
    profileId,
    sourceDir,
    repoDir: context.state.repoDir,
    buildCommand,
    basePath: publishedBasePath,
    publishedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(tmpDir, '.orchestrator-published-app.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8')

  fs.rmSync(destDir, { recursive: true, force: true })
  fs.renameSync(tmpDir, destDir)

  const tailscaleFunnel = await maybeEnablePublishedAppFunnel(context, {
    slug,
    profileId,
  })

  const published = {
    ...metadata,
    path: destDir,
    publicUrl: buildPublicUrl(publishedBasePath),
    lanUrl: buildLanUrl(publishedBasePath),
    tailscaleFunnelUrl: tailscaleFunnel.url,
    tailscaleFunnel,
  }
  updateRunState(context, {
    status: 'published-static',
    published,
  })

  output(
    { published: true, ...published },
    [
      `Published static app ${slug}.`,
      `Path: ${destDir}`,
      `URL: ${published.publicUrl || published.lanUrl || `${publishedBasePath}/`}`,
      published.lanUrl ? `LAN URL: ${published.lanUrl}` : 'LAN URL: unavailable; set ORCHESTRATOR_LAN_ORIGIN for Docker/reverse-proxy installs.',
      published.publicUrl ? `Public URL: ${published.publicUrl}` : 'Public URL: unavailable; set ORCHESTRATOR_PUBLIC_URL.',
      published.tailscaleFunnelUrl ? `Tailscale Funnel URL: ${published.tailscaleFunnelUrl}` : `Tailscale Funnel URL: unavailable; ${tailscaleFunnel.error || 'host bridge or Tailscale is not ready.'}`,
    ].join('\n'),
  )
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

async function cleanupRun(context) {
  const force = boolArg('force')
  const deleteBranch = boolArg('delete-branch')
  const removeState = boolArg('remove-state')
  const repoDir = context.state.repoDir
  const worktreeControlDir = sourceControlDir(context)
  const linkedWorktree = isLinkedWorktree(repoDir, worktreeControlDir)
  let deletedBranch = false

  if ((context.state.pinned === true || fs.existsSync(path.join(context.runDir, '.orchestrator-keep'))) && !force) {
    fail('Run is pinned. Unpin it first, or use --force only after deciding it can be discarded.')
  }

  await stopPreview(context, { quiet: true })

  if (fs.existsSync(repoDir)) {
    const status = gitCapture(['status', '--porcelain'], { cwd: repoDir, optional: true })
    if (status && !force) {
      fail('Worktree has uncommitted changes. Use --force only after deciding they can be discarded.')
    }
    if (linkedWorktree) {
      const commandArgs = ['worktree', 'remove']
      if (force) commandArgs.push('--force')
      commandArgs.push(repoDir)
      gitRun(commandArgs, { cwd: worktreeControlDir })
    } else {
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  }

  if (deleteBranch && context.state.branch && linkedWorktree) {
    gitRun(['branch', '-D', context.state.branch], { cwd: worktreeControlDir })
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

function pinRun(context, pinned) {
  const now = new Date().toISOString()
  const note = stringArg('note')
  updateRunState(context, pinned
    ? {
        pinned: true,
        pinnedAt: now,
        pinNote: note || context.state.pinNote || null,
      }
    : {
        pinned: false,
        unpinnedAt: now,
        pinNote: null,
      })
  output(
    { runId: context.state.runId, pinned, pinNote: context.state.pinNote ?? null },
    `${pinned ? 'Pinned' : 'Unpinned'} run ${context.state.runId}.`,
  )
}

function sourceControlDir(context) {
  const candidates = [
    context.state.sourceDir,
    context.state.projectDir,
    projectDir,
  ].filter(value => typeof value === 'string' && value)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && gitCapture(['rev-parse', '--is-inside-work-tree'], { cwd: candidate, optional: true }) === 'true') {
      return candidate
    }
  }
  return projectDir
}

function isLinkedWorktree(repoDir, cwd) {
  const resolved = path.resolve(repoDir)
  const raw = gitCapture(['worktree', 'list', '--porcelain'], { cwd, optional: true })
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
  const preview = supportsManagedPreview(context)
    ? previewOutput(context)
    : { status: 'unavailable', running: false, pid: null, publicUrl: null, lanUrl: null, logPath: null }
  return {
    runId: context.state.runId,
    status: context.state.status ?? 'unknown',
    pinned: context.state.pinned === true,
    statePath: context.statePath,
    repoDir,
    exists,
    branch: exists ? gitCapture(['branch', '--show-current'], { cwd: repoDir, optional: true }) : null,
    head: exists ? gitCapture(['rev-parse', '--short=12', 'HEAD'], { cwd: repoDir, optional: true }) : null,
    port: context.state.port ?? null,
    devUrl: context.state.devUrl ?? null,
    preview,
    statusShort: exists
      ? splitLines(gitCapture(['status', '--short'], { cwd: repoDir, optional: true }))
      : [],
    diffStat: exists ? gitCapture(['diff', '--stat'], { cwd: repoDir, optional: true }) : '',
  }
}

function ensurePreviewMetadata(context) {
  if (!supportsManagedPreview(context)) {
    fail('Managed dev preview is not available for this run.')
  }
  const existing = context.state.preview && typeof context.state.preview === 'object'
    ? context.state.preview
    : {}
  const runId = context.state.runId
  const basePath = `/dev-preview/${encodeURIComponent(runId)}`
  const token = typeof existing.token === 'string' && existing.token
    ? existing.token
    : randomBytes(PREVIEW_TOKEN_BYTES).toString('base64url')
  const publicUrl = typeof existing.publicUrl === 'string' && existing.publicUrl
    ? existing.publicUrl
    : buildPublicPreviewUrl(basePath, token)
  const computedLanUrl = buildLanPreviewUrl(basePath, token)
  const lanUrl = computedLanUrl || (typeof existing.lanUrl === 'string' && existing.lanUrl ? existing.lanUrl : null)
  const preview = {
    token,
    basePath,
    publicUrl,
    lanUrl,
    localUrl: `http://127.0.0.1:${context.state.port}${basePath}/`,
    stateDir: typeof existing.stateDir === 'string' && path.isAbsolute(existing.stateDir)
      ? existing.stateDir
      : path.join(context.runDir, 'preview-state'),
    logPath: typeof existing.logPath === 'string' && path.isAbsolute(existing.logPath)
      ? existing.logPath
      : path.join(context.runDir, 'preview.log'),
    healthPath: normalizeHealthPath(typeof existing.healthPath === 'string' ? existing.healthPath : '/'),
    status: typeof existing.status === 'string' ? existing.status : 'prepared',
    pid: Number.isInteger(existing.pid) ? existing.pid : null,
  }
  const changed = JSON.stringify({ ...existing, updatedAt: undefined }) !== JSON.stringify({ ...existing, ...preview, updatedAt: undefined })
  if (changed) updatePreviewState(context, preview)
  return context.state.preview ?? preview
}

function supportsManagedPreview(context) {
  const kind = context.state.kind
  const preview = context.state.preview
  if (kind === 'self') return true
  return Boolean(preview && typeof preview === 'object' && typeof preview.basePath === 'string' && preview.basePath.startsWith('/dev-preview/'))
}

function isSelfRun(context) {
  return context.state.kind === 'self'
}

function updatePreviewState(context, patch) {
  const current = context.state.preview && typeof context.state.preview === 'object'
    ? context.state.preview
    : {}
  updateRunState(context, {
    preview: {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  })
}

function buildPublicPreviewUrl(basePath, token) {
  const origin = publicOrigin()
  if (!origin) return null
  const url = new URL(`${basePath}/`, origin)
  url.searchParams.set('preview_token', token)
  return url.toString()
}

function buildLanPreviewUrl(basePath, token) {
  const origin = lanOrigin()
  if (!origin) return null
  const url = new URL(`${basePath}/`, origin)
  url.searchParams.set('preview_token', token)
  return url.toString()
}

function buildPublicUrl(basePath) {
  const origin = publicOrigin()
  if (!origin) return null
  return new URL(`${basePath}/`, origin).toString()
}

function buildLanUrl(basePath) {
  const origin = lanOrigin()
  if (!origin) return null
  return new URL(`${basePath}/`, origin).toString()
}

async function maybeEnablePublishedAppFunnel(context, { slug, profileId }) {
  const pathPrefix = `/published-apps/${slug}`
  if (boolArg('no-funnel')) {
    return {
      status: 'disabled',
      url: null,
      path: pathPrefix,
      error: 'disabled by --no-funnel.',
    }
  }

  const endpoint = dockerBridgeEndpoint('remote-access/published-app-funnel')
  if (!endpoint) {
    return {
      status: 'unavailable',
      url: null,
      path: pathPrefix,
      error: 'host bridge is not configured.',
    }
  }

  let response
  let payload
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enable: true, slug }),
    })
    const text = await response.text()
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { output: text }
    }
  } catch (error) {
    return {
      status: 'failed',
      url: null,
      path: pathPrefix,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const funnelUrl = typeof payload?.funnelUrl === 'string' && payload.funnelUrl
    ? payload.funnelUrl
    : null
  if (!response.ok || payload?.ok !== true || !funnelUrl) {
    return {
      status: 'failed',
      url: null,
      path: pathPrefix,
      error: typeof payload?.error === 'string'
        ? payload.error
        : `host bridge returned HTTP ${response.status}.`,
      output: typeof payload?.output === 'string' ? payload.output : undefined,
    }
  }

  upsertPublishedAppShare(context, {
    slug,
    profileId,
    funnelPath: pathPrefix,
    funnelUrl,
  })

  return {
    status: 'enabled',
    url: funnelUrl,
    path: pathPrefix,
    error: null,
  }
}

function dockerBridgeEndpoint(segment) {
  const baseUrl = process.env.ORCHESTRATOR_DOCKER_UPDATE_URL
    || process.env.ORCHESTRATOR_HOST_UPDATE_URL
  const token = process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
    || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
  if (!baseUrl || !token) return null
  try {
    const parsed = new URL(baseUrl)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length > 0 && segments[segments.length - 1] === 'update') {
      segments[segments.length - 1] = segment
    } else {
      segments.push(segment)
    }
    parsed.pathname = `/${segments.join('/')}`
    return { url: parsed.toString(), token }
  } catch {
    return null
  }
}

function inferPublishProfileId(context, workspaceDir) {
  const configured = process.env.ORCHESTRATOR_PROFILE_ID
    || process.env.ORCHESTRATOR_ACTIVE_PROFILE_ID
  const normalized = normalizeProfileId(configured)
  if (normalized) return normalized

  const stateDir = resolveSourceStateDir(context)
  const stateReal = ensureRealDir(stateDir)
  const workspaceReal = ensureRealDir(workspaceDir)
  const defaultProfileId = normalizeProfileId(process.env.ORCHESTRATOR_DEFAULT_PROFILE_ID) || 'admin_horia'

  const adminWorkspace = path.join(stateReal, 'workspace')
  if (path.resolve(workspaceReal) === path.resolve(adminWorkspace)) return defaultProfileId

  const rel = path.relative(path.join(stateReal, 'profiles'), workspaceReal)
  const parts = rel.split(path.sep)
  if (parts.length === 2 && parts[1] === 'workspace') {
    return normalizeProfileId(parts[0]) || defaultProfileId
  }
  return defaultProfileId
}

function normalizeProfileId(value) {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(clean) ? clean : null
}

function upsertPublishedAppShare(context, share) {
  const statePath = path.join(resolveSourceStateDir(context), 'published-app-shares.json')
  const current = readJson(statePath, { optional: true })
  const state = current && typeof current === 'object' && current.version === 1
    ? current
    : { version: 1, shares: {} }
  const shares = state.shares && typeof state.shares === 'object' ? state.shares : {}
  const key = `${share.profileId}:${share.slug}`
  const scopedExisting = shares[key] && typeof shares[key] === 'object' ? shares[key] : null
  const legacyExisting = shares[share.slug] && typeof shares[share.slug] === 'object' ? shares[share.slug] : null
  const existing = scopedExisting || (
    legacyExisting?.profileId === share.profileId ? legacyExisting : {}
  )
  const now = new Date().toISOString()
  shares[key] = {
    slug: share.slug,
    profileId: share.profileId,
    enabled: true,
    access: 'tailscale-funnel',
    funnelPath: share.funnelPath,
    funnelUrl: share.funnelUrl,
    createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  }
  if (legacyExisting?.profileId === share.profileId) {
    delete shares[share.slug]
  }
  writeJsonAtomic(statePath, {
    version: 1,
    updatedAt: now,
    shares,
  })
}

function publicOrigin() {
  const raw = process.env.ORCHESTRATOR_PUBLIC_URL
    || process.env.ORCHESTRATOR_APP_URL
    || process.env.NEXT_PUBLIC_APP_URL
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).origin
  } catch {
    return null
  }
}

function lanOrigin() {
  const explicit = process.env.ORCHESTRATOR_LAN_ORIGIN
    || process.env.ORCHESTRATOR_HOST_LAN_ORIGIN
    || process.env.LAN_ORIGIN
  const parsedExplicit = parseOrigin(explicit)
  if (parsedExplicit) return parsedExplicit

  if (!canInferLanOrigin()) return null
  const host = process.env.ORCHESTRATOR_HOST_LAN_IP
    || process.env.LAN_IP
    || detectLanIpv4()
  if (!host) return null
  const port = appPort()
  return parseOrigin(`http://${host}:${port}`)
}

function appPort() {
  const raw = process.env.ORCHESTRATOR_APP_PORT
    || process.env.ORCHESTRATOR_PORT
    || process.env.PORT
    || '3000'
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 3000
}

function parseOrigin(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).origin
  } catch {
    return null
  }
}

function canInferLanOrigin() {
  const manager = String(process.env.ORCHESTRATOR_SERVICE_MANAGER || '').trim().toLowerCase()
  if (manager === 'docker') return false

  const bindHost = process.env.ORCHESTRATOR_HOST
    || process.env.NEXT_HOST
    || process.env.HOST
  if (bindHost) return !isLoopbackBindHost(bindHost)

  return process.env.NODE_ENV !== 'production'
}

function isLoopbackBindHost(value) {
  const clean = String(value).trim().replace(/^\[(.*)]$/, '$1').toLowerCase()
  return clean === 'localhost'
    || clean === '127.0.0.1'
    || clean === '::1'
}

function detectLanIpv4() {
  const candidates = []
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (!entries || isLikelyVirtualInterface(name)) continue
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address) continue
      if (entry.address.startsWith('169.254.')) continue
      candidates.push(entry.address)
    }
  }
  candidates.sort((a, b) => scoreLanIp(a) - scoreLanIp(b))
  return candidates[0] || null
}

function isLikelyVirtualInterface(name) {
  return /^(lo|docker|br-|veth|vmnet|vboxnet|utun|tun|tap|tailscale)/i.test(name)
}

function scoreLanIp(ip) {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 10
}

function previewInfo(context) {
  const preview = context.state.preview && typeof context.state.preview === 'object'
    ? context.state.preview
    : {}
  const pid = Number.isInteger(preview.pid) ? preview.pid : null
  return {
    pid,
    running: Boolean(pid && isPidAlive(pid)),
    status: typeof preview.status === 'string' ? preview.status : 'not-started',
  }
}

function previewOutput(context, overrides = {}) {
  const preview = ensurePreviewMetadata(context)
  const info = previewInfo(context)
  const running = overrides.running ?? info.running
  return {
    runId: context.state.runId,
    status: running ? 'running' : (preview.status ?? info.status),
    running,
    pid: running ? info.pid : null,
    port: context.state.port ?? null,
    localUrl: preview.localUrl,
    publicUrl: preview.publicUrl,
    lanUrl: preview.lanUrl,
    basePath: preview.basePath,
    // Exposed so the agent can build a dev-preview artifact (live mini-browser)
    // without parsing it back out of publicUrl/lanUrl.
    token: preview.token,
    healthPath: preview.healthPath ?? '/',
    stateDir: preview.stateDir,
    logPath: preview.logPath,
  }
}

function previewSummary(context, running) {
  const preview = ensurePreviewMetadata(context)
  return [
    `Preview for ${context.state.runId}: ${running ? 'running' : (preview.status || 'stopped')}`,
    `Local URL: ${preview.localUrl}`,
    preview.publicUrl ? `Public URL: ${preview.publicUrl}` : 'Public URL: unavailable; set ORCHESTRATOR_PUBLIC_URL to enable /dev-preview links.',
    preview.lanUrl ? `LAN URL: ${preview.lanUrl}` : 'LAN URL: unavailable; set ORCHESTRATOR_LAN_ORIGIN for Docker/reverse-proxy installs, or run the app on a LAN-reachable non-Docker host.',
    `Health: ${preview.healthPath ?? '/'}`,
    `Log: ${preview.logPath}`,
    `State: ${preview.stateDir}`,
  ].join('\n')
}

async function snapshotPreviewState(context, targetStateDir) {
  const sourceStateDir = resolveSourceStateDir(context)
  fs.rmSync(targetStateDir, { recursive: true, force: true })
  ensurePreviewStateDirs(targetStateDir)

  const sourceDb = path.join(sourceStateDir, 'data.db')
  const targetDb = path.join(targetStateDir, 'data.db')
  if (fs.existsSync(sourceDb)) {
    await backupSqliteDatabase(sourceDb, targetDb)
  }

  copyDirIfExists(path.join(sourceStateDir, 'workspace'), path.join(targetStateDir, 'workspace'))
  copyDirIfExists(path.join(sourceStateDir, 'uploads'), path.join(targetStateDir, 'uploads'))
  fs.mkdirSync(path.join(targetStateDir, 'private'), { recursive: true })
  try {
    fs.chmodSync(path.join(targetStateDir, 'private'), 0o700)
  } catch {
    // Some filesystems ignore chmod.
  }
}

function resolveSourceStateDir(context) {
  const candidates = [
    process.env.ORCHESTRATOR_STATE_DIR,
    context.state.appDir ? path.join(context.state.appDir, '.orchestrator') : null,
    path.join(projectDir, '.orchestrator'),
  ].filter(value => typeof value === 'string' && value)

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  }
  return path.join(projectDir, '.orchestrator')
}

function ensurePreviewStateDirs(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'uploads'), { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'private'), { recursive: true })
}

function splitCommaList(value) {
  if (!value) return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function locationIntelligenceSeedPatch() {
  const entityId = stringArg('entity-id') || stringArg('home-assistant-entity') || 'person.preview_user'
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(entityId)) {
    fail(`Invalid Home Assistant entity id for location-intelligence seed: ${entityId}`)
  }
  const label = stringArg('label') || 'Preview User'
  return {
    smartMonitor: {
      liveLocationSource: {
        provider: 'home-assistant',
        entityId,
        confirmedAt: Date.now(),
        ...(label ? { label } : {}),
      },
    },
  }
}

function readConfigPatch(value, context) {
  const candidates = [
    path.resolve(projectDir, value),
    path.resolve(context.state.repoDir, value),
  ]
  const filePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  const text = filePath ? fs.readFileSync(filePath, 'utf-8') : value
  return parseJsonObject(text, filePath ? `--config-patch ${filePath}` : '--config-patch')
}

function parseJsonObject(value, label) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`${label} must be a JSON object: ${detail}`)
  }
  if (!isPlainObject(parsed)) fail(`${label} must be a JSON object.`)
  return parsed
}

function deepMerge(base, patch) {
  const next = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = deepMerge(next[key], value)
    } else {
      next[key] = value
    }
  }
  return next
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function backupSqliteDatabase(source, target) {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 10_000 })
  try {
    await db.backup(target)
  } finally {
    db.close()
  }
}

function previewProcessEnv({ context, preview, port }) {
  const env = { ...process.env }

  for (const key of Object.keys(env)) {
    if (
      key.startsWith('__NEXT_') ||
      key.startsWith('NEXT_PRIVATE_') ||
      key === 'NEXT_RUNTIME' ||
      key === 'NEXT_DEPLOYMENT_ID'
    ) {
      delete env[key]
    }
  }

  return {
    ...env,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    __NEXT_PRIVATE_ORIGIN: `http://127.0.0.1:${port}`,
    PORT: String(port),
    ORCHESTRATOR_HOST: '127.0.0.1',
    ORCHESTRATOR_PORT: String(port),
    ORCHESTRATOR_PREVIEW: '1',
    ORCHESTRATOR_DISABLE_BACKGROUND: '1',
    ORCHESTRATOR_DISABLE_SCHEDULER: '1',
    ORCHESTRATOR_DISABLE_MONITORS: '1',
    ORCHESTRATOR_DISABLE_MICROSCRIPTS: '1',
    ORCHESTRATOR_DISABLE_UPDATE_CONFIRMATION: '1',
    ORCHESTRATOR_STATE_DIR: preview.stateDir,
    ORCHESTRATOR_PREVIEW_RUN_ID: context.state.runId,
    ORCHESTRATOR_PREVIEW_BASE_PATH: preview.basePath,
  }
}

// Environment for a generic project-run dev server. Unlike previewProcessEnv
// (which arms a sandboxed copy of the Orchestrator app), this passes only the
// loopback host/port and the reverse-proxy base path. A previewable web project
// is expected to honour PREVIEW_BASE_PATH (e.g. Next.js basePath/assetPrefix,
// Vite `base`) so its assets resolve under /dev-preview/<run-id>/.
function projectPreviewProcessEnv({ preview, port }) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('__NEXT_') ||
      key.startsWith('NEXT_PRIVATE_') ||
      key === 'NEXT_RUNTIME' ||
      key === 'NEXT_DEPLOYMENT_ID'
    ) {
      delete env[key]
    }
  }
  return {
    ...env,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    PREVIEW_PORT: String(port),
    PREVIEW_BASE_PATH: preview.basePath,
    PREVIEW_ASSET_PREFIX: preview.basePath,
    PREVIEW_PUBLIC_PATH: `${preview.basePath}/`,
  }
}

function projectPublishProcessEnv({ publishedBasePath }) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('__NEXT_') ||
      key.startsWith('NEXT_PRIVATE_') ||
      key === 'NEXT_RUNTIME' ||
      key === 'NEXT_DEPLOYMENT_ID'
    ) {
      delete env[key]
    }
  }
  return {
    ...env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PUBLISHED_BASE_PATH: publishedBasePath,
    PUBLISHED_ASSET_PREFIX: publishedBasePath,
    PUBLISHED_PUBLIC_PATH: `${publishedBasePath}/`,
    BASE_PATH: publishedBasePath,
    PUBLIC_URL: publishedBasePath,
  }
}

// Resolve the dev command for a project run: an explicit --dev-command (or the
// devCommand stored at prepare time) wins; otherwise fall back to a framework
// default derived from prepare-time hints. {port} and {basePath} placeholders
// are interpolated so callers can template the command.
function resolveProjectDevCommand(context, port) {
  const explicit = stringArg('dev-command') || (typeof context.state.devCommand === 'string' ? context.state.devCommand : null)
  if (explicit) return interpolateDevCommand(explicit, context, port)

  const hints = context.state.hints && typeof context.state.hints === 'object' ? context.state.hints : {}
  if (typeof hints.devCommand === 'string' && hints.devCommand.trim()) {
    return interpolateDevCommand(hints.devCommand, context, port)
  }
  const pm = typeof hints.packageManager === 'string' && hints.packageManager ? hints.packageManager : 'npm'
  const runner = pm === 'npm' ? 'npx' : pm
  const basePath = context.state.preview?.basePath || ''
  if (hints.framework === 'next') {
    return `${runner} next dev -H 127.0.0.1 -p ${port}`
  }
  if (hints.framework === 'vite') {
    return `${runner} vite --host 127.0.0.1 --port ${port} --base ${basePath}/`
  }
  fail(`No dev command is known for this project run. Pass --dev-command "<command that serves 127.0.0.1:${port} under PREVIEW_BASE_PATH=${basePath || '/dev-preview/<run-id>'}>".`)
}

function interpolateDevCommand(command, context, port) {
  return command
    .replaceAll('{port}', String(port))
    .replaceAll('{basePath}', context.state.preview?.basePath || '')
}

function resolveProjectBuildCommand(context, publishedBasePath) {
  const explicit = stringArg('build-command')
    || (typeof context.state.buildCommand === 'string' ? context.state.buildCommand : null)
    || (typeof context.state.hints?.buildCommand === 'string' ? context.state.hints.buildCommand : null)
  if (explicit) return interpolatePublishCommand(explicit, publishedBasePath)

  const hints = context.state.hints && typeof context.state.hints === 'object' ? context.state.hints : {}
  const scripts = hints.scripts && typeof hints.scripts === 'object' ? hints.scripts : {}
  if (typeof scripts.build === 'string') {
    const pm = typeof hints.packageManager === 'string' && hints.packageManager ? hints.packageManager : 'npm'
    return pm === 'npm' ? 'npm run build' : `${pm} build`
  }
  const livePackage = readLivePackageMetadata(context.state.repoDir)
  if (typeof livePackage.scripts.build === 'string') {
    const pm = livePackage.packageManager || (typeof hints.packageManager === 'string' && hints.packageManager ? hints.packageManager : 'npm')
    return pm === 'npm' ? 'npm run build' : `${pm} build`
  }
  fail('No build command is known for this project run. Pass --build-command "<static build command>".')
}

function interpolatePublishCommand(command, publishedBasePath) {
  return command
    .replaceAll('{publishedBasePath}', publishedBasePath)
    .replaceAll('{basePath}', publishedBasePath)
}

function resolveStaticOutputDir(context) {
  const explicit = stringArg('output-dir') || stringArg('out-dir')
  const candidates = explicit
    ? [explicit]
    : staticOutputCandidates(context)

  const resolvedCandidates = candidates.map(candidate =>
    path.resolve(context.state.repoDir, candidate)
  )
  const found = resolvedCandidates.find(candidate => {
    try {
      return fs.statSync(candidate).isDirectory()
        && fs.statSync(path.join(candidate, 'index.html')).isFile()
    } catch {
      return false
    }
  })
  if (found) return found
  fail(`Could not find a static build output containing index.html. Checked: ${resolvedCandidates.join(', ')}. Pass --output-dir <dir> if the project uses a custom output folder.`)
}

function staticOutputCandidates(context) {
  const hints = context.state.hints && typeof context.state.hints === 'object' ? context.state.hints : {}
  const candidates = []
  if (hints.framework === 'vite') candidates.push('dist')
  if (hints.framework === 'next') candidates.push('out')
  candidates.push('dist', 'out', 'build', 'public')
  return [...new Set(candidates)]
}

function readLivePackageMetadata(repoDir) {
  const packageJsonPath = path.join(repoDir, 'package.json')
  const out = { scripts: {}, packageManager: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    if (parsed?.scripts && typeof parsed.scripts === 'object') out.scripts = parsed.scripts
    if (typeof parsed?.packageManager === 'string' && parsed.packageManager.trim()) {
      out.packageManager = parsed.packageManager.split('@')[0]
    } else if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) {
      out.packageManager = 'pnpm'
    } else if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) {
      out.packageManager = 'yarn'
    } else if (fs.existsSync(path.join(repoDir, 'bun.lockb')) || fs.existsSync(path.join(repoDir, 'bun.lock'))) {
      out.packageManager = 'bun'
    }
  } catch {
    // Missing or malformed package.json: caller will fall back to explicit args.
  }
  return out
}

// Detached previews are process-group leaders; signal the whole group first so
// package-manager wrappers (npm/pnpm) don't orphan the underlying dev server,
// then fall back to the single pid.
function signalPreviewProcess(pid, signal) {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // No process group (or already gone) — fall back to the single pid.
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone; caller updates state.
  }
}

// When a project preview fails its base-path health check, probe the server
// root to distinguish "dev server never came up" from "dev server is up but is
// not serving under PREVIEW_BASE_PATH" (the most common misconfiguration).
async function describeProjectPreviewFailure(port, basePath) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { cache: 'no-store', redirect: 'manual' })
    if (response.status < 500) {
      return ` The dev server responded at http://127.0.0.1:${port}/ but not under ${basePath}/. Configure the framework base path from PREVIEW_BASE_PATH (Next.js: basePath + assetPrefix; Vite: base) so it serves under ${basePath}/.`
    }
  } catch {
    // Root not reachable either: the dev server likely never started. The base
    // error plus preview.log already cover that case.
  }
  return ''
}

function copyDirIfExists(source, target) {
  if (!fs.existsSync(source)) return
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: entry => path.basename(entry) !== '.DS_Store',
  })
}

function ensureNodeModulesLink(context) {
  const target = path.join(context.state.repoDir, 'node_modules')
  excludeLocalFile(context.state.repoDir, 'node_modules')
  if (fs.existsSync(target)) return

  const candidates = [
    context.state.appDir ? path.join(context.state.appDir, 'node_modules') : null,
    context.state.sourceDir ? path.join(context.state.sourceDir, 'node_modules') : null,
    path.join(projectDir, 'node_modules'),
  ].filter(Boolean)
  const source = candidates.find(candidate => fs.existsSync(candidate))
  if (!source) {
    fail('Cannot start preview: no node_modules directory found in appDir, sourceDir, or current project.')
  }
  fs.symlinkSync(source, target, 'dir')
  excludeLocalFile(context.state.repoDir, 'node_modules')
}

function excludeLocalFile(repoPath, relativePath) {
  const gitDir = gitCapture(['rev-parse', '--git-common-dir'], { cwd: repoPath, optional: true })
  if (!gitDir) return
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoPath, gitDir)
  const excludePath = path.join(absoluteGitDir, 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : ''
  const line = `/${relativePath}`
  if (!existing.split('\n').includes(line)) {
    fs.appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${line}\n`, 'utf-8')
  }
}

function resolveNextBin(context) {
  const binName = process.platform === 'win32' ? 'next.cmd' : 'next'
  const candidates = [
    path.join(context.state.repoDir, 'node_modules', '.bin', binName),
    context.state.appDir ? path.join(context.state.appDir, 'node_modules', '.bin', binName) : null,
    context.state.sourceDir ? path.join(context.state.sourceDir, 'node_modules', '.bin', binName) : null,
  ].filter(Boolean)
  const found = candidates.find(candidate => fs.existsSync(candidate))
  if (!found) fail('Cannot start preview: Next.js binary was not found.')
  return found
}

async function assertPortAvailable(port) {
  if (!(await isPortFree(port))) fail(`Preview port ${port} is already in use.`)
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

async function waitForPreview(context, port, basePath, healthPath) {
  const deadline = Date.now() + PREVIEW_START_TIMEOUT_MS
  const url = previewHealthUrl(port, basePath, healthPath)
  let lastError = ''

  while (Date.now() < deadline) {
    const pid = context.state.preview?.pid
    if (pid && !isPidAlive(pid)) {
      throw new Error(`Preview process ${pid} exited before becoming ready. Check ${context.state.preview?.logPath}.`)
    }
    try {
      const response = await fetch(url, { cache: 'no-store', redirect: 'follow' })
      if (response.status === 200) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(PREVIEW_POLL_MS)
  }

  throw new Error(`Preview did not become ready at ${url}: ${lastError || 'timeout'}`)
}

function previewHealthUrl(port, basePath, healthPath) {
  const cleanPath = normalizeHealthPath(healthPath)
  return `http://127.0.0.1:${port}${basePath}${cleanPath === '/' ? '/' : cleanPath}`
}

function normalizeHealthPath(value) {
  const raw = String(value || '/').trim()
  if (!raw) return '/'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//')) {
    fail('Health path must be a relative app path such as / or /api/config.')
  }
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  if (withSlash.startsWith('/dev-preview/')) {
    fail('Health path should be relative to the preview app, not include /dev-preview/<run-id>.')
  }
  const parsed = new URL(withSlash, 'http://preview.local')
  return `${parsed.pathname}${parsed.search}` || '/'
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await delay(200)
  }
  return !isPidAlive(pid)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tailFile(filePath, lines) {
  if (!fs.existsSync(filePath)) return ''
  const stat = fs.statSync(filePath)
  const readSize = Math.min(stat.size, 256 * 1024)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize)
    return buffer.toString('utf-8').split(/\r?\n/).slice(-lines).join('\n').trim()
  } finally {
    fs.closeSync(fd)
  }
}

function resolvePublishWorkspaceDir(context) {
  const fromEnv = process.env.ORCHESTRATOR_AGENT_WORKSPACE_DIR
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv
  return path.join(resolveSourceStateDir(context), 'workspace')
}

function sanitizePublishSlug(value) {
  const slug = String(value || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || 'app'
}

function ensureRealDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
  return fs.realpathSync.native(dirPath)
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function shouldCopyStaticPublishEntry(entry) {
  const name = path.basename(entry)
  if (name === '.DS_Store') return false
  if (name === '.git' || name === 'node_modules' || name === '.next' || name === '.turbo') {
    return false
  }
  return true
}

function runShellCommand(command, options = {}) {
  const result = spawnSync(command, {
    cwd: options.cwd || projectDir,
    env: { ...process.env, ...(options.env || {}) },
    shell: true,
    stdio: options.stdio || (jsonOutput ? ['ignore', 'ignore', 'inherit'] : 'inherit'),
    encoding: 'utf-8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`)
  }
  return result
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

function intArg(name, fallback) {
  const value = args.get(name)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function readJson(filePath, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    if (options.optional) return null
    throw error
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function splitLines(value) {
  return value ? value.split('\n').filter(Boolean) : []
}

function gitRun(commandArgs, options = {}) {
  const result = spawnSync('git', commandArgs, {
    cwd: options.cwd || projectDir,
    env: process.env,
    stdio: options.stdio || (jsonOutput ? ['ignore', 'ignore', 'inherit'] : 'inherit'),
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
    `  ${prefix} start --run-id <id> [--refresh-state] [--health-path /|/api/config] [--json]`,
    `  ${prefix} stop --run-id <id> [--force] [--json]`,
    `  ${prefix} restart --run-id <id> [--refresh-state] [--health-path /|/api/config] [--json]`,
    `  ${prefix} preview [--run-id <id>|--state <path>] [--json]`,
    `  ${prefix} logs [--run-id <id>|--state <path>] [--lines 120] [--json]`,
    `  ${prefix} seed --run-id <id> [--profile location-intelligence] [--config-json '{...}'|--config-patch <path-or-json>]`,
    `  ${prefix} publish-static --run-id <id> [--slug app-name] [--build-command "npm run build"] [--output-dir dist] [--no-funnel] [--json]`,
    `  ${prefix} commit --run-id <id> --message "<message>"`,
    `  ${prefix} rebase --run-id <id> [--base origin/master]`,
    `  ${prefix} push --run-id <id> --target-branch master`,
    `  ${prefix} update --run-id <id> --branch master [--url http://127.0.0.1:3000/api/update/apply]`,
    `  ${prefix} pin --run-id <id> [--note "keep reason"]`,
    `  ${prefix} unpin --run-id <id>`,
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
