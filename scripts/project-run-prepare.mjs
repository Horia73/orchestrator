#!/usr/bin/env node
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { resolveProjectRunsRoot } from './project-run-paths.mjs'

const projectDir = process.cwd()
const args = parseArgs(process.argv.slice(2))
const kind = stringArg('kind') || (stringArg('source') ? 'existing-git' : 'new')
const task = stringArg('task') || 'Project implementation run.'
const name = sanitizeName(stringArg('name') || stringArg('project-name') || 'project')
const template = stringArg('template') || (kind === 'new' ? 'empty' : null)
const runId = sanitizeRunId(stringArg('run-id') || `${kindSlug(kind)}-${name}-${timestamp()}-${randomUUID().slice(0, 8)}`)
const branch = sanitizeBranchName(stringArg('branch') || `agent/${runId}`)
const baseBranchArg = stringArg('base-branch')
const sourceArg = stringArg('source')
const remoteArg = stringArg('remote')
const scaffoldCommand = stringArg('scaffold-command')
const packageManagerArg = stringArg('package-manager')
const devCommandArg = stringArg('dev-command')
const testCommandArg = stringArg('test-command')
const buildCommandArg = stringArg('build-command')
const deployTarget = stringArg('deploy-target') || 'none'
const pushPolicy = stringArg('push-policy') || (kind === 'existing-git' ? 'agent-branch' : 'manual')
const portStart = intArg('port-start', 3101)
const portEnd = intArg('port-end', 3999)
const requestedPort = intArg('port', null)
const copyEnv = boolArg('copy-env')
const jsonOutput = boolArg('json')
const commandStdio = jsonOutput ? ['ignore', 'ignore', 'inherit'] : 'inherit'
const managedPreview = boolArg('managed-preview')

const stateRoot = resolveProjectRunsRoot(projectDir)
const runDir = path.join(stateRoot, runId)
const repoDir = path.join(runDir, 'repo')
const portStatePath = path.join(stateRoot, 'ports.json')

if (kind !== 'existing-git' && kind !== 'new') {
  fail('kind must be existing-git or new.')
}
if (kind === 'existing-git' && !sourceArg) {
  fail('existing-git runs require --source <git-url-or-local-path>.')
}
if (portStart < 1024 || portEnd < portStart || portEnd > 65535) {
  fail(`Invalid port range: ${portStart}-${portEnd}`)
}
if (requestedPort !== null && (requestedPort < portStart || requestedPort > portEnd)) {
  fail(`Requested port ${requestedPort} is outside ${portStart}-${portEnd}`)
}
if (fs.existsSync(runDir)) {
  fail(`Run directory already exists: ${runDir}`)
}

fs.mkdirSync(runDir, { recursive: true })

