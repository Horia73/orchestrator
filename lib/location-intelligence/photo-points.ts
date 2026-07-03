// Photo geotag ingestion for the location journal: when a photo with EXIF GPS
// enters the app (chat upload or integration-persisted media), append it to
// points.jsonl so the daily journal task can pin "was at X, took a photo"
// moments. Fire-and-forget by design — a broken photo or missing EXIF must
// never affect the upload path. Only runs when the user has opted in to
// location intelligence.

import { appendLocationJournalPoint } from "@/lib/location-intelligence/journal"

const EXIF_CAPABLE_MIMES = new Set([
  "image/jpeg",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/png",
  "image/avif",
])

// EXIF lives in the header; exifr only reads what it needs, but skip
// obviously absurd buffers anyway.
const MAX_PARSE_BYTES = 64 * 1024 * 1024

export function isExifCapableImage(mimeType: string): boolean {
  return EXIF_CAPABLE_MIMES.has(mimeType.toLowerCase())
}

/** Extract GPS (+ capture time) from a photo and append a journal point.
 *  Returns true when a point was written. Never throws. */
export async function recordPhotoJournalPoint(args: {
  buffer: Buffer
  mimeType: string
  uploadId: string
  filename?: string
}): Promise<boolean> {
  const { buffer, mimeType, uploadId, filename } = args
  if (!isExifCapableImage(mimeType)) return false
  if (!buffer.length || buffer.length > MAX_PARSE_BYTES) return false
  try {
    const exifr = (await import("exifr")).default
    const gps = await exifr.gps(buffer)
    if (
      !gps ||
      typeof gps.latitude !== "number" ||
      typeof gps.longitude !== "number" ||
      !Number.isFinite(gps.latitude) ||
      !Number.isFinite(gps.longitude) ||
      (gps.latitude === 0 && gps.longitude === 0)
    ) {
      return false
    }
    const meta = (await exifr
      .parse(buffer, ["DateTimeOriginal", "CreateDate"])
      .catch(() => null)) as { DateTimeOriginal?: Date; CreateDate?: Date } | null
    const takenAt = meta?.DateTimeOriginal ?? meta?.CreateDate ?? null
    const takenAtMs =
      takenAt instanceof Date && Number.isFinite(takenAt.getTime())
        ? takenAt.getTime()
        : null

    return appendLocationJournalPoint({
      event: "photo",
      source: "photo_exif",
      // Journal semantics: timestamp_ms is when the sample happened. A photo
      // "happened" when it was taken; ingestion time is kept separately.
      timestamp_ms: takenAtMs ?? Date.now(),
      reported_at: new Date().toISOString(),
      taken_at: takenAtMs ? new Date(takenAtMs).toISOString() : null,
      lat: gps.latitude,
      lng: gps.longitude,
      upload_id: uploadId,
      ...(filename ? { filename } : {}),
    })
  } catch (err) {
    console.error("[location] photo EXIF ingestion failed", err)
    return false
  }
}
