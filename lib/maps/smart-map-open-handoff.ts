import type { ArtifactRow } from "@/lib/artifacts/schema"

export const SMART_MAP_OPEN_HANDOFF_STORAGE_KEY =
  "orch:smart-maps:open-handoff"

const SMART_MAP_OPEN_HANDOFF_TTL_MS = 2 * 60 * 1000
const MAP_CAMERA_STORAGE_PREFIX = "orch:map-camera:"
const MAP_SELECTED_STORAGE_PREFIX = "orch:map-selected:"

export interface SmartMapOpenHandoff {
  id: string
  title: string
  content: string
  createdAt: number
}

function session(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function storageKey(prefix: string, key: string): string {
  return `${prefix}${encodeURIComponent(String(key || "default"))}`
}

export function clearSmartMapCameraSession(key: string): void {
  const store = session()
  if (!store) return
  try {
    store.removeItem(storageKey(MAP_CAMERA_STORAGE_PREFIX, key))
    store.removeItem(storageKey(MAP_SELECTED_STORAGE_PREFIX, key))
  } catch {
    // Best effort only. Navigation should still work when storage is blocked.
  }
}

export function writeSmartMapOpenHandoff(handoff: SmartMapOpenHandoff): void {
  const store = session()
  if (!store) return
  try {
    store.setItem(SMART_MAP_OPEN_HANDOFF_STORAGE_KEY, JSON.stringify(handoff))
    clearSmartMapCameraSession(handoff.id)
  } catch {
    // Best effort only. The server-backed artifact route remains canonical.
  }
}

export function consumeSmartMapOpenHandoff(
  expectedId: string
): SmartMapOpenHandoff | null {
  const store = session()
  if (!store) return null
  try {
    const raw = store.getItem(SMART_MAP_OPEN_HANDOFF_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SmartMapOpenHandoff>
    const fresh =
      typeof parsed.createdAt === "number" &&
      Date.now() - parsed.createdAt <= SMART_MAP_OPEN_HANDOFF_TTL_MS
    const matches =
      parsed.id === expectedId &&
      typeof parsed.title === "string" &&
      typeof parsed.content === "string" &&
      fresh
    store.removeItem(SMART_MAP_OPEN_HANDOFF_STORAGE_KEY)
    return matches ? (parsed as SmartMapOpenHandoff) : null
  } catch {
    try {
      store.removeItem(SMART_MAP_OPEN_HANDOFF_STORAGE_KEY)
    } catch {}
    return null
  }
}

export function artifactRowFromSmartMapOpenHandoff(
  handoff: SmartMapOpenHandoff
): ArtifactRow {
  return {
    id: handoff.id,
    conversationId: "smart-maps-handoff",
    messageId: `smart-map-handoff-${handoff.id}`,
    identifier: handoff.id,
    version: 1,
    type: "application/vnd.ant.map",
    title: handoff.title,
    language: null,
    display: "panel",
    filePath: null,
    content: handoff.content,
    createdAt: handoff.createdAt,
  }
}
