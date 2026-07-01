import fs from 'fs'
import path from 'path'

import { normalizeProfileId } from '@/lib/profiles/context'
import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

export interface PublishedAppShare {
  slug: string
  profileId: string
  enabled: boolean
  access: 'tailscale-funnel' | 'public-origin'
  funnelPath: string
  funnelUrl: string | null
  createdAt: string
  updatedAt: string
}

interface PublishedAppShareState {
  version: 1
  updatedAt?: string
  shares?: Record<string, unknown>
}

const SHARE_STATE_PATH = path.join(
  /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
  'published-app-shares.json',
)

export function getPublishedAppShare(
  slug: string,
  options: { profileId?: string | null } = {},
): PublishedAppShare | null {
  if (!isValidPublishedAppSlug(slug)) return null
  const state = readShareState()
  const profileId = options.profileId ? normalizeProfileId(options.profileId) : null

  if (profileId) {
    const scoped = normalizeShare(state.shares?.[shareStateKey(profileId, slug)])
    if (scoped?.slug === slug && scoped.profileId === profileId && scoped.enabled) {
      return scoped
    }

    // Backward compatibility for shares written before the state was keyed by
    // profile. Only reuse a legacy slug entry when it belongs to this profile.
    const legacy = normalizeShare(state.shares?.[slug])
    if (legacy?.slug === slug && legacy.profileId === profileId && legacy.enabled) {
      return legacy
    }
    return null
  }

  const candidates = Object.values(state.shares ?? {})
    .map(normalizeShare)
    .filter((share): share is PublishedAppShare => Boolean(share?.enabled && share.slug === slug))
  return candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null
}

export function upsertPublishedAppShare(args: {
  slug: string
  profileId: string
  funnelPath?: string
  funnelUrl: string
  access?: PublishedAppShare['access']
}): PublishedAppShare {
  if (!isValidPublishedAppSlug(args.slug)) {
    throw new Error('Invalid published app slug.')
  }
  const profileId = normalizeProfileId(args.profileId)
  const funnelPath = args.funnelPath ?? `/published-apps/${args.slug}`
  if (funnelPath !== `/published-apps/${args.slug}`) {
    throw new Error('Invalid published app funnel path.')
  }
  const funnelUrl = args.funnelUrl.trim()
  if (!funnelUrl) throw new Error('Published app share URL is required.')

  const state = readShareState()
  const shares = state.shares && typeof state.shares === 'object' ? { ...state.shares } : {}
  const key = shareStateKey(profileId, args.slug)
  const existing = normalizeShare(shares[key])
    ?? matchingLegacyShare(shares, args.slug, profileId)
  const now = new Date().toISOString()
  const share: PublishedAppShare = {
    slug: args.slug,
    profileId,
    enabled: true,
    access: args.access ?? 'tailscale-funnel',
    funnelPath,
    funnelUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  shares[key] = share

  const legacy = normalizeShare(shares[args.slug])
  if (legacy?.profileId === profileId) {
    delete shares[args.slug]
  }

  writeShareState({
    version: 1,
    updatedAt: now,
    shares,
  })

  return share
}

export function isValidPublishedAppSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
}

function shareStateKey(profileId: string, slug: string): string {
  return `${profileId}:${slug}`
}

function readShareState(): PublishedAppShareState {
  try {
    if (!fs.existsSync(SHARE_STATE_PATH)) return { version: 1, shares: {} }
    const parsed = JSON.parse(fs.readFileSync(SHARE_STATE_PATH, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') return { version: 1, shares: {} }
    const obj = parsed as PublishedAppShareState
    return obj.version === 1 && obj.shares && typeof obj.shares === 'object'
      ? obj
      : { version: 1, shares: {} }
  } catch {
    return { version: 1, shares: {} }
  }
}

function writeShareState(state: PublishedAppShareState): void {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(SHARE_STATE_PATH), { recursive: true })
  const tmp = `${SHARE_STATE_PATH}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(/* turbopackIgnore: true */ tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  fs.renameSync(/* turbopackIgnore: true */ tmp, SHARE_STATE_PATH)
}

function matchingLegacyShare(
  shares: Record<string, unknown>,
  slug: string,
  profileId: string,
): PublishedAppShare | null {
  const legacy = normalizeShare(shares[slug])
  return legacy?.slug === slug && legacy.profileId === profileId ? legacy : null
}

function normalizeShare(raw: unknown): PublishedAppShare | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const slug = typeof r.slug === 'string' ? r.slug.trim() : ''
  if (!isValidPublishedAppSlug(slug)) return null

  let profileId: string
  try {
    profileId = normalizeProfileId(typeof r.profileId === 'string' ? r.profileId : '')
  } catch {
    return null
  }

  const funnelPath = typeof r.funnelPath === 'string' ? r.funnelPath.trim() : ''
  if (funnelPath !== `/published-apps/${slug}`) return null

  const createdAt = typeof r.createdAt === 'string' && r.createdAt
    ? r.createdAt
    : new Date(0).toISOString()
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt
    ? r.updatedAt
    : createdAt

  return {
    slug,
    profileId,
    enabled: r.enabled === true,
    access: r.access === 'public-origin' ? 'public-origin' : 'tailscale-funnel',
    funnelPath,
    funnelUrl: typeof r.funnelUrl === 'string' && r.funnelUrl.trim()
      ? r.funnelUrl.trim()
      : null,
    createdAt,
    updatedAt,
  }
}
