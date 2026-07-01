import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-project-publish-'))

try {
  const prepare = runNode(
    path.join(repoRoot, 'scripts/project-run-prepare.mjs'),
    ['--kind', 'new', '--name', 'smoke-static', '--task', 'Smoke static publish', '--json'],
    { cwd: tempRoot }
  )
  const state = JSON.parse(prepare.stdout)
  assert.equal(state.name, 'smoke-static')
  assert.ok(state.runId)
  assert.equal(state.port, null)
  assert.equal(state.devUrl, null)
  assert.equal(state.preview, null)
  assert.match(state.coderPrompt, /publish-static/)
  assert.doesNotMatch(state.coderPrompt, /PREVIEW_BASE_PATH/)
  assert.ok(fs.existsSync(state.repoDir))

  fs.writeFileSync(
    path.join(state.repoDir, 'package.json'),
    `${JSON.stringify({ type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`
  )
  fs.writeFileSync(
    path.join(state.repoDir, 'build.mjs'),
    [
      "import fs from 'node:fs'",
      "const base = process.env.PUBLISHED_BASE_PATH || process.env.PREVIEW_BASE_PATH || ''",
      "fs.rmSync('dist', { recursive: true, force: true })",
      "fs.mkdirSync('dist/assets', { recursive: true })",
      "fs.writeFileSync('dist/index.html', `<div id=\"app\"></div><script type=\"module\" src=\"${base}/assets/app.js\"></script>`)",
      "fs.writeFileSync('dist/assets/app.js', `document.getElementById('app').textContent = 'published'`)",
      '',
    ].join('\n')
  )

  const publish = runNode(
    path.join(repoRoot, 'scripts/self-dev-run.mjs'),
    ['publish-static', '--run-id', state.runId, '--slug', 'smoke-static', '--json'],
    { cwd: tempRoot }
  )
  const result = JSON.parse(publish.stdout)
  assert.equal(result.published, true)
  assert.equal(result.slug, 'smoke-static')
  assert.equal(result.basePath, '/published-apps/smoke-static')
  assert.equal(result.tailscaleFunnelUrl, null)
  assert.equal(result.tailscaleFunnel.status, 'unavailable')
  assert.ok(result.path.endsWith(path.join('workspace', 'published-apps', 'smoke-static')))

  const indexPath = path.join(result.path, 'index.html')
  const assetPath = path.join(result.path, 'assets', 'app.js')
  const metadataPath = path.join(result.path, '.orchestrator-published-app.json')
  assert.ok(fs.existsSync(indexPath), 'published index exists')
  assert.ok(fs.existsSync(assetPath), 'published asset exists')
  assert.ok(fs.existsSync(metadataPath), 'published metadata exists')
  assert.match(fs.readFileSync(indexPath, 'utf-8'), /\/published-apps\/smoke-static\/assets\/app\.js/)

  process.env.ORCHESTRATOR_STATE_DIR = path.resolve(result.path, '..', '..', '..')
  const { listPublishedAppsForLibrary } = await import('@/lib/library/published-apps')
  const { getPublishedAppShare, upsertPublishedAppShare } = await import('@/lib/published-apps/shares')
  const publishedApps = listPublishedAppsForLibrary()
  const libraryEntry = publishedApps.find((entry) => entry.slug === 'smoke-static')
  assert.ok(libraryEntry, 'published app appears in Library index')
  assert.equal(libraryEntry?.basePath, '/published-apps/smoke-static')
  assert.equal(libraryEntry?.title, 'Smoke Static')

  const shareUrl = 'https://example.com/published-apps/smoke-static/'
  upsertPublishedAppShare({
    slug: 'smoke-static',
    profileId: 'admin_horia',
    funnelPath: '/published-apps/smoke-static',
    funnelUrl: shareUrl,
    access: 'public-origin',
  })
  assert.equal(getPublishedAppShare('smoke-static', { profileId: 'admin_horia' })?.funnelUrl, shareUrl)
  assert.equal(getPublishedAppShare('smoke-static', { profileId: 'member1' }), null)
  const shareStatePath = path.join(process.env.ORCHESTRATOR_STATE_DIR, 'published-app-shares.json')
  const shareState = JSON.parse(fs.readFileSync(shareStatePath, 'utf-8'))
  assert.ok(shareState.shares['admin_horia:smoke-static'], 'share is keyed by profile and slug')
  assert.equal(shareState.shares['smoke-static'], undefined, 'share is not written under a global slug key')
  const libraryEntryWithShare = listPublishedAppsForLibrary().find((entry) => entry.slug === 'smoke-static')
  assert.equal(libraryEntryWithShare?.shareUrl, shareUrl)
  assert.equal(libraryEntryWithShare?.shareAccess, 'public-origin')

  console.log('smoke-project-publish: OK')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

function runNode(script: string, args: string[], opts: { cwd: string }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ORCHESTRATOR_DOCKER_UPDATE_URL: '',
      ORCHESTRATOR_DOCKER_UPDATE_TOKEN: '',
      ORCHESTRATOR_HOST_UPDATE_URL: '',
      ORCHESTRATOR_HOST_UPDATE_TOKEN: '',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(script)} ${args.join(' ')} failed with ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    )
  }
  return result
}
