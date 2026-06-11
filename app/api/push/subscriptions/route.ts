import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile } from "@/lib/profiles/server"
import {
  deletePushSubscription,
  listPushSubscriptions,
  savePushSubscription,
} from "@/lib/push-notifications"

export const runtime = "nodejs"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      try {
        return NextResponse.json(
          { subscriptions: listPushSubscriptions() },
          { headers: { "Cache-Control": "no-store" } }
        )
      } catch (error) {
        console.error("Failed to list push subscriptions", error)
        return NextResponse.json(
          { error: "Failed to list push subscriptions" },
          { status: 500 }
        )
      }
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
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
  })
}

export async function DELETE(request: Request) {
  return runWithRequestProfile(request, async () => {
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
  })
}
