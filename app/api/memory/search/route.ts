import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { previewRecallSearch } from "@/lib/memory/recall"

// Calibration search for Settings: returns both RAW scores and a production
// automatic-recall preview (threshold + exclusions + dedup + coverage gate).
export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json().catch(() => ({}))) as {
      query?: unknown
      limit?: unknown
    }
    const query = typeof body.query === "string" ? body.query.trim() : ""
    if (!query) {
      return NextResponse.json({ error: "Missing `query`." }, { status: 400 })
    }
    const limit = Math.min(
      25,
      Math.max(1, Math.floor(Number(body.limit)) || 10)
    )
    const preview = await previewRecallSearch(query, limit)
    const serializeHit = (h: (typeof preview.rawHits)[number]) => ({
      source: h.source,
      title: h.title,
      text: h.text,
      score: Number(h.score.toFixed(3)),
    })
    return NextResponse.json({
      hits: preview.rawHits.map(serializeHit),
      rawHits: preview.rawHits.map(serializeHit),
      automaticHits: preview.automaticHits.map(serializeHit),
      threshold: preview.threshold,
      topK: preview.topK,
    })
  } catch (error) {
    console.error("Memory dry-run search failed", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
