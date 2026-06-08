#!/usr/bin/env node
import { spawn } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'

import next from 'next'

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

// Next's public request handler is the only path that includes static asset
// serving for /_next/static/* (the inner server.getRequestHandler() returns
// an unwrapped handler that 404s static chunks in production). Trip the
// internal guard so Next does not auto-register its own 'upgrade' listener
// on the first request — we own upgrade dispatch below so preview HMR sockets
// reach our proxy before Next treats them as app routes and closes them.
app.didWebSocketSetup = true
const handle = app.getRequestHandler()
const handleUpgrade = app.getUpgradeHandler()

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

// Warm LibreOffice daemon for in-app PowerPoint preview. unoserver keeps a
// headless soffice running so /api/uploads/[id]/preview-pdf converts in ~1-2s
// instead of paying the ~10s cold start on every first open. Absent (local
// dev / no LibreOffice) it disables itself silently and the route returns 503.
const office = startLibreOfficeDaemon()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    office.stop()
    server.close(() => {
      app.close().finally(() => process.exit(0))
    })
    setTimeout(() => process.exit(1), 5000).unref()
  })
}

function startLibreOfficeDaemon() {
  if (process.env.ORCHESTRATOR_DISABLE_OFFICE_PREVIEW === '1') return { stop() {} }
  let child = null
  let stopped = false
  let attempts = 0

  const spawnDaemon = () => {
    if (stopped) return
    const proc = spawn('unoserver', ['--interface', '127.0.0.1', '--port', '2003'], {
      stdio: 'ignore',
    })
    child = proc
    proc.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        stopped = true
        console.log('[start] unoserver not installed — PowerPoint preview disabled')
        return
      }
      console.error('[start] unoserver error', err)
    })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      if (stopped) return
      attempts += 1
      const delay = Math.min(30000, 1000 * Math.min(attempts, 10))
      console.error(`[start] unoserver exited (code=${code}, signal=${signal}); restarting in ${delay}ms`)
      setTimeout(spawnDaemon, delay).unref()
    })
    // Reset the backoff only if *this* daemon stays up for a healthy stretch —
    // identity check so a prior spawn's timer can't reset for a newer child.
    setTimeout(() => { if (child === proc && !proc.killed) attempts = 0 }, 60000).unref()
  }

  spawnDaemon()
  return {
    stop() {
      stopped = true
      if (child) { try { child.kill('SIGTERM') } catch { /* already gone */ } }
    },
  }
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

  proxyUpgradeToPreview({ req, socket, head, upstreamPath: `${url.pathname}${url.search}`, previewPort })
  return true
}

function proxyUpgradeToPreview({ req, socket, head, upstreamPath, previewPort }) {
  socket.pause()

  const upstream = net.connect({ host: '127.0.0.1', port: previewPort })
  let bridged = false

  const fail = (status, message) => {
    if (!bridged && !socket.destroyed) writeSocketResponse(socket, status, message)
    upstream.destroy()
  }

  upstream.once('connect', () => {
    bridged = true
    upstream.write(buildUpgradeRequest(req, upstreamPath, previewPort))
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
    socket.resume()
  })

  upstream.once('error', (err) => {
    if (bridged) {
      if (!socket.destroyed) socket.destroy(err)
      return
    }
    fail(502, `Preview WebSocket upstream failed: ${err.message}`)
  })

  upstream.once('close', () => {
    if (!socket.destroyed && !socket.writableEnded) socket.end()
  })
  socket.once('error', () => {
    upstream.destroy()
  })
  socket.once('close', () => {
    upstream.destroy()
  })
}

function buildUpgradeRequest(req, upstreamPath, previewPort) {
  const upstreamUrl = parseRequestUrl(upstreamPath)
  upstreamUrl?.searchParams.delete('preview_token')
  const sanitizedPath = upstreamUrl ? `${upstreamUrl.pathname}${upstreamUrl.search}` : upstreamPath
  const lines = [
    `${req.method || 'GET'} ${sanitizedPath} HTTP/${req.httpVersion}`,
    `Host: 127.0.0.1:${previewPort}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Origin: http://127.0.0.1:${previewPort}`,
  ]

  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'upgrade' ||
      lower === 'origin' ||
      lower === 'cookie' ||
      lower === 'content-length' ||
      lower === 'transfer-encoding'
    ) {
      continue
    }

    if (
      !lower.startsWith('sec-websocket-') &&
      lower !== 'cache-control' &&
      lower !== 'pragma' &&
      lower !== 'user-agent'
    ) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else if (value != null) {
      lines.push(`${name}: ${value}`)
    }
  }

  return `${lines.join('\r\n')}\r\n\r\n`
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
