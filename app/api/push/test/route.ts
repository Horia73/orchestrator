import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile } from "@/lib/profiles/server"
import { sendTestPushNotification } from "@/lib/push-notifications"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      try {
        const body = (await request.json().catch(() => ({}))) as {
          endpoint?: unknown
        }
        const endpoint =
          typeof body.endpoint === "string" && body.endpoint
            ? body.endpoint
            : undefined
        const results = await sendTestPushNotification(endpoint)
        return NextResponse.json(
          { results },
          { headers: { "Cache-Control": "no-store" } }
        )
      } catch (error) {
        console.error("Failed to send test push notification", error)
        return NextResponse.json(
          { error: "Failed to send test push notification" },
          { status: 500 }
        )
      }
  })
}
