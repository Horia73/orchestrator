import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { isLoopbackHost, resolveRequestOrigin } from '@/lib/app-origin'
import { listPublishedAppsForLibrary } from '@/lib/library/published-apps'
import {
  getPublishedAppShare,
  isValidPublishedAppSlug,
  upsertPublishedAppShare,
} from '@/lib/published-apps/shares'
import { runWithRequestProfile } from '@/lib/profiles/server'
import { setPublishedAppFunnel } from '@/lib/remote-access/manager'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ slug: string }>
}

/** POST /api/published-apps/:slug/share — create or return a public link for this profile's published app. */
export async function POST(request: Request, context: RouteContext) {
  return runWithRequestProfile(request, async (current) => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { slug } = await context.params
    if (!isValidPublishedAppSlug(slug)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid published app slug.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const app = listPublishedAppsForLibrary().find((entry) => entry.slug === slug)
    if (!app) {
      return NextResponse.json(
        { ok: false, error: 'Published app not found in this profile.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const existing = getPublishedAppShare(slug, { profileId: current.profile.id })
    if (existing?.funnelUrl) {
      return shareResponse(existing.funnelUrl, existing.access)
    }

    const publicPathOwner = getPublishedAppShare(slug)
    if (publicPathOwner && publicPathOwner.profileId !== current.profile.id) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This public path is already shared by another profile. Publish this page with a different slug before sharing it.',
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const publicUrl = publicShareUrlFromRequest(request, app.basePath)
    if (publicUrl) {
      const share = upsertPublishedAppShare({
        slug,
        profileId: current.profile.id,
        funnelPath: app.basePath,
        funnelUrl: publicUrl,
        access: 'public-origin',
      })
      return shareResponse(share.funnelUrl, share.access)
    }

    const result = await setPublishedAppFunnel(slug, true)
    if (!result.ok || !result.funnelUrl) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error ?? 'Could not create a public Tailscale Funnel link.',
          output: result.output,
          tailscale: result.tailscale,
        },
        { status: 502, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const share = upsertPublishedAppShare({
      slug,
      profileId: current.profile.id,
      funnelPath: result.path ?? app.basePath,
      funnelUrl: result.funnelUrl,
      access: 'tailscale-funnel',
    })
    return shareResponse(share.funnelUrl, share.access, { tailscale: result.tailscale })
  })
}

function shareResponse(
  shareUrl: string | null,
  shareAccess: 'tailscale-funnel' | 'public-origin',
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      shareUrl,
      shareAccess,
      ...extra,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function publicShareUrlFromRequest(request: Request, basePath: string): string | null {
  let url: URL
  try {
    url = new URL(`${basePath.replace(/\/+$/, '')}/`, resolveRequestOrigin(request))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !isPublicHostname(url.hostname)) return null
  return url.toString()
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  if (!host || isLoopbackHost(host) || host.endsWith('.local')) return false
  if (isPrivateIpv4(host) || host.includes(':')) return false
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return false
  const tld = labels[labels.length - 1] ?? ''
  return /^[a-z]{2,63}$/.test(tld)
}

function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = octets
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}
