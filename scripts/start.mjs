#!/usr/bin/env node
import fs from 'fs'
import http from 'http'
import path from 'path'

import next from 'next'
import { WebSocket, WebSocketServer } from 'ws'

const projectDir = process.cwd()
const host = resolveHost()
const port = resolvePort()
const originHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host

process.env.PORT = String(port)
process.env.ORCHESTRATOR_PORT = String(port)
process.env.ORCHESTRATOR_HOST = host
process.env.__NEXT_PRIVATE_ORIGIN ??= `http://${originHost}:${port}`

const app = next({
  dev: false,
  dir: projectDir,
  hostname: host,
  port,
})

await app.prepare()

const handle = app.getRequestHandler()
const handleUpgrade = app.getUpgradeHandler()
const previewWebSocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
})

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[start] request failed', err)
    if (!res.headersSent) res.statusCode = 500
    if (!res.writableEnded) res.end('Internal Server Error')
  })
})

server.on('upgrade', (req, socket, head) => {
  const handled = maybeProxyPreviewUpgrade(req, socket, head)
  if (handled) return

  handleUpgrade(req, socket, head).catch((err) => {
    console.error('[start] upgrade failed', err)
    socket.destroy()
  })
})

server.listen(port, host, () => {
  console.log(`▲ Next.js custom server`)
  console.log(`- Local:         http://${originHost}:${port}`)
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.log(`- Network:       http://${host}:${port}`)
  }
  console.log(`✓ Ready`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    previewWebSocketServer.close()
    server.close(() => {
      app.close().finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(1), 5000).unref()
  })
}

server.on('error', (err) => {
  console.error(err)
  process.exit(1)
})

function maybeProxyPreviewUpgrade(req, socket, head) {
  const url = parseRequestUrl(req.url)
  const match = url?.pathname.match(/^\/dev-preview\/([^/?#]+)\/_next\/webpack-hmr$/)
  if (!match) return false

  const runId = decodePathSegment(match[1] ?? '')
  if (!isValidRunId(runId)) {
    writeSocketResponse(socket, 400, 'Invalid preview run id.')
    return true
  }

  const state = readRunState(runId)
  if (!state) {
    writeSocketResponse(socket, 404, 'Preview run not found.')
    return true
  }

  const token = typeof state.preview?.token === 'string' ? state.preview.token : ''
  if (!token) {
    writeSocketResponse(socket, 409, 'Preview token is not initialized.')
    return true
  }

  const queryToken = url.searchParams.get('preview_token') ?? ''
  const cookieToken = parseCookies(req.headers.cookie).get(cookieName(runId)) ?? ''
  if (!constantTimeEqual(queryToken, token) && !constantTimeEqual(cookieToken, token)) {
    writeSocketResponse(socket, 403, 'Preview token required.')
    return true
  }

  const previewPort = Number(state.port)
  if (!Number.isInteger(previewPort) || previewPort < 1024 || previewPort > 65535 || previewPort === port) {
    writeSocketResponse(socket, 409, 'Preview run has an invalid port.')
    return true
  }

  servePreviewHmrBootstrap({ runId, req, socket, head, previewPort })
  return true
}

function servePreviewHmrBootstrap({ runId, req, socket, head, previewPort }) {
  previewWebSocketServer.handleUpgrade(req, socket, head, (client) => {
    const nextVersion = readPreviewNextVersion(runId)
    const sessionId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    const send = (message) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
    }

    // Next's dev runtime waits for the initial Turbopack HMR sync before hydrating.
    send({ type: 'isrManifest', data: {} })
    send({ type: 'turbopack-connected', data: { sessionId } })
    send({
      type: 'sync',
      errors: [],
      warnings: [],
      hash: '',
      versionInfo: { staleness: 'fresh', installed: nextVersion },
      debug: {},
      devIndicator: { disabledUntil: 0 },
      devToolsConfig: {},
    })

    client.on('error', (err) => {
      console.warn(`[start] preview HMR client failed for ${runId} on ${previewPort}: ${err.message}`)
    })
  })
}

function readPreviewNextVersion(runId) {
  const packagePath = path.join(projectDir, '.orchestrator', 'project-runs', runId, 'repo', 'package.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))
    const version = parsed?.dependencies?.next ?? parsed?.devDependencies?.next
    return typeof version === 'string' && version.trim() ? version.replace(/^[^\d]*/, '') : 'unknown'
  } catch {
    return 'unknown'
  }
}

function readRunState(runId) {
  const stateRoot = path.join(projectDir, '.orchestrator', 'project-runs')
  const statePath = path.join(stateRoot, runId, 'run-state.json')
  const resolved = path.resolve(statePath)
  if (!resolved.startsWith(`${path.resolve(stateRoot)}${path.sep}`)) return null

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
    return parsed?.runId === runId ? parsed : null
  } catch {
    return null
  }
}

function writeSocketResponse(socket, status, message) {
  const reason = http.STATUS_CODES[status] ?? 'Error'
  const body = `${message}\n`
  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n')
  )
}

function parseRequestUrl(value) {
  try {
    return new URL(value || '/', 'http://preview.local')
  } catch {
    return null
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function parseCookies(header) {
  const out = new Map()
  if (!header) return out

  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    try {
      out.set(name, decodeURIComponent(value))
    } catch {
      out.set(name, value)
    }
  }
  return out
}

function cookieName(runId) {
  return `orchestrator_dev_preview_${runId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

function isValidRunId(value) {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value)
}

function constantTimeEqual(a, b) {
  const max = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

function resolvePort() {
  const raw = process.env.ORCHESTRATOR_PORT || process.env.PORT || '3000'
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid port: ${raw}`)
    process.exit(1)
  }
  return parsed
}

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
