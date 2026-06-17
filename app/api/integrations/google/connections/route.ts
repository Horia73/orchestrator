import { NextResponse } from "next/server"
import { z } from "zod"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { setPreferredIntegrationConnection } from "@/lib/integrations/connection-store"
import { hasIntegrationAccess } from "@/lib/profiles/permissions"
import { runWithRequestProfile } from "@/lib/profiles/server"
import type { IntegrationPermissionId } from "@/lib/profiles/types"

const BodySchema = z.object({
  provider: z.enum(["gmail", "google_calendar", "google_drive"]),
  connectionId: z.string().min(1),
})

export async function POST(request: Request) {
  return runWithRequestProfile(request, async (current) => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Google connection preference", issues: parsed.error.issues },
        { status: 400 }
      )
    }
    const integration = integrationPermissionForProvider(parsed.data.provider)
    if (
      !current.isAdmin &&
      !hasIntegrationAccess(current.profile.permissions, integration, "setup")
    ) {
      return NextResponse.json(
        {
          error: "Profile is not allowed to manage this integration.",
          code: "profile_permission_denied",
          integration,
          requiredAccess: "setup",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      )
    }

    try {
      const selected = setPreferredIntegrationConnection({
        profileId: current.profile.id,
        provider: parsed.data.provider,
        connectionId: parsed.data.connectionId,
        actorProfileId: current.profile.id,
      })
      return NextResponse.json({ success: true, selected })
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not update Google account preference",
        },
        { status: 400 }
      )
    }
  })
}

function integrationPermissionForProvider(
  provider: z.infer<typeof BodySchema>["provider"]
): IntegrationPermissionId {
  if (provider === "google_calendar") return "google_calendar"
  if (provider === "google_drive") return "google_drive"
  return "gmail"
}
