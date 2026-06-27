import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'

import { runWithRequestProfile } from '@/lib/profiles/server'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{
    slug: string
    path?: string[]
  }>
}

const TEXT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}

const BINARY_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export async function GET(request: Request, context: RouteContext) {
  return servePublishedApp(request, context, false)
}

export async function HEAD(request: Request, context: RouteContext) {
  return servePublishedApp(request, context, true)
}

async function servePublishedApp(
  request: Request,
  context: RouteContext,
  headOnly: boolean
): Promise<Response> {
  const params = await context.params
  const slug = params.slug
  if (!isValidSlug(slug)) return textResponse('Invalid published app slug.', 400)

  return runWithRequestProfile(request, () => {
    const root = path.join(activeRuntimePaths().agentWorkspaceDir, 'published-apps', slug)
    const resolved = resolvePublishedFile(root, params.path ?? [])
    if (!resolved) return textResponse('Published app not found.', 404)

    const stat = fs.statSync(/* turbopackIgnore: true */ resolved.filePath)
    const ext = path.extname(resolved.filePath).toLowerCase()
    const headers = new Headers({
      'Content-Type': contentType(ext),
      'Content-Length': String(stat.size),
      'Cache-Control': ext === '.html' || ext === '.htm' ? 'private, no-store' : 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Orchestrator-Published-App': slug,
    })
    if (ext === '.html' || ext === '.htm') {
      headers.set('Content-Security-Policy', publishedAppCsp())
    }

    const body = headOnly
      ? null
      : (Readable.toWeb(
          fs.createReadStream(/* turbopackIgnore: true */ resolved.filePath)
        ) as ReadableStream<Uint8Array>)
    return new Response(body, { headers })
  })
}

function resolvePublishedFile(root: string, requestedSegments: string[]): { filePath: string } | null {
  if (!fs.existsSync(root)) return null
  const rootReal = fs.realpathSync.native(/* turbopackIgnore: true */ root)
  if (requestedSegments.some(isForbiddenSegment)) return null

  const requested = requestedSegments.length
    ? path.join(rootReal, ...requestedSegments)
    : path.join(rootReal, 'index.html')
  const file = resolveExistingFile(rootReal, requested)
  if (file) return { filePath: file }

  const hasExtension = path.extname(requestedSegments[requestedSegments.length - 1] ?? '') !== ''
  if (!hasExtension) {
    const fallback = resolveExistingFile(rootReal, path.join(rootReal, 'index.html'))
    if (fallback) return { filePath: fallback }
  }
  return null
}

function resolveExistingFile(rootReal: string, candidate: string): string | null {
  let targetReal: string
  try {
    targetReal = fs.realpathSync.native(/* turbopackIgnore: true */ candidate)
  } catch {
    return null
  }
  if (!isInside(rootReal, targetReal)) return null
  try {
    const stat = fs.statSync(/* turbopackIgnore: true */ targetReal)
    if (stat.isFile()) return targetReal
    if (stat.isDirectory()) {
      return resolveExistingFile(rootReal, path.join(targetReal, 'index.html'))
    }
  } catch {
    return null
  }
  return null
}

function publishedAppCsp(): string {
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'none'",
    "media-src 'self' data: blob: https: http:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

function contentType(ext: string): string {
  return TEXT_TYPES[ext] ?? BINARY_TYPES[ext] ?? 'application/octet-stream'
}

function isForbiddenSegment(segment: string): boolean {
  return !segment || segment === '.' || segment === '..' || segment.startsWith('.')
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isValidSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
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
