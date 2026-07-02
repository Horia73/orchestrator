import { NextResponse } from "next/server"
import { z } from "zod"

import { resolveRequestOrigin } from "@/lib/app-origin"
import { getGmailIntegrationStatus } from "@/lib/integrations/gmail"
import { getGoogleCalendarIntegrationStatus } from "@/lib/integrations/google-calendar"
import { getGoogleDriveIntegrationStatus } from "@/lib/integrations/google-drive"
import { getHomeAssistantIntegrationStatus } from "@/lib/integrations/home-assistant"
import { getWhatsAppIntegrationStatus } from "@/lib/integrations/whatsapp"
import {
  getIntegrationConnection,
  listConnectionProfiles,
  listIntegrationConnectionGrants,
  listIntegrationConnectionPreferences,
  listIntegrationConnections,
  revokeIntegrationConnectionGrant,
  setPreferredIntegrationConnection,
} from "@/lib/integrations/connection-store"
import { requireAdminRequestProfile } from "@/lib/profiles/server"
import { grantIntegrationConnectionToProfile } from "@/lib/profiles/access-management"

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
    await warmConnectionRecords(request)
    return NextResponse.json({
      profiles: listConnectionProfiles(),
      connections: listIntegrationConnections(),
      grants: listIntegrationConnectionGrants(),
      preferences: listIntegrationConnectionPreferences(),
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
        const grant = grantIntegrationConnectionToProfile({
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

      const connection = getIntegrationConnection(parsed.data.connectionId)
      if (!connection) throw new Error("Connection not found.")
      const selected = setPreferredIntegrationConnection({
        profileId: parsed.data.profileId,
        provider: connection.provider,
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

async function warmConnectionRecords(request: Request): Promise<void> {
  const origin = resolveRequestOrigin(request)
  await Promise.allSettled([
    getGmailIntegrationStatus(origin, false),
    getGoogleCalendarIntegrationStatus(origin, false),
    getGoogleDriveIntegrationStatus(origin, false),
    getHomeAssistantIntegrationStatus(false),
    getWhatsAppIntegrationStatus(origin),
  ])
}
