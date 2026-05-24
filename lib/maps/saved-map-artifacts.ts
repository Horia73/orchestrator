import { randomUUID } from "crypto"

import db from "@/lib/db"
import {
  deleteArtifactIdentifierChainById,
  insertArtifact,
} from "@/lib/artifacts/store"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { parseMapArtifact } from "@/lib/maps/schema"

export const SMART_MAPS_CONVERSATION_ID = "smart-maps-local"
const SMART_MAPS_CONVERSATION_TITLE = "Smart Maps"

export interface SaveSmartMapArtifactInput {
  title: string
  content: string
  identifier?: string | null
}

export function saveSmartMapArtifact(
  input: SaveSmartMapArtifactInput
): ArtifactRow {
  const title = cleanTitle(input.title)
  const parsed = parseMapArtifact(input.content)
  if (!parsed.ok) throw new Error(parsed.error)

  ensureSmartMapsConversation()

  return insertArtifact({
    conversationId: SMART_MAPS_CONVERSATION_ID,
    messageId: `smart-map-${randomUUID()}`,
    identifier: cleanIdentifier(input.identifier, title),
    type: "application/vnd.ant.map",
    title,
    display: "panel",
    content: JSON.stringify(parsed.value),
  })
}

export function isSmartMapArtifact(
  row: Pick<ArtifactRow, "conversationId" | "type">
): boolean {
  return (
    row.conversationId === SMART_MAPS_CONVERSATION_ID &&
    row.type === "application/vnd.ant.map"
  )
}

export function deleteSmartMapArtifact(id: string): boolean {
  const result = deleteArtifactIdentifierChainById(id, {
    conversationId: SMART_MAPS_CONVERSATION_ID,
    type: "application/vnd.ant.map",
  })
  return result.deleted > 0
}

function ensureSmartMapsConversation() {
  const now = Date.now()
  db.prepare(
    `INSERT INTO conversations (
       id, title, createdAt, updatedAt, origin, messageCount,
       lastMessagePreview, lastMessageAt, readAt
     )
     VALUES (
       @id, @title, @createdAt, @updatedAt, 'system', 0,
       NULL, NULL, @readAt
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updatedAt = excluded.updatedAt,
       origin = 'system'`
  ).run({
    id: SMART_MAPS_CONVERSATION_ID,
    title: SMART_MAPS_CONVERSATION_TITLE,
    createdAt: now,
    updatedAt: now,
    readAt: now,
  })
}

function cleanTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, " ").slice(0, 120)
  if (!title) throw new Error("title is required.")
  return title
}

function cleanIdentifier(value: string | null | undefined, title: string): string {
  const explicit = value?.trim()
  if (explicit && /^[a-z0-9][a-z0-9-]{0,80}$/.test(explicit)) return explicit
  const slug =
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "smart-map"
  return `${slug}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}
