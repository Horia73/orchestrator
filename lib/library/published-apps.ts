import fs from "fs"
import path from "path"

import { activeRuntimePaths } from "@/lib/runtime-paths"
import {
  getPublishedAppShare,
  isValidPublishedAppSlug,
} from "@/lib/published-apps/shares"

export interface PublishedAppLibraryEntry {
  slug: string
  title: string
  basePath: string
  runId: string | null
  repoDir: string | null
  buildCommand: string | null
  publishedAt: number
  updatedAt: number
  sizeBytes: number
  fileCount: number
  shareUrl: string | null
  shareAccess: 'tailscale-funnel' | 'public-origin' | null
  /** Backward-compatible alias for older UI/code that expected Funnel-only links. */
  funnelUrl: string | null
}

interface PublishedAppMetadata {
  slug?: unknown
  runId?: unknown
  repoDir?: unknown
  buildCommand?: unknown
  basePath?: unknown
  publishedAt?: unknown
}

const METADATA_FILE = ".orchestrator-published-app.json"
const MAX_PUBLISHED_APPS = 500
const MAX_COUNTED_FILES = 20_000

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function readMetadata(filePath: string): PublishedAppMetadata | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf-8")) as unknown
    return parsed && typeof parsed === "object" ? parsed as PublishedAppMetadata : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function dateMs(value: unknown, fallback: number): number {
  const raw = stringField(value)
  if (!raw) return fallback
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : fallback
}

function titleForSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function summarizeDirectory(dir: string): { sizeBytes: number; fileCount: number } {
  let sizeBytes = 0
  let fileCount = 0

  function walk(current: string) {
    if (fileCount >= MAX_COUNTED_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(/* turbopackIgnore: true */ current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === METADATA_FILE || entry.isSymbolicLink()) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(/* turbopackIgnore: true */ absolute)
        if (!stat.isFile()) continue
        fileCount += 1
        sizeBytes += stat.size
        if (fileCount >= MAX_COUNTED_FILES) return
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  }

  walk(dir)
  return { sizeBytes, fileCount }
}

export function listPublishedAppsForLibrary(): PublishedAppLibraryEntry[] {
  const runtimePaths = activeRuntimePaths()
  const root = path.join(
    /* turbopackIgnore: true */ runtimePaths.agentWorkspaceDir,
    "published-apps"
  )
  let rootReal: string
  try {
    rootReal = fs.realpathSync.native(/* turbopackIgnore: true */ root)
  } catch {
    return []
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(/* turbopackIgnore: true */ rootReal, { withFileTypes: true })
  } catch {
    return []
  }

  const out: PublishedAppLibraryEntry[] = []
  for (const entry of entries) {
    if (out.length >= MAX_PUBLISHED_APPS) break
    if (!entry.isDirectory() || !isValidPublishedAppSlug(entry.name)) continue

    const dir = path.join(rootReal, entry.name)
    let dirReal: string
    let stat: fs.Stats
    try {
      dirReal = fs.realpathSync.native(/* turbopackIgnore: true */ dir)
      stat = fs.statSync(/* turbopackIgnore: true */ dirReal)
    } catch {
      continue
    }
    if (!stat.isDirectory() || !isInside(rootReal, dirReal)) continue

    const metadata = readMetadata(path.join(dirReal, METADATA_FILE))
    const slug = stringField(metadata?.slug) ?? entry.name
    if (slug !== entry.name || !isValidPublishedAppSlug(slug)) continue
    const basePath = stringField(metadata?.basePath) ?? `/published-apps/${slug}`
    if (basePath !== `/published-apps/${slug}`) continue

    const publishedAt = dateMs(metadata?.publishedAt, stat.mtimeMs)
    const summary = summarizeDirectory(dirReal)
    const share = getPublishedAppShare(slug, { profileId: runtimePaths.profileId })
    out.push({
      slug,
      title: titleForSlug(slug),
      basePath,
      runId: stringField(metadata?.runId),
      repoDir: stringField(metadata?.repoDir),
      buildCommand: stringField(metadata?.buildCommand),
      publishedAt,
      updatedAt: stat.mtimeMs,
      sizeBytes: summary.sizeBytes,
      fileCount: summary.fileCount,
      shareUrl: share?.funnelUrl ?? null,
      shareAccess: share?.access ?? null,
      funnelUrl: share?.funnelUrl ?? null,
    })
  }

  return out.sort((a, b) => b.publishedAt - a.publishedAt)
}
