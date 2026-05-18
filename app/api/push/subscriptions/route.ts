import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  deletePushSubscription,
  savePushSubscription,
} from "@/lib/push-notifications"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = await request.json()
    savePushSubscription(body.subscription, request.headers.get("user-agent"))
    return NextResponse.json(
      { success: true },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    console.error("Failed to save push subscription", error)
    return NextResponse.json(
      { error: "Failed to save push subscription" },
      { status: 400 }
    )
  }
}

export async function DELETE(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json().catch(() => ({}))) as {
      endpoint?: unknown
    }
    if (typeof body.endpoint === "string") deletePushSubscription(body.endpoint)
    return NextResponse.json(
      { success: true },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    console.error("Failed to delete push subscription", error)
    return NextResponse.json(
      { error: "Failed to delete push subscription" },
      { status: 500 }
    )
  }
}
