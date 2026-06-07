import crypto from "crypto"
import fs from "fs"
import path from "path"

import { activeRuntimePaths } from "@/lib/runtime-paths"

const STATIC_MAP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const STATIC_MAP_CACHE_MAX_ENTRIES = 200
const STATIC_MAP_CACHE_MAX_BYTES = 50 * 1024 * 1024

interface StaticMapCacheMetadata {
  contentType: string
  createdAt: number
  size: number
}

export interface StaticMapCacheEntry {
  bytes: Buffer
  contentType: string
}

export function getStaticMapCacheKey(upstreamUrl: string): string {
  return crypto.createHash("sha256").update(upstreamUrl).digest("hex")
}

function staticMapCacheDir(): string {
  return path.join(activeRuntimePaths().privateStateDir, "maps-static-cache")
}

export function readStaticMapCache(upstreamUrl: string): StaticMapCacheEntry | null {
  const paths = staticMapCachePaths(upstreamUrl)
  try {
    const meta = readStaticMapCacheMetadata(paths.metaPath)
    if (!meta) return null
    if (Date.now() - meta.createdAt > STATIC_MAP_CACHE_MAX_AGE_MS) {
      deleteStaticMapCacheEntry(upstreamUrl)
      return null
    }
    return {
      bytes: fs.readFileSync(/* turbopackIgnore: true */ paths.imagePath),
      contentType: meta.contentType || "image/png",
    }
  } catch {
    deleteStaticMapCacheEntry(upstreamUrl)
    return null
  }
}

export function writeStaticMapCache(
  upstreamUrl: string,
  bytes: Buffer,
  contentType: string
): void {
  if (bytes.length === 0) return
  const paths = staticMapCachePaths(upstreamUrl)
  const metadata: StaticMapCacheMetadata = {
    contentType: contentType || "image/png",
    createdAt: Date.now(),
    size: bytes.length,
  }
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ staticMapCacheDir(), {
      recursive: true,
    })
    fs.writeFileSync(/* turbopackIgnore: true */ paths.imagePath, bytes)
    fs.writeFileSync(
      /* turbopackIgnore: true */ paths.metaPath,
      JSON.stringify(metadata),
      "utf8"
    )
    pruneStaticMapCache()
  } catch {
    deleteStaticMapCacheEntry(upstreamUrl)
  }
}

export function deleteStaticMapCacheEntry(upstreamUrl: string): void {
  const paths = staticMapCachePaths(upstreamUrl)
  for (const filePath of [paths.imagePath, paths.metaPath]) {
    try {
      fs.unlinkSync(/* turbopackIgnore: true */ filePath)
    } catch {
      /* cache cleanup is best-effort */
    }
  }
}

function staticMapCachePaths(upstreamUrl: string): {
  imagePath: string
  metaPath: string
} {
  const key = getStaticMapCacheKey(upstreamUrl)
  return {
    imagePath: path.join(staticMapCacheDir(), `${key}.bin`),
    metaPath: path.join(staticMapCacheDir(), `${key}.json`),
  }
}

function readStaticMapCacheMetadata(
  metaPath: string
): StaticMapCacheMetadata | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ metaPath, "utf8")
    ) as Partial<StaticMapCacheMetadata>
    if (
      typeof parsed.contentType !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.size !== "number"
    ) {
      return null
    }
    return {
      contentType: parsed.contentType,
      createdAt: parsed.createdAt,
      size: parsed.size,
    }
  } catch {
    return null
  }
}

function pruneStaticMapCache(): void {
  let entries: Array<{ key: string; createdAt: number; size: number }> = []
  try {
    entries = fs
      .readdirSync(/* turbopackIgnore: true */ staticMapCacheDir())
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const key = file.slice(0, -".json".length)
        const meta = readStaticMapCacheMetadata(
          path.join(staticMapCacheDir(), file)
        )
        return {
          key,
          createdAt: meta?.createdAt ?? 0,
          size: meta?.size ?? 0,
        }
      })
  } catch {
    return
  }

  const now = Date.now()
  for (const entry of entries) {
    if (now - entry.createdAt <= STATIC_MAP_CACHE_MAX_AGE_MS) continue
    deleteStaticMapCacheFiles(entry.key)
  }

  entries = entries
    .filter((entry) => now - entry.createdAt <= STATIC_MAP_CACHE_MAX_AGE_MS)
    .sort((a, b) => b.createdAt - a.createdAt)

  let totalBytes = 0
  for (const [index, entry] of entries.entries()) {
    totalBytes += entry.size
    if (
      index < STATIC_MAP_CACHE_MAX_ENTRIES &&
      totalBytes <= STATIC_MAP_CACHE_MAX_BYTES
    ) {
      continue
    }
    deleteStaticMapCacheFiles(entry.key)
  }
}

function deleteStaticMapCacheFiles(key: string): void {
  for (const suffix of [".bin", ".json"]) {
    try {
      fs.unlinkSync(
        /* turbopackIgnore: true */ path.join(
          staticMapCacheDir(),
          `${key}${suffix}`
        )
      )
    } catch {
      /* cache cleanup is best-effort */
    }
  }
}
