import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getActiveThreshold, setActiveThreshold } from "@/lib/memory/recall"

// Persist a calibrated recall threshold for the ACTIVE embedding generation
// (provider:model:dim), so switching models restores each one's tuned value.
export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json().catch(() => ({}))) as {
      threshold?: unknown
    }
    const n = Number(body.threshold)
    if (!Number.isFinite(n)) {
      return NextResponse.json(
        { error: "`threshold` must be a number 0..1." },
        { status: 400 }
      )
    }
    const saved = setActiveThreshold(n)
    return NextResponse.json({ success: true, threshold: saved })
  } catch (error) {
    console.error("Failed to save memory threshold", error)
    return NextResponse.json(
      { error: "Failed to save threshold" },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard
  return NextResponse.json({ threshold: getActiveThreshold() })
}
