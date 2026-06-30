import fs from 'fs'
import path from 'path'

import { normalizeProfileId } from '@/lib/profiles/context'
import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

export interface PublishedAppShare {
  slug: string
  profileId: string
  enabled: boolean
  access: 'tailscale-funnel'
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

export function getPublishedAppShare(slug: string): PublishedAppShare | null {
  if (!isValidPublishedAppSlug(slug)) return null
  const state = readShareState()
  const raw = state.shares?.[slug]
  if (!raw || typeof raw !== 'object') return null
  const share = normalizeShare(raw)
  if (!share || share.slug !== slug || !share.enabled) return null
  return share
}

export function isValidPublishedAppSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
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

function normalizeShare(raw: object): PublishedAppShare | null {
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
    access: 'tailscale-funnel',
    funnelPath,
    funnelUrl: typeof r.funnelUrl === 'string' && r.funnelUrl.trim()
      ? r.funnelUrl.trim()
      : null,
    createdAt,
    updatedAt,
  }
}
