import fs from "fs"
import path from "path"

import { AGENT_WORKSPACE_DIR } from "@/lib/config"
import { appApiPath } from "@/lib/app-path"
import {
  isInsideHiddenDiscoveryPath,
  isInsideProtectedAgentPath,
  resolveSandboxedWritable,
} from "@/lib/ai/tools/sandbox"
import { classifyUploadMime } from "@/lib/uploads"
import { UPLOAD_MIME_MAP } from "@/lib/upload-mime"
import { WORKSPACE_FILE_DEFINITIONS } from "@/lib/settings/workspace-files"

export interface ExtraWorkspaceLibraryEntry {
  id: string
  filename: string
  mimeType: string
  size: number
  type: "image" | "pdf" | "document" | "audio" | "video" | "other"
  source: "workspace"
  url: string
  workspacePath: string
  workspaceUpdatedAt: number
  conversationTitle: string
  messageTimestamp: number
}

const WORKSPACE_INIT_MARKER = ".workspace-initialized"
const MAX_EXTRA_WORKSPACE_FILES = 2_000

const standardWorkspaceFiles = new Set(
  WORKSPACE_FILE_DEFINITIONS.filter((def) => def.dynamic !== "daily").map(
    (def) => normalizeRelativePath(def.relativePath)
  )
)

const standardWorkspaceDirs = new Set(
  WORKSPACE_FILE_DEFINITIONS.filter((def) => def.dynamic === "daily").map(
    (def) => normalizeRelativePath(def.relativePath)
  )
)

standardWorkspaceFiles.add(WORKSPACE_INIT_MARKER)

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/")
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function isStandardWorkspacePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  if (standardWorkspaceFiles.has(normalized)) return true
  for (const dir of standardWorkspaceDirs) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) return true
  }
  return false
}

function mimeTypeFor(filePath: string): string {
  return (
    UPLOAD_MIME_MAP[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  )
}

function workspaceFileUrl(relativePath: string): string {
  return appApiPath("/api/workspace/files", { path: relativePath })
}

function workspaceEntryId(relativePath: string): string {
  return `workspace:${relativePath}`
}

function shouldSkipPath(absolutePath: string, relativePath: string): boolean {
  if (isStandardWorkspacePath(relativePath)) return true
  if (isInsideHiddenDiscoveryPath(absolutePath)) return true
  return isInsideProtectedAgentPath(absolutePath)
}

export function listExtraWorkspaceFiles(): ExtraWorkspaceLibraryEntry[] {
  const root = path.resolve(/* turbopackIgnore: true */ AGENT_WORKSPACE_DIR)
  const rootReal = fs.existsSync(root) ? fs.realpathSync.native(root) : root
  const out: ExtraWorkspaceLibraryEntry[] = []

  function walk(dir: string) {
    if (out.length >= MAX_EXTRA_WORKSPACE_FILES) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(/* turbopackIgnore: true */ dir, {
        withFileTypes: true,
      })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_EXTRA_WORKSPACE_FILES) return
      const absolutePath = path.join(dir, entry.name)
      const relativePath = normalizeRelativePath(
        path.relative(root, absolutePath)
      )
      if (!relativePath || shouldSkipPath(absolutePath, relativePath)) continue
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      let stat: fs.Stats
      let realPath: string
      try {
        stat = fs.statSync(/* turbopackIgnore: true */ absolutePath)
        realPath = fs.realpathSync.native(
          /* turbopackIgnore: true */ absolutePath
        )
      } catch {
        continue
      }
      if (!stat.isFile() || !isInside(rootReal, realPath)) continue

      const mimeType = mimeTypeFor(absolutePath)
      out.push({
        id: workspaceEntryId(relativePath),
        filename: path.basename(relativePath),
        mimeType,
        size: stat.size,
        type: classifyUploadMime(mimeType),
        source: "workspace",
        url: workspaceFileUrl(relativePath),
        workspacePath: relativePath,
        workspaceUpdatedAt: stat.mtimeMs,
        conversationTitle: relativePath,
        messageTimestamp: stat.mtimeMs,
      })
    }
  }

  if (fs.existsSync(root)) walk(root)
  return out.sort((a, b) => b.workspaceUpdatedAt - a.workspaceUpdatedAt)
}

export function deleteExtraWorkspaceFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || isStandardWorkspacePath(normalized)) return false

  const resolved = resolveSandboxedWritable(normalized)
  if (!resolved.ok) return false
  if (shouldSkipPath(resolved.resolved, normalized)) return false

  const root = path.resolve(/* turbopackIgnore: true */ AGENT_WORKSPACE_DIR)
  let rootReal: string
  let fileReal: string
  let stat: fs.Stats
  try {
    rootReal = fs.realpathSync.native(/* turbopackIgnore: true */ root)
    fileReal = fs.realpathSync.native(
      /* turbopackIgnore: true */ resolved.resolved
    )
    stat = fs.statSync(/* turbopackIgnore: true */ fileReal)
  } catch {
    return false
  }
  if (!stat.isFile() || !isInside(rootReal, fileReal)) return false

  fs.unlinkSync(/* turbopackIgnore: true */ fileReal)
  return true
}
