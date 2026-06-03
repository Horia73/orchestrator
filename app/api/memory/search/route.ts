import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { dryRunSearch } from "@/lib/memory/recall"

// Dry-run calibration search: returns top hits with RAW cosine scores (no
// threshold) so the Settings card can show the score distribution and help the
// user pick a threshold for the active model.
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
    const hits = await dryRunSearch(query, limit)
    return NextResponse.json({
      hits: hits.map((h) => ({
        source: h.source,
        title: h.title,
        text: h.text,
        score: Number(h.score.toFixed(3)),
      })),
    })
  } catch (error) {
    console.error("Memory dry-run search failed", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
