import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'

import { runWithRequestProfile } from '@/lib/profiles/server'
import {
  contentTypeFor,
  resolveServableWorkspaceFile,
} from '@/lib/workspace-files-resolve'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{
    path?: string[]
  }>
}

const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml'])

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function inlineContentDisposition(filename: string): string {
  const fallback =
    filename
      .replace(/[^\x20-\x7E]+/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'file'
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

function directContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (HTML_EXTENSIONS.has(ext)) return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  return contentTypeFor(filePath)
}

function htmlPreviewCsp(): string {
  return [
    'sandbox allow-downloads allow-popups',
    "default-src 'none'",
    "img-src 'self' data: blob: https: http:",
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "script-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export async function GET(request: Request, context: RouteContext) {
  return serveWorkspaceFile(request, context, false)
}

export async function HEAD(request: Request, context: RouteContext) {
  return serveWorkspaceFile(request, context, true)
}

async function serveWorkspaceFile(
  request: Request,
  context: RouteContext,
  headOnly: boolean
): Promise<Response> {
  const params = await context.params
  const relativePath = params.path?.join('/') ?? ''
  if (!relativePath) {
    return new Response('Missing path', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return runWithRequestProfile(request, () => {
    const workspacePath = `files/${relativePath}`
    const filePath = resolveServableWorkspaceFile(workspacePath)
    if (!filePath) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(/* turbopackIgnore: true */ filePath)
    } catch {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    const ext = path.extname(filePath).toLowerCase()
    const headers = new Headers({
      'Content-Type': directContentType(filePath),
      'Content-Length': String(stat.size),
      'Content-Disposition': inlineContentDisposition(path.basename(filePath)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (HTML_EXTENSIONS.has(ext)) {
      headers.set('Content-Security-Policy', htmlPreviewCsp())
    }

    const body = headOnly
      ? null
      : (Readable.toWeb(
          fs.createReadStream(/* turbopackIgnore: true */ filePath)
        ) as ReadableStream<Uint8Array>)
    return new Response(body, { headers })
  })
}
