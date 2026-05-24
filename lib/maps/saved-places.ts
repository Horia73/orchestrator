import { randomUUID } from "crypto"

import db from "@/lib/db"
import type { MapCoordinate } from "@/lib/maps/schema"
import { normalizeSafeHttpUrl } from "@/lib/maps/urls"

export interface SavedMapPlace {
  id: string
  dedupeKey: string
  title: string
  address: string | null
  description: string | null
  position: MapCoordinate
  placeId: string | null
  googleMapsUri: string | null
  websiteUri: string | null
  sourceUrl: string | null
  photoUrl: string | null
  rating: number | null
  userRatingCount: number | null
  openNow: boolean | null
  phoneNumber: string | null
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface SavedMapPlaceInput {
  title: string
  address?: string | null
  description?: string | null
  position: MapCoordinate
  placeId?: string | null
  googleMapsUri?: string | null
  websiteUri?: string | null
  sourceUrl?: string | null
  photoUrl?: string | null
  rating?: number | null
  userRatingCount?: number | null
  openNow?: boolean | null
  phoneNumber?: string | null
  notes?: string | null
}

interface SavedMapPlaceRow {
  id: string
  dedupeKey: string
  title: string
  address: string | null
  description: string | null
  lng: number
  lat: number
  placeId: string | null
  googleMapsUri: string | null
  websiteUri: string | null
  sourceUrl: string | null
  photoUrl: string | null
  rating: number | null
  userRatingCount: number | null
  openNow: number | null
  phoneNumber: string | null
  notes: string | null
  createdAt: number
  updatedAt: number
}

db.exec(`
  CREATE TABLE IF NOT EXISTS map_saved_places (
    id TEXT PRIMARY KEY,
    dedupeKey TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    address TEXT,
    description TEXT,
    lng REAL NOT NULL,
    lat REAL NOT NULL,
    placeId TEXT,
    googleMapsUri TEXT,
    websiteUri TEXT,
    sourceUrl TEXT,
    photoUrl TEXT,
    rating REAL,
    userRatingCount INTEGER,
    openNow INTEGER,
    phoneNumber TEXT,
    notes TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_map_saved_places_updated ON map_saved_places(updatedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_map_saved_places_title ON map_saved_places(title);
`)

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

function cleanUrl(value: string | null | undefined): string | null {
  return normalizeSafeHttpUrl(value, { stripHash: true, maxLength: 2000 })
}

function cleanImageUrl(value: string | null | undefined): string | null {
  return normalizeSafeHttpUrl(value, {
    httpsOnly: true,
    stripHash: true,
    maxLength: 2000,
  })
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function validatePosition(value: MapCoordinate): MapCoordinate {
  const [lng, lat] = value
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new Error("position must be [lng, lat] with valid coordinates.")
  }
  return [lng, lat]
}

function savedPlaceDedupeKey(input: {
  title: string
  position: MapCoordinate
  placeId: string | null
  googleMapsUri: string | null
  sourceUrl: string | null
}): string {
  if (input.placeId) return `place:${input.placeId}`
  if (input.googleMapsUri) return `google:${input.googleMapsUri}`
  if (input.sourceUrl) return `source:${input.sourceUrl}`
  const [lng, lat] = input.position
  return `coord:${lng.toFixed(5)},${lat.toFixed(5)}:${normalizeTitle(input.title)}`
}

function parseRow(row: SavedMapPlaceRow): SavedMapPlace {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    title: row.title,
    address: row.address,
    description: row.description,
    position: [row.lng, row.lat],
    placeId: row.placeId,
    googleMapsUri: row.googleMapsUri,
    websiteUri: row.websiteUri,
    sourceUrl: row.sourceUrl,
    photoUrl: row.photoUrl,
    rating: row.rating,
    userRatingCount: row.userRatingCount,
    openNow:
      row.openNow === null || row.openNow === undefined
        ? null
        : row.openNow === 1,
    phoneNumber: row.phoneNumber,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listSavedMapPlaces(limit = 200): SavedMapPlace[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500))
  const rows = db
    .prepare(
      `SELECT * FROM map_saved_places
       ORDER BY updatedAt DESC, createdAt DESC
       LIMIT ?`
    )
    .all(safeLimit) as SavedMapPlaceRow[]
  return rows.map(parseRow)
}

export function getSavedMapPlace(id: string): SavedMapPlace | null {
  const row = db
    .prepare(`SELECT * FROM map_saved_places WHERE id = ?`)
    .get(id) as SavedMapPlaceRow | undefined
  return row ? parseRow(row) : null
}

