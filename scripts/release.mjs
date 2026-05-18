#!/usr/bin/env node
import fs from 'fs'
import { spawnSync } from 'child_process'

const releaseType = process.argv[2]
const allowed = new Set(['patch', 'minor', 'major'])

if (!allowed.has(releaseType)) {
  console.error('Usage: node scripts/release.mjs {patch|minor|major}')
  process.exit(2)
}

const status = capture('git', ['status', '--porcelain'])
if (status) {
  console.error('Working tree is not clean. Commit or stash changes before releasing.')
  console.error(status)
  process.exit(1)
}
run('npm', ['run', 'typecheck'])
run('npm', ['run', 'lint'])
run('npm', ['run', 'build'])
run('npm', ['version', releaseType, '--no-git-tag-version'])

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
const version = pkg.version
const tag = `v${version}`
const branch = capture('git', ['branch', '--show-current']) || 'master'

run('git', ['add', 'package.json', 'package-lock.json'])
run('git', ['commit', '-m', `release: ${tag}`])
run('git', ['tag', '-a', tag, '-m', tag])
run('git', ['push', 'origin', branch])
run('git', ['push', 'origin', tag])

console.log(`Released ${tag}. Create or verify the GitHub Release for this tag.`)

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}
