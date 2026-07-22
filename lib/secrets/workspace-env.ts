import fs from "fs"
import path from "path"

import { emitAppEvent } from "@/lib/events"
import {
  shouldSyncWorkspaceEnvToProcess,
  writableWorkspaceEnvPath,
} from "@/lib/profiles/env-sharing"

export interface WorkspaceEnvWriteResult {
  path: string
  action: "created" | "updated" | "unchanged"
  bytes: number
}

/**
 * Atomically upsert a workspace environment value while preserving comments
 * and unrelated formatting. The file and its parent are private by default.
 */
export function upsertWorkspaceEnvValue(
  key: string,
  value: string
): WorkspaceEnvWriteResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env var name: ${key}`)
  }

  const filePath = writableWorkspaceEnvPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })

  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : ""
  const lines = existing.replace(/\r\n/g, "\n").split("\n")
  const formatted = `${key}=${formatEnvValue(value)}`
  const keyIndex = lines.findIndex((line) => isKeyLine(line, key))
  let action: WorkspaceEnvWriteResult["action"] = "created"

  if (keyIndex >= 0) {
    if (lines[keyIndex] === formatted) {
      try {
        fs.chmodSync(filePath, 0o600)
      } catch {
        // Best effort for filesystems without chmod support.
      }
      if (shouldSyncWorkspaceEnvToProcess()) process.env[key] = value
      emitAppEvent({ type: "settings.changed", reason: "env" })
      return {
        path: filePath,
        action: "unchanged",
        bytes: Buffer.byteLength(existing, "utf-8"),
      }
    }
    lines[keyIndex] = formatted
    action = "updated"
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    lines.push(formatted)
  }

  const output = lines.join("\n").replace(/\n*$/, "\n")
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, output, { encoding: "utf-8", mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort for filesystems without chmod support.
  }

  // Preserve compatibility for code paths that still consult process.env,
  // while canonical reads prefer the private/workspace stores.
  if (shouldSyncWorkspaceEnvToProcess()) process.env[key] = value
  emitAppEvent({ type: "settings.changed", reason: "env" })

  return {
    path: filePath,
    action,
    bytes: Buffer.byteLength(output, "utf-8"),
  }
}

function isKeyLine(line: string, key: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return false
  const idx = trimmed.indexOf("=")
  return idx > 0 && trimmed.slice(0, idx).trim() === key
}

function formatEnvValue(value: string): string {
  if (value === "") return '""'
  if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}