try {
  const prepared = kind === 'existing-git'
    ? prepareExistingGit()
    : prepareNewProject()

  const port = managedPreview ? await reservePort(requestedPort) : null
  const devUrl = port ? `http://127.0.0.1:${port}` : null
  const preview = managedPreview ? createPreviewMetadata(runId, runDir, devUrl) : null
  const hints = detectProjectHints(repoDir, {
    packageManager: packageManagerArg,
    devCommand: devCommandArg,
    testCommand: testCommandArg,
    buildCommand: buildCommandArg,
  })
  const instructionsPath = path.join(repoDir, 'PROJECT_RUN_INSTRUCTIONS.md')
  const statePath = path.join(runDir, 'run-state.json')

  excludeLocalFile(repoDir, 'PROJECT_RUN_INSTRUCTIONS.md')
  fs.writeFileSync(instructionsPath, buildInstructions({
    ...prepared,
    kind,
    task,
    runId,
    repoDir,
    projectDir,
    branch,
    port,
    devUrl,
    preview,
    template,
    deployTarget,
    pushPolicy,
    hints,
  }), 'utf-8')

  if (copyEnv) copyEnvFiles(prepared.envSourceDir)

  const coderPrompt = buildCoderPrompt({
    ...prepared,
    kind,
    task,
    repoDir,
    instructionsPath,
    port,
    devUrl,
    preview,
    template,
    deployTarget,
    pushPolicy,
    hints,
  })
  const state = {
    runId,
    name,
    kind,
    createdAt: new Date().toISOString(),
    projectDir,
    repoDir,
    branch,
    baseBranch: prepared.baseBranch,
    baseRef: prepared.baseRef,
    port,
    devUrl,
    preview,
    instructionsPath,
    task,
    template,
    source: prepared.source,
    sourceType: prepared.sourceType,
    sourcePath: prepared.sourcePath,
    sourceRemoteUrl: prepared.sourceRemoteUrl,
    sourceCurrentBranch: prepared.sourceCurrentBranch,
    sourceDirty: prepared.sourceDirty,
    clonedFrom: prepared.clonedFrom,
    remote: prepared.remote,
    deployTarget,
    pushPolicy,
    buildCommand: buildCommandArg || null,
    devCommand: devCommandArg || null,
    testCommand: testCommandArg || null,
    scaffoldCommand: scaffoldCommand || null,
    copyEnv,
    hints,
    status: 'prepared',
    pinned: false,
    coderPrompt,
  }
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')

  if (jsonOutput) {
    console.log(JSON.stringify(state, null, 2))
  } else {
    console.log(`Prepared project run ${runId}`)
    console.log(`Kind: ${kind}`)
    console.log(`Repo: ${repoDir}`)
    console.log(`Branch: ${branch}`)
    console.log(`Base: ${prepared.baseRef || '(none)'}`)
    console.log(`Managed preview: ${preview ? 'enabled' : 'disabled (standalone projects publish through /published-apps/<slug>/)'}`)
    if (preview) {
      console.log(`Port: ${port}`)
      console.log(`Dev URL: ${devUrl}`)
      console.log(`Preview base path: ${preview.basePath}`)
      console.log(`Preview URL: ${preview.publicUrl || preview.lanUrl || '(set ORCHESTRATOR_PUBLIC_URL or ORCHESTRATOR_LAN_ORIGIN to expose a /dev-preview link)'}`)
      console.log(`LAN URL: ${preview.lanUrl || '(no LAN origin configured)'}`)
    }
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

function prepareExistingGit() {
  const sourceInfo = resolveGitSource(sourceArg)
  let clonedFrom = sourceInfo.cloneUrl
  try {
    run('git', ['clone', sourceInfo.cloneUrl, repoDir])
  } catch (error) {
    if (!sourceInfo.path || sourceInfo.cloneUrl === sourceInfo.path) throw error
    fs.rmSync(repoDir, { recursive: true, force: true })
    console.warn(`Remote clone failed; falling back to local source checkout: ${sourceInfo.path}`)
    run('git', ['clone', sourceInfo.path, repoDir])
    clonedFrom = sourceInfo.path
  }

  const baseBranch = baseBranchArg
    || detectRemoteDefaultBranch(repoDir)
    || capture('git', ['branch', '--show-current'], { cwd: repoDir, optional: true })
    || sourceInfo.currentBranch
    || 'main'
  const baseRef = checkoutAgentBranch(repoDir, baseBranch, branch)

  return {
    source: sourceArg,
    sourceType: sourceInfo.type,
    sourcePath: sourceInfo.path,
    sourceRemoteUrl: sourceInfo.remoteUrl,
    sourceCurrentBranch: sourceInfo.currentBranch,
    sourceDirty: sourceInfo.dirty,
    clonedFrom,
    remote: capture('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, optional: true }) || null,
    baseBranch,
    baseRef,
    envSourceDir: sourceInfo.path,
  }
}

function prepareNewProject() {
  const baseBranch = baseBranchArg || 'main'
  fs.mkdirSync(repoDir, { recursive: true })

  if (scaffoldCommand) {
    runShell(scaffoldCommand
      .replaceAll('{repoDir}', shellQuote(repoDir))
      .replaceAll('{runDir}', shellQuote(runDir))
      .replaceAll('{name}', shellQuote(name)), {
      cwd: runDir,
      env: {
        ...process.env,
        PROJECT_RUN_DIR: runDir,
        PROJECT_REPO_DIR: repoDir,
        PROJECT_NAME: name,
      },
    })
  }

  fs.mkdirSync(repoDir, { recursive: true })
  if (!isOwnGitCheckout(repoDir)) {
    run('git', ['init', '-b', branch], { cwd: repoDir })
  } else {
    run('git', ['checkout', '-B', branch], { cwd: repoDir })
  }
  if (remoteArg && !capture('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, optional: true })) {
    run('git', ['remote', 'add', 'origin', remoteArg], { cwd: repoDir })
  }

  return {
    source: null,
    sourceType: 'new',
    sourcePath: null,
    sourceRemoteUrl: null,
    sourceCurrentBranch: null,
    sourceDirty: false,
    clonedFrom: null,
    remote: remoteArg || capture('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, optional: true }) || null,
    baseBranch,
    baseRef: null,
    envSourceDir: null,
  }
}

function checkoutAgentBranch(repoPath, baseBranch, targetBranch) {
  let baseRef = null
  if (baseBranch) {
    run('git', ['fetch', 'origin', baseBranch, '--tags'], { cwd: repoPath, optional: true })
    const remoteRef = `origin/${baseBranch}`
    if (capture('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoPath, optional: true })) {
      baseRef = remoteRef
    } else if (capture('git', ['rev-parse', '--verify', '--quiet', baseBranch], { cwd: repoPath, optional: true })) {
      baseRef = baseBranch
    }
  }

  if (!baseRef) baseRef = 'HEAD'
  run('git', ['checkout', '-B', targetBranch, baseRef], { cwd: repoPath })
  return baseRef
}

function resolveGitSource(source) {
  if (!looksLikeLocalPath(source)) {
    return {
      type: 'remote',
      cloneUrl: source,
      path: null,
      remoteUrl: source,
      currentBranch: null,
      dirty: false,
    }
  }

  const sourcePath = path.resolve(expandHome(source))
  if (!fs.existsSync(sourcePath)) fail(`Source path does not exist: ${sourcePath}`)
  const topLevel = capture('git', ['rev-parse', '--show-toplevel'], { cwd: sourcePath, optional: true })
  if (!topLevel) fail(`Source path is not a git checkout: ${sourcePath}`)

  const remoteUrl = capture('git', ['remote', 'get-url', 'origin'], { cwd: topLevel, optional: true }) || null
  return {
    type: 'local',
    cloneUrl: remoteUrl || topLevel,
    path: topLevel,
    remoteUrl,
    currentBranch: capture('git', ['branch', '--show-current'], { cwd: topLevel, optional: true }) || null,
    dirty: Boolean(capture('git', ['status', '--porcelain'], { cwd: topLevel, optional: true })),
  }
}

function detectRemoteDefaultBranch(repoPath) {
  const ref = capture('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoPath,
    optional: true,
  })
  return ref?.startsWith('origin/') ? ref.slice('origin/'.length) : null
}

function detectProjectHints(repoPath, overrides) {
  const packageJsonPath = path.join(repoPath, 'package.json')
  const scripts = {}
  let packageManager = overrides.packageManager || null
  let framework = null

  if (fs.existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      Object.assign(scripts, parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {})
      if (!packageManager && typeof parsed?.packageManager === 'string') {
        packageManager = parsed.packageManager.split('@')[0]
      }
      const deps = { ...(parsed?.dependencies || {}), ...(parsed?.devDependencies || {}) }
      if (deps.next) framework = 'next'
      else if (deps.vite) framework = 'vite'
    } catch {
      // Ignore malformed package metadata; coder can inspect manually.
    }
  }

  if (!packageManager) {
    if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm'
    else if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) packageManager = 'yarn'
    else if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) packageManager = 'bun'
    else if (fs.existsSync(packageJsonPath)) packageManager = 'npm'
  }

  return {
    packageManager,
    framework,
    scripts,
    devCommand: overrides.devCommand || null,
    testCommand: overrides.testCommand || null,
    buildCommand: overrides.buildCommand || null,
  }
}

function buildInstructions(values) {
  const packagePrefix = values.hints.packageManager || '<package-manager>'
  const devCommand = values.preview
    ? (values.hints.devCommand
      || (values.hints.framework === 'next'
        ? `${packagePrefix === 'npm' ? 'npx' : packagePrefix} next dev -H 127.0.0.1 -p ${values.port}`
        : null))
    : null
  const verificationHints = [
    values.hints.testCommand,
    values.hints.buildCommand,
    values.hints.scripts?.test ? `${packagePrefix} ${packagePrefix === 'npm' ? 'run ' : ''}test`.trim() : null,
    values.hints.scripts?.build ? `${packagePrefix} ${packagePrefix === 'npm' ? 'run ' : ''}build`.trim() : null,
  ].filter(Boolean)
  const basePathEnv = values.preview
    ? 'process.env.PREVIEW_BASE_PATH || process.env.PUBLISHED_BASE_PATH'
    : 'process.env.PUBLISHED_BASE_PATH'
  const basePathIntro = values.preview
    ? `This run has an explicit managed preview under \`${values.preview.basePath}/\`, and static publishes are served under \`/published-apps/<slug>/\`. Web apps MUST honour \`PREVIEW_BASE_PATH\` for preview and \`PUBLISHED_BASE_PATH\` for publish so assets/routes resolve under those subpaths.`
    : 'Durable static apps are served under `/published-apps/<slug>/` rather than `/`. Web apps that emit root-absolute assets/routes MUST honour `PUBLISHED_BASE_PATH` at build time so the published app works after the container restarts.'
  const basePathBlock = [
    values.preview
      ? '### Base-path contract (preview and publish)'
      : '### Base-path contract (published static apps)',
    '',
    basePathIntro,
    '',
    '```js',
    values.preview
      ? '// next.config.mjs - basePath/assetPrefix for managed preview or static publish'
      : '// next.config.mjs - basePath/assetPrefix for static publish',
    `const basePath = ${basePathEnv}`,
    'const nextConfig = {',
    '  ...(basePath ? { basePath, assetPrefix: basePath } : {}),',
    '}',
    'export default nextConfig',
    '```',
    '',
    '```js',
    values.preview
      ? '// vite.config.js - base from managed preview or static publish (trailing slash)'
      : '// vite.config.js - base from static publish (trailing slash)',
    `const basePath = ${basePathEnv}`,
    "export default { base: basePath ? basePath + '/' : '/' }",
    '```',
    '',
  ]
  const previewBlock = values.preview
    ? [
      '## Managed Preview',
      '',
      'This run was explicitly prepared with a managed, reverse-proxied dev preview. Do NOT start your own long-running dev server for this repo; the orchestrator owns its lifecycle via:',
      '',
      '```bash',
      `npm run project-run:run -- start --run-id ${values.runId} --health-path /`,
      `npm run project-run:run -- restart --run-id ${values.runId}`,
      `npm run project-run:run -- logs --run-id ${values.runId} --lines 200`,
      '```',
      '',
      'Assigned loopback dev URL (internal health checks only):',
      '',
      '```text',
      values.devUrl,
      '```',
      '',
      `The preview binds to \`127.0.0.1:${values.port}\` and is exposed through the live app at \`${values.preview.basePath}/\`${values.preview.publicUrl ? ` (public: ${values.preview.publicUrl})` : ''}${values.preview.lanUrl ? ` (LAN: ${values.preview.lanUrl})` : ''}. Never use port \`3000\` (the running Orchestrator app).`,
      '',
      'User-facing preview links:',
      values.preview.publicUrl ? `- Public preview URL: ${values.preview.publicUrl}` : '- Public preview URL: unavailable because ORCHESTRATOR_PUBLIC_URL is not configured.',
      values.preview.lanUrl ? `- LAN preview URL: ${values.preview.lanUrl}` : '- LAN preview URL: unavailable because no LAN origin is configured. In Docker/reverse-proxy installs, configure ORCHESTRATOR_LAN_ORIGIN rather than guessing a raw container port.',
      `- Loopback-only dev URL: ${values.devUrl} (internal diagnostics only).`,
      '',
      'When reporting to the orchestrator or user, include the LAN preview URL when present. Never report only a raw localhost/127.0.0.1 project URL.',
      '',
      ...basePathBlock,
      `The managed preview sets \`PREVIEW_BASE_PATH=${values.preview.basePath}\`, \`HOST=127.0.0.1\`, and \`PORT=${values.port}\` when it launches your dev command. If a framework needs a non-default dev command, the orchestrator can pass \`--dev-command\` to \`start\`.`,
      '',
      devCommand
        ? [
          'Detected dev command the managed preview will use by default:',
          '',
          '```bash',
          devCommand,
          '```',
          '',
        ].join('\n')
        : 'No dev command was auto-detected. Make sure a standard dev command exists (or tell the orchestrator to pass `--dev-command` to `start`).\n',
    ]
    : [
      '## Development Server Policy',
      '',
      'This standalone project run is not assigned a managed dev preview. Do not leave long-running dev servers behind, do not edit host nginx/systemd/Docker services on your own, and do not report raw localhost/127.0.0.1 links to the user.',
      '',
      'For user-facing static sites/apps, the durable surface is the Orchestrator-published URL returned by `publish-static`. Use package scripts, builds, and short-lived local checks as needed, then stop anything you start before returning.',
      '',
      ...basePathBlock,
    ]

  return [
    '# Project Run Instructions',
    '',
    `Task: ${values.task}`,
    '',
    '## Workspace Boundary',
    '',
    'Work only in this isolated repository:',
    '',
    '```text',
    values.repoDir,
    '```',
    '',
    `This workspace was prepared by Orchestrator from kind \`${values.kind}\`. Do not edit unrelated repositories or the Orchestrator live checkout unless explicitly asked.`,
    '',
    values.sourcePath
      ? [
        'Source checkout on the host:',
        '',
        '```text',
        values.sourcePath,
        '```',
        '',
        values.sourceDirty
          ? 'That source checkout had local uncommitted changes when this run was prepared. They are not part of this isolated run unless they were committed/pushed before cloning.'
          : 'The isolated run is based on committed git state, not on future local edits in that source checkout.',
        '',
      ].join('\n')
      : '',
    'Do not commit or push unless the orchestrator explicitly asks you to. Leave the repository in a commit-ready state by default.',
    '',
    `Push policy hint: \`${values.pushPolicy}\`. Deployment target hint: \`${values.deployTarget}\`. Treat these as policy inputs for the orchestrator gate, not as permission to push or deploy on your own.`,
    '',
    '## Git Preflight',
    '',
    'Before editing, confirm you are in the isolated repository and inspect branch/status:',
    '',
    '```bash',
    'git branch --show-current',
    'git status --short',
    'git status -sb',
    '```',
    '',
    'Do not pull, rebase, reset, stash, or discard local work unless the orchestrator explicitly asks you to.',
    '',
    ...previewBlock,
    '## Durable Static Publish',
    '',
    'If the finished project is a static web app/site (typical Vite quiz, dashboard, landing page, or exported Next.js app), the orchestrator can publish the verified build into the active profile workspace and serve it through the live Orchestrator reverse proxy:',
    '',
    '```bash',
    `npm run project-run:run -- publish-static --run-id ${values.runId} --slug <stable-app-slug>`,
    '```',
    '',
    'That command runs the build with `PUBLISHED_BASE_PATH=/published-apps/<slug>`, copies `dist/`, `out/`, or `build/` into `workspace/published-apps/<slug>/`, returns stable Public/LAN URLs such as `/published-apps/<slug>/`, and asks the host bridge to create a Tailscale Funnel scoped only to that same path. The final orchestrator response should include `lanUrl` and `tailscaleFunnelUrl` when present; if the Funnel URL is unavailable, it should report the returned status/error. Do not put interactive apps under `/files/`: that file route deliberately blocks script execution. Published static apps run without Orchestrator API/network permissions; if the project requires fetch/XHR/WebSocket calls, a backend, SSR server, database, secrets, cron, or paid deployment, report that it is not a static publish and ask the orchestrator for an explicit deployment target/policy instead of editing nginx or host services on your own.',
    '',
    '## Verification',
    '',
    'Inspect the project and choose the checks that match the change. Prefer existing package scripts, framework checks, and targeted smoke tests.',
    '',
    verificationHints.length
      ? [
        'Known verification commands:',
        '',
        ...verificationHints.flatMap(command => ['```bash', command, '```', '']),
      ].join('\n')
      : 'No verification command was detected at prepare time. Find the appropriate checks from the project files.',
    '',
    'If checks fail because of unrelated pre-existing errors, report the exact failures and still verify your changed area as narrowly as possible.',
    '',
    '## Final Report',
    '',
    'Return a concise report with:',
    '',
    '- files changed;',
    '- commands run;',
    '- public preview URL and LAN preview URL used, if any;',
    '- static published lanUrl and tailscaleFunnelUrl if the orchestrator published the build;',
    '- blockers or residual risks.',
    '',
  ].join('\n')
}

function buildCoderPrompt(values) {
  const previewLines = values.preview
    ? [
      `- Managed preview: enabled at ${values.preview.basePath}/ (orchestrator runs the dev server via \`project-run:run -- start\`; do not run your own long-running server)`,
      `- Assigned dev URL (loopback): ${values.devUrl}`,
      values.preview.publicUrl ? `- Managed preview public URL: ${values.preview.publicUrl}` : '- Managed preview public URL: unavailable because ORCHESTRATOR_PUBLIC_URL is not configured.',
      values.preview.lanUrl ? `- Managed preview LAN URL: ${values.preview.lanUrl}` : '- Managed preview LAN URL: unavailable because no LAN origin is configured.',
      `- Preview builds must honour PREVIEW_BASE_PATH=${values.preview.basePath}. Static-published apps must honour PUBLISHED_BASE_PATH=/published-apps/<slug>. See the instructions file.`,
    ]
    : [
      '- Managed preview: disabled for this standalone project run.',
      '- Durable user-facing target: /published-apps/<slug>/ via `project-run:run publish-static` after build/test verification.',
      '- Static-published apps must honour PUBLISHED_BASE_PATH=/published-apps/<slug>. The final publish returns lanUrl and, when Tailscale is ready, tailscaleFunnelUrl for the same path. Do not use /files for interactive apps and do not report raw localhost links as the final result.',
    ]

  return [
    `Task: ${values.task}`,
    '',
    `Work only in this isolated repository: ${values.repoDir}`,
    '',
    `Read and follow this file before changing anything: ${values.instructionsPath}`,
    '',
    'Run context:',
    `- Kind: ${values.kind}`,
    `- Branch: ${branch}`,
    `- Base: ${values.baseRef || values.baseBranch || '(new project)'}`,
    ...previewLines,
    `- Push policy hint: ${values.pushPolicy}`,
    `- Deployment target hint: ${values.deployTarget}`,
    values.clonedFrom ? `- Cloned from: ${values.clonedFrom}` : null,
    values.sourceRemoteUrl ? `- Remote source: ${values.sourceRemoteUrl}` : null,
    values.sourcePath ? `- Local source checkout: ${values.sourcePath}` : null,
    values.sourceDirty ? '- The local source checkout had uncommitted changes that are not included in this isolated clone.' : null,
    values.template ? `- Template hint: ${values.template}` : null,
    '- Before editing, run `git branch --show-current` and `git status --short` in the isolated repository.',
    '',
    'You own implementation and testing. Inspect the repo yourself, choose the needed commands, and fix failures you introduce. Do not leave long-running dev servers behind. For production-ready static apps, make the build portable under PUBLISHED_BASE_PATH so the orchestrator can publish it at /published-apps/<slug>/ after checks pass. If this run has an explicit managed preview, use its public/LAN URL for visual checks; otherwise rely on build/test plus static publish for user review.',
    '',
    'Do not commit or push unless explicitly asked. When done, report files changed, checks run, published lanUrl/tailscaleFunnelUrl if published, any managed public/LAN preview URL if used, and blockers/risks.',
  ].filter(Boolean).join('\n')
}

function createPreviewMetadata(runIdValue, runDirValue, devUrl) {
  const previewToken = randomBytes(24).toString('base64url')
  const previewBasePath = `/dev-preview/${encodeURIComponent(runIdValue)}`
  return {
    token: previewToken,
    basePath: previewBasePath,
    publicUrl: buildPublicPreviewUrl(previewBasePath, previewToken),
    lanUrl: buildLanPreviewUrl(previewBasePath, previewToken),
    localUrl: devUrl ? `${devUrl}${previewBasePath}/` : null,
    logPath: path.join(runDirValue, 'preview.log'),
    stateDir: path.join(runDirValue, 'preview-state'),
    status: 'prepared',
    pid: null,
  }
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

function kindSlug(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-')
}

function sanitizeRunId(value) {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) fail('run-id is empty after sanitization.')
  return clean.slice(0, 100)
}

function sanitizeName(value) {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean || 'project'
}

function sanitizeBranchName(value) {
  const clean = value.trim()
  if (
    !clean ||
    clean.startsWith('/') ||
    clean.endsWith('/') ||
    clean.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(clean)
  ) {
    fail(`Invalid branch name: ${value || '(empty)'}`)
  }
  return clean
}

function looksLikeLocalPath(value) {
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~')
    || fs.existsSync(path.resolve(value))
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function isOwnGitCheckout(cwd) {
  const topLevel = capture('git', ['rev-parse', '--show-toplevel'], { cwd, optional: true })
  return Boolean(topLevel && path.resolve(topLevel) === path.resolve(cwd))
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || projectDir,
    env: process.env,
    stdio: options.stdio || commandStdio,
    encoding: 'utf-8',
  })
  if (options.optional && result.status !== 0) return result
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  }
  return result
}

function runShell(command, options = {}) {
  const result = spawnSync(command, {
    cwd: options.cwd || projectDir,
    env: options.env || process.env,
    stdio: options.stdio || commandStdio,
    encoding: 'utf-8',
    shell: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`)
  }
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

function copyEnvFiles(sourceDir) {
  if (!sourceDir) return
  for (const name of ['.env', '.env.local']) {
    const source = path.join(sourceDir, name)
    const target = path.join(repoDir, name)
    if (!fs.existsSync(source) || fs.existsSync(target)) continue
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o600)
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
