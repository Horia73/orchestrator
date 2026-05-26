import fs from 'fs'
import path from 'path'

import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{
    runId: string
    path?: string[]
  }>
}

type RunState = {
  runId: string
  port?: unknown
  preview?: {
    token?: unknown
    basePath?: unknown
    status?: unknown
  }
}

type ProxyInit = RequestInit & {
  duplex?: 'half'
}

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

export async function GET(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function HEAD(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function POST(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function PUT(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

export async function OPTIONS(request: Request, context: RouteContext) {
  return proxyPreview(request, context)
}

async function proxyPreview(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params
  if (!isValidRunId(runId)) return textResponse('Invalid preview run id.', 400)

  const state = readRunState(runId)
  if (!state) return textResponse('Preview run not found.', 404)

  const token = typeof state.preview?.token === 'string' ? state.preview.token : ''
  if (!token) return textResponse('Preview token is not initialized. Start the preview first.', 409)

  const url = new URL(request.url)
  const queryToken = url.searchParams.get('preview_token') ?? ''
  const validQueryToken = constantTimeEqual(queryToken, token)
  const validCookieToken = constantTimeEqual(parseCookies(request.headers.get('cookie')).get(cookieName(runId)) ?? '', token)
  if (!validQueryToken && !validCookieToken) return textResponse('Preview token required.', 403)

  if (validQueryToken && (request.method === 'GET' || request.method === 'HEAD')) {
    url.searchParams.delete('preview_token')
    const headers = new Headers({ Location: `${url.pathname}${url.search}` })
    headers.append('Set-Cookie', previewCookie(runId, token, isSecureRequest(request, url)))
    return new Response(null, { status: 302, headers })
  }

  const port = Number(state.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    return textResponse('Preview run has an invalid port.', 409)
  }

  const upstreamUrl = new URL(request.url)
  upstreamUrl.protocol = 'http:'
  upstreamUrl.hostname = '127.0.0.1'
  upstreamUrl.port = String(port)
  upstreamUrl.searchParams.delete('preview_token')

  try {
    const init: ProxyInit = {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      cache: 'no-store',
      duplex: request.method === 'GET' || request.method === 'HEAD' ? undefined : 'half',
    }
    const upstream = await fetch(upstreamUrl, init as RequestInit)

    const headers = upstreamResponseHeaders(upstream.headers)
    headers.set('X-Orchestrator-Dev-Preview', runId)
    if (validQueryToken) {
      headers.append('Set-Cookie', previewCookie(runId, token, isSecureRequest(request, url)))
    }

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown upstream error.'
    return textResponse(`Preview server is not reachable on 127.0.0.1:${port}: ${message}`, 502)
  }
}

function readRunState(runId: string): RunState | null {
  const stateRoot = path.join(ORCHESTRATOR_STATE_DIR, 'project-runs')
  const statePath = path.join(stateRoot, runId, 'run-state.json')
  const resolved = path.resolve(statePath)
  if (!resolved.startsWith(`${path.resolve(stateRoot)}${path.sep}`)) return null

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as RunState
    return parsed?.runId === runId ? parsed : null
  } catch {
    return null
  }
}

function upstreamRequestHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  for (const name of HOP_BY_HOP_HEADERS) next.delete(name)
  next.delete('host')
  next.delete('content-length')
  next.delete('accept-encoding')
  next.delete('origin')
  next.delete('referer')
  next.set('X-Orchestrator-Preview-Proxy', '1')
  return next
}

function upstreamResponseHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  for (const name of HOP_BY_HOP_HEADERS) next.delete(name)
  next.delete('content-encoding')
  next.delete('content-length')
  return next
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>()
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

function previewCookie(runId: string, token: string, secure: boolean): string {
  return [
    `${cookieName(runId)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=86400',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

function isSecureRequest(request: Request, url: URL): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwardedProto === 'https' || url.protocol === 'https:'
}

function cookieName(runId: string): string {
  return `orchestrator_dev_preview_${runId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

function isValidRunId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value)
}

function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
