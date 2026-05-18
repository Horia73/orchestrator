#!/usr/bin/env node
import path from 'path'
import { spawn } from 'child_process'

const projectDir = process.cwd()
const nextBin = path.join(
  projectDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'next.cmd' : 'next'
)

const host = resolveHost()
const port = process.env.ORCHESTRATOR_PORT || process.env.PORT || '3000'
const args = ['start', '-H', host, '-p', port, ...process.argv.slice(2)]

const child = spawn(nextBin, args, {
  cwd: projectDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
    ORCHESTRATOR_PORT: port,
    ORCHESTRATOR_HOST: host,
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', err => {
  console.error(err)
  process.exit(1)
})

function resolveHost() {
  if (process.env.ORCHESTRATOR_HOST) return process.env.ORCHESTRATOR_HOST
  if (process.env.NEXT_HOST) return process.env.NEXT_HOST
  if (process.env.HOST) return process.env.HOST

  const legacyHostname = process.env.HOSTNAME
  if (legacyHostname && isExplicitBindHost(legacyHostname)) return legacyHostname

  return '127.0.0.1'
}

function isExplicitBindHost(value) {
  const clean = value.trim().toLowerCase()
  return clean === 'localhost'
    || clean === '0.0.0.0'
    || clean === '::'
    || clean === '::1'
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean)
}
