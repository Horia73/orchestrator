import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'

import { resolveBrowserOrigin } from '@/lib/app-origin'
import { getPublishedAppShare } from '@/lib/published-apps/shares'
import { runWithProfileContext } from '@/lib/profiles/context'
import { getCurrentProfileFromRequest } from '@/lib/profiles/server'
import { getProfile } from '@/lib/profiles/store'
import { runtimePathsForProfile } from '@/lib/runtime-paths'

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

// User-facing document deliverables the assistant drops next to (or in place of)
// an app — offers, reports, spec sheets. Two reasons they get their own map
// instead of falling through to `application/octet-stream`:
//   1. Real Content-Type so the browser previews them inline (its PDF viewer)
//      instead of force-downloading a nameless octet-stream blob — which on
//      mobile lands in an external viewer where a stale/duplicate-looking copy
//      is easy to mistake for "the same file".
//   2. They are regenerated IN PLACE at the same URL (the agent overwrites
//      `Oferta.pdf` across edits), so they must never be cached: a max-age keeps
//      serving the previous version for minutes after a change. See CACHE below.
// (Note: these can't just borrow UPLOAD_MIME_MAP — this route intentionally
// serves .html/.js/.svg as executable/renderable app types, not text/plain.)
const DOCUMENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.epub': 'application/epub+zip',
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
  const requestedPath = params.path ?? []
  // The origin the browser is actually on (duckdns / LAN / Tailscale funnel), so
  // the app's scoped CSP connect-src matches its own same-origin asset fetches.
  const browserOrigin = resolveBrowserOrigin(request)

  const current = getCurrentProfileFromRequest(request)

  // Authenticated viewer: serve their own copy first (covers private, un-shared
  // apps). If they don't have a copy, fall through to shared-owner resolution so
  // a published+shared app opened under a DIFFERENT profile still works instead
  // of 404ing against the wrong per-profile workspace.
  if (current) {
    const own = runWithProfileContext(
      { profileId: current.profile.id, role: current.profile.role },
      () => tryServePublishedAppFromProfile(current.profile.id, slug, requestedPath, headOnly, false, browserOrigin),
    )
    if (own) return own
  }

  // Shared-owner resolution: covers both the public (no-cookie) funnel path and
  // an authenticated viewer who is not the app's owner. getPublishedAppShare
  // only returns ENABLED shares, so this never exposes a private, un-shared app.
  const share = getPublishedAppShare(slug)
  if (!share) {
    return current
      ? textResponse('Published app not found.', 404)
      : textResponse('Profile required.', 401)
  }
  const owner = getProfile(share.profileId)
  if (!owner || owner.disabledAt) {
    return textResponse('Published app not found.', 404)
  }

  const served = runWithProfileContext(
    { profileId: owner.id, role: owner.role },
    () => tryServePublishedAppFromProfile(owner.id, slug, requestedPath, headOnly, true, browserOrigin),
  )
  return served ?? textResponse('Published app not found.', 404)
}

function tryServePublishedAppFromProfile(
  profileId: string,
  slug: string,
  requestedPath: string[],
  headOnly: boolean,
  publicShare: boolean,
  browserOrigin: string,
): Response | null {
  const root = path.join(runtimePathsForProfile(profileId).agentWorkspaceDir, 'published-apps', slug)
  const resolved = resolvePublishedFile(root, requestedPath)
  if (!resolved) return null

  const stat = fs.statSync(/* turbopackIgnore: true */ resolved.filePath)
  const ext = path.extname(resolved.filePath).toLowerCase()
  const headers = new Headers({
    'Content-Type': contentType(ext),
    'Content-Length': String(stat.size),
    // CACHE: html is never stored; document deliverables (see DOCUMENT_TYPES)
    // are revalidated every view because the agent overwrites them in place, so
    // a max-age would keep showing the previous version after a regeneration;
    // static app assets (js/css/wasm/images/fonts) stay cacheable for perf.
    'Cache-Control':
      ext === '.html' || ext === '.htm'
        ? 'private, no-store'
        : ext in DOCUMENT_TYPES
          ? 'private, no-cache'
          : 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Orchestrator-Published-App': slug,
  })
  if (publicShare) headers.set('X-Orchestrator-Published-App-Share', 'tailscale-funnel')
  if (ext === '.html' || ext === '.htm') {
    headers.set('Content-Security-Policy', publishedAppCsp(browserOrigin, slug))
  }

  const body = headOnly
    ? null
    : (Readable.toWeb(
        fs.createReadStream(/* turbopackIgnore: true */ resolved.filePath)
      ) as ReadableStream<Uint8Array>)
  return new Response(body, { headers })
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

function publishedAppCsp(browserOrigin: string, slug: string): string {
  // Let a self-contained static app fetch ONLY its own vendored assets — WASM
  // cores, OCR/model/language data, JSON — from its own published path, plus
  // blob:/data:. Scoping connect-src to `<origin>/published-apps/<slug>/`
  // (instead of 'self') means the app can never reach the Orchestrator API or
  // another profile's app with the viewer's session cookie. A wrong/spoofed
  // origin only fails closed (fetch blocked), so this cannot widen access.
  // 'wasm-unsafe-eval' permits WebAssembly.compile/instantiate (tesseract.js,
  // sql.js, pdf.js, onnxruntime-web, duckdb-wasm, …) without enabling eval().
  const selfAssets = `${browserOrigin}/published-apps/${slug}/`
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src ${selfAssets} blob: data:`,
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
  return TEXT_TYPES[ext] ?? BINARY_TYPES[ext] ?? DOCUMENT_TYPES[ext] ?? 'application/octet-stream'
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
