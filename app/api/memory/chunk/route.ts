import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { findMemoryChunkForUi } from "@/lib/memory/recall"

export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json().catch(() => ({}))) as {
      id?: unknown
      source?: unknown
      title?: unknown
      snippet?: unknown
    }
    const source = typeof body.source === "string" ? body.source.trim() : ""
    if (!source) {
      return NextResponse.json(
        { error: "Missing `source`." },
        { status: 400 }
      )
    }

    const hit = findMemoryChunkForUi({
      id: typeof body.id === "string" ? body.id : undefined,
      source,
      title: typeof body.title === "string" ? body.title : undefined,
      snippet: typeof body.snippet === "string" ? body.snippet : undefined,
    })
    if (!hit) {
      return NextResponse.json({ error: "Chunk not found." }, { status: 404 })
    }

    return NextResponse.json(hit)
  } catch (error) {
    console.error("Memory chunk lookup failed", error)
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 })
  }
}
