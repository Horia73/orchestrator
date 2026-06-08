import { NextResponse } from "next/server"
import { z } from "zod"

import {
  getHomeAssistantIntegrationStatus,
} from "@/lib/integrations/home-assistant"
import {
  listConnectionProfiles,
  listIntegrationConnectionGrants,
  listIntegrationConnectionPreferences,
  listIntegrationConnections,
  revokeIntegrationConnectionGrant,
  setPreferredIntegrationConnection,
} from "@/lib/integrations/connection-store"
import { requireAdminRequestProfile } from "@/lib/profiles/server"
import { grantHomeAssistantConnectionToProfile } from "@/lib/profiles/access-management"

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("grant"),
    connectionId: z.string().min(1),
    profileId: z.string().min(1),
    access: z.enum(["read", "write", "setup"]),
  }),
  z.object({
    action: z.literal("revoke"),
    connectionId: z.string().min(1),
    profileId: z.string().min(1),
  }),
  z.object({
    action: z.literal("prefer"),
    connectionId: z.string().min(1),
    profileId: z.string().min(1),
  }),
])

export async function GET(request: Request) {
  return requireAdminRequestProfile(request, async () => {
    await getHomeAssistantIntegrationStatus(false)
    return NextResponse.json({
      profiles: listConnectionProfiles(),
      connections: listIntegrationConnections({ provider: "home_assistant" }),
      grants: listIntegrationConnectionGrants(),
      preferences: listIntegrationConnectionPreferences({
        provider: "home_assistant",
      }),
    })
  })
}

export async function POST(request: Request) {
  return requireAdminRequestProfile(request, async (current) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid connection action", issues: parsed.error.issues },
        { status: 400 }
      )
    }

    try {
      if (parsed.data.action === "grant") {
        const grant = grantHomeAssistantConnectionToProfile({
          connectionId: parsed.data.connectionId,
          profileId: parsed.data.profileId,
          access: parsed.data.access,
          actorProfileId: current.profile.id,
        })
        return NextResponse.json({ success: true, grant })
      }

      if (parsed.data.action === "revoke") {
        const revoked = revokeIntegrationConnectionGrant({
          connectionId: parsed.data.connectionId,
          profileId: parsed.data.profileId,
          actorProfileId: current.profile.id,
        })
        return NextResponse.json({ success: true, revoked })
      }

      const selected = setPreferredIntegrationConnection({
        profileId: parsed.data.profileId,
        provider: "home_assistant",
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
              : "Could not update connection access",
        },
        { status: 400 }
      )
    }
  })
}
