import { createHash, randomUUID } from "crypto"

import db from "@/lib/db"
import type { MapBBox, MapCoordinate } from "@/lib/maps/schema"

export interface SavedMapArea {
  id: string
  dedupeKey: string
  title: string
  description: string | null
  ring: MapCoordinate[]
  bbox: MapBBox
  center: MapCoordinate
  areaSqKm: number | null
  color: string
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface SavedMapAreaInput {
  title?: string | null
  description?: string | null
  ring: MapCoordinate[]
  color?: string | null
  notes?: string | null
}

export interface SavedMapAreaUpdateInput {
  title?: string | null
  description?: string | null
  ring?: MapCoordinate[]
  color?: string | null
  notes?: string | null
}

interface SavedMapAreaRow {
  id: string
  dedupeKey: string
  title: string
  description: string | null
  ringJson: string
  bboxJson: string
  centerJson: string
  areaSqKm: number | null
  color: string
  notes: string | null
  createdAt: number
  updatedAt: number
}

db.exec(`
  CREATE TABLE IF NOT EXISTS map_saved_areas (
    id TEXT PRIMARY KEY,
    dedupeKey TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    ringJson TEXT NOT NULL,
    bboxJson TEXT NOT NULL,
    centerJson TEXT NOT NULL,
    areaSqKm REAL,
    color TEXT NOT NULL,
    notes TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_map_saved_areas_updated ON map_saved_areas(updatedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_map_saved_areas_title ON map_saved_areas(title);
`)

const DEFAULT_AREA_COLOR = "#1a73e8"
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function now() {
  return Date.now()
}

function cleanOptional(
  value: string | null | undefined,
  max = 2000
): string | null {
  const cleaned = value?.trim()
  return cleaned ? cleaned.slice(0, max) : null
}

function cleanTitle(value: string | null | undefined): string {
  return cleanOptional(value, 160) ?? "Saved area"
}

function cleanColor(value: string | null | undefined): string {
  const cleaned = value?.trim()
  return cleaned && HEX_COLOR_RE.test(cleaned) ? cleaned : DEFAULT_AREA_COLOR
}

function validateCoordinate(value: MapCoordinate): MapCoordinate {
  const [lng, lat] = value
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new Error("ring must contain valid [lng, lat] coordinates.")
  }
  return [lng, lat]
}

function sameCoordinate(a: MapCoordinate, b: MapCoordinate): boolean {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10
}

function validateRing(value: MapCoordinate[]): MapCoordinate[] {
  if (!Array.isArray(value)) throw new Error("ring must be an array.")
  const ring = value.map(validateCoordinate)
  if (ring.length >= 2 && sameCoordinate(ring[0], ring[ring.length - 1])) {
    ring.pop()
  }
  if (ring.length < 3) throw new Error("ring must contain at least 3 points.")
  if (ring.length > 500) throw new Error("ring accepts at most 500 points.")
  return ring
}

function bboxForRing(ring: MapCoordinate[]): MapBBox {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng)
    south = Math.min(south, lat)
    east = Math.max(east, lng)
    north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

function centerForBBox(bbox: MapBBox): MapCoordinate {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
}

function polygonAreaSqKm(ring: MapCoordinate[]): number | null {
  if (ring.length < 3) return null
  const meanLat = ring.reduce((sum, coord) => sum + coord[1], 0) / ring.length
  const metersPerLng = 111_320 * Math.cos((meanLat * Math.PI) / 180)
  const metersPerLat = 110_540
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area +=
      a[0] * metersPerLng * (b[1] * metersPerLat) -
      b[0] * metersPerLng * (a[1] * metersPerLat)
  }
  const sqKm = Math.abs(area) / 2 / 1_000_000
  return Number.isFinite(sqKm) ? sqKm : null
}

function roundedRing(ring: MapCoordinate[]): MapCoordinate[] {
  return ring.map(([lng, lat]) => [
    Number(lng.toFixed(5)),
    Number(lat.toFixed(5)),
  ])
}

function savedAreaDedupeKey(ring: MapCoordinate[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(roundedRing(ring)))
    .digest("hex")
    .slice(0, 32)
  return `area:${digest}`
}

function parseJsonCoordinate(value: string): MapCoordinate {
  const parsed = JSON.parse(value) as MapCoordinate
  return validateCoordinate(parsed)
}

function parseJsonBBox(value: string): MapBBox {
  const parsed = JSON.parse(value) as MapBBox
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new Error("Saved area bbox is malformed.")
  }
  const [west, south, east, north] = parsed
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error("Saved area bbox is malformed.")
  }
  return [west, south, east, north]
}