export function updateSavedMapPlaceNotes(
  id: string,
  notes: string | null | undefined
): SavedMapPlace | null {
  if (!getSavedMapPlace(id)) return null
  db.prepare(
    `UPDATE map_saved_places
        SET notes = @notes,
            updatedAt = @updatedAt
      WHERE id = @id`
  ).run({
    id,
    notes: cleanOptional(notes, 2000),
    updatedAt: now(),
  })
  return getSavedMapPlace(id)
}

export function addSavedMapPlace(input: SavedMapPlaceInput): SavedMapPlace {
  const title = cleanOptional(input.title, 160)
  if (!title) throw new Error("title is required.")
  const position = validatePosition(input.position)
  const placeId = cleanOptional(input.placeId, 256)
  const googleMapsUri = cleanUrl(input.googleMapsUri)
  const websiteUri = cleanUrl(input.websiteUri)
  const sourceUrl = cleanUrl(input.sourceUrl)
  const photoUrl = cleanImageUrl(input.photoUrl)
  const dedupeKey = savedPlaceDedupeKey({
    title,
    position,
    placeId,
    googleMapsUri,
    sourceUrl,
  })
  const timestamp = now()
  const existing = db
    .prepare(`SELECT * FROM map_saved_places WHERE dedupeKey = ?`)
    .get(dedupeKey) as SavedMapPlaceRow | undefined

  if (existing) {
    db.prepare(
      `UPDATE map_saved_places
          SET title = @title,
              address = @address,
              description = @description,
              lng = @lng,
              lat = @lat,
              placeId = @placeId,
              googleMapsUri = @googleMapsUri,
              websiteUri = @websiteUri,
              sourceUrl = @sourceUrl,
              photoUrl = @photoUrl,
              rating = @rating,
              userRatingCount = @userRatingCount,
              openNow = @openNow,
              phoneNumber = @phoneNumber,
              notes = COALESCE(@notes, notes),
              updatedAt = @updatedAt
        WHERE id = @id`
    ).run({
      id: existing.id,
      title,
      address: cleanOptional(input.address, 240),
      description: cleanOptional(input.description, 2000),
      lng: position[0],
      lat: position[1],
      placeId,
      googleMapsUri,
      websiteUri,
      sourceUrl,
      photoUrl,
      rating:
        typeof input.rating === "number" && Number.isFinite(input.rating)
          ? Math.max(0, Math.min(5, input.rating))
          : null,
      userRatingCount:
        typeof input.userRatingCount === "number" &&
        Number.isFinite(input.userRatingCount)
          ? Math.max(0, Math.trunc(input.userRatingCount))
          : null,
      openNow:
        typeof input.openNow === "boolean" ? (input.openNow ? 1 : 0) : null,
      phoneNumber: cleanOptional(input.phoneNumber, 80),
      notes: cleanOptional(input.notes, 2000),
      updatedAt: timestamp,
    })
    return getSavedMapPlace(existing.id)!
  }

  const id = randomUUID()
  db.prepare(
    `INSERT INTO map_saved_places (
      id, dedupeKey, title, address, description, lng, lat, placeId,
      googleMapsUri, websiteUri, sourceUrl, photoUrl, rating, userRatingCount,
      openNow, phoneNumber, notes, createdAt, updatedAt
    ) VALUES (
      @id, @dedupeKey, @title, @address, @description, @lng, @lat, @placeId,
      @googleMapsUri, @websiteUri, @sourceUrl, @photoUrl, @rating, @userRatingCount,
      @openNow, @phoneNumber, @notes, @createdAt, @updatedAt
    )`
  ).run({
    id,
    dedupeKey,
    title,
    address: cleanOptional(input.address, 240),
    description: cleanOptional(input.description, 2000),
    lng: position[0],
    lat: position[1],
    placeId,
    googleMapsUri,
    websiteUri,
    sourceUrl,
    photoUrl,
    rating:
      typeof input.rating === "number" && Number.isFinite(input.rating)
        ? Math.max(0, Math.min(5, input.rating))
        : null,
    userRatingCount:
      typeof input.userRatingCount === "number" &&
      Number.isFinite(input.userRatingCount)
        ? Math.max(0, Math.trunc(input.userRatingCount))
        : null,
    openNow:
      typeof input.openNow === "boolean" ? (input.openNow ? 1 : 0) : null,
    phoneNumber: cleanOptional(input.phoneNumber, 80),
    notes: cleanOptional(input.notes, 2000),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  return getSavedMapPlace(id)!
}

export function deleteSavedMapPlace(id: string): boolean {
  const result = db.prepare(`DELETE FROM map_saved_places WHERE id = ?`).run(id)
  return result.changes > 0
}