function parseJsonRing(value: string): MapCoordinate[] {
  return validateRing(JSON.parse(value) as MapCoordinate[])
}

function parseRow(row: SavedMapAreaRow): SavedMapArea {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    title: row.title,
    description: row.description,
    ring: parseJsonRing(row.ringJson),
    bbox: parseJsonBBox(row.bboxJson),
    center: parseJsonCoordinate(row.centerJson),
    areaSqKm: row.areaSqKm,
    color: row.color,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listSavedMapAreas(limit = 200): SavedMapArea[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500))
  const rows = db
    .prepare(
      `SELECT * FROM map_saved_areas
       ORDER BY updatedAt DESC, createdAt DESC
       LIMIT ?`
    )
    .all(safeLimit) as SavedMapAreaRow[]
  return rows.map(parseRow)
}

export function getSavedMapArea(id: string): SavedMapArea | null {
  const row = db
    .prepare(`SELECT * FROM map_saved_areas WHERE id = ?`)
    .get(id) as SavedMapAreaRow | undefined
  return row ? parseRow(row) : null
}

export function addSavedMapArea(input: SavedMapAreaInput): SavedMapArea {
  const ring = validateRing(input.ring)
  const bbox = bboxForRing(ring)
  const center = centerForBBox(bbox)
  const dedupeKey = savedAreaDedupeKey(ring)
  const timestamp = now()
  const existing = db
    .prepare(`SELECT * FROM map_saved_areas WHERE dedupeKey = ?`)
    .get(dedupeKey) as SavedMapAreaRow | undefined

  const values = {
    title: cleanTitle(input.title),
    description: cleanOptional(input.description, 1000),
    ringJson: JSON.stringify(ring),
    bboxJson: JSON.stringify(bbox),
    centerJson: JSON.stringify(center),
    areaSqKm: polygonAreaSqKm(ring),
    color: cleanColor(input.color),
    notes: cleanOptional(input.notes, 2000),
    updatedAt: timestamp,
  }

  if (existing) {
    db.prepare(
      `UPDATE map_saved_areas
          SET title = @title,
              description = @description,
              ringJson = @ringJson,
              bboxJson = @bboxJson,
              centerJson = @centerJson,
              areaSqKm = @areaSqKm,
              color = @color,
              notes = COALESCE(@notes, notes),
              updatedAt = @updatedAt
        WHERE id = @id`
    ).run({ ...values, id: existing.id })
    return getSavedMapArea(existing.id)!
  }

  const id = randomUUID()
  db.prepare(
    `INSERT INTO map_saved_areas (
      id, dedupeKey, title, description, ringJson, bboxJson, centerJson,
      areaSqKm, color, notes, createdAt, updatedAt
    ) VALUES (
      @id, @dedupeKey, @title, @description, @ringJson, @bboxJson, @centerJson,
      @areaSqKm, @color, @notes, @createdAt, @updatedAt
    )`
  ).run({
    ...values,
    id,
    dedupeKey,
    createdAt: timestamp,
  })
  return getSavedMapArea(id)!
}

export function updateSavedMapArea(
  id: string,
  input: SavedMapAreaUpdateInput
): SavedMapArea | null {
  const existing = getSavedMapArea(id)
  if (!existing) return null

  const ring = input.ring ? validateRing(input.ring) : existing.ring
  const bbox = bboxForRing(ring)
  const center = centerForBBox(bbox)
  db.prepare(
    `UPDATE map_saved_areas
        SET dedupeKey = @dedupeKey,
            title = @title,
            description = @description,
            ringJson = @ringJson,
            bboxJson = @bboxJson,
            centerJson = @centerJson,
            areaSqKm = @areaSqKm,
            color = @color,
            notes = @notes,
            updatedAt = @updatedAt
      WHERE id = @id`
  ).run({
    id,
    dedupeKey: savedAreaDedupeKey(ring),
    title: input.title === undefined ? existing.title : cleanTitle(input.title),
    description:
      input.description === undefined
        ? existing.description
        : cleanOptional(input.description, 1000),
    ringJson: JSON.stringify(ring),
    bboxJson: JSON.stringify(bbox),
    centerJson: JSON.stringify(center),
    areaSqKm: polygonAreaSqKm(ring),
    color: input.color === undefined ? existing.color : cleanColor(input.color),
    notes:
      input.notes === undefined
        ? existing.notes
        : cleanOptional(input.notes, 2000),
    updatedAt: now(),
  })
  return getSavedMapArea(id)
}

export function deleteSavedMapArea(id: string): boolean {
  const result = db.prepare(`DELETE FROM map_saved_areas WHERE id = ?`).run(id)
  return result.changes > 0
}
