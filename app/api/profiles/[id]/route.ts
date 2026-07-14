import { NextResponse } from "next/server"

import { closeDatabaseForProfile } from "@/lib/db"
import { emitAppEvent } from "@/lib/events"
import { invalidateMapsConnectionProbe } from "@/lib/integrations/maps"
import { invalidateWeatherConnectionProbe } from "@/lib/integrations/weather"
import {
  adminProfileView,
  profileStore,
  requireAdminProfile,
  updateProfileInputFromBody,
} from "@/lib/profiles/server"
import { invalidateWeatherProviderState } from "@/lib/weather/providers"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const current = await requireAdminProfile()
  if (current instanceof NextResponse) return current
  try {
    const { id } = await params
    const body = await request.json()
    const existing = profileStore.getProfile(id)
    const profile = profileStore.updateProfile(
      id,
      updateProfileInputFromBody(body),
      current.profile.id
    )
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 })
    }
    if (
      existing &&
      existing.permissions.inheritAdminApiKeys !==
        profile.permissions.inheritAdminApiKeys
    ) {
      invalidateMapsConnectionProbe()
      invalidateWeatherConnectionProbe()
      invalidateWeatherProviderState()
      emitAppEvent({ type: "settings.changed", reason: "env" })
    }
    return NextResponse.json({ profile: adminProfileView(profile) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update profile" },
      { status: 400 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const current = await requireAdminProfile()
  if (current instanceof NextResponse) return current
  try {
    const { id } = await params
    const profile = profileStore.getProfile(id)
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 })
    }
    if (!profile.disabledAt) {
      return NextResponse.json(
        { error: "Deactivate the profile before deleting it permanently." },
        { status: 400 }
      )
    }

    let body: unknown = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const parsed =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}
    const confirmName =
      typeof parsed.confirmName === "string" ? parsed.confirmName.trim() : ""
    if (confirmName !== profile.name) {
      return NextResponse.json(
        { error: "Profile name confirmation is required." },
        { status: 400 }
      )
    }

    const deleteState = parsed.deleteState === true
    // A deleted profile can no longer use its connection, even when its files
    // are intentionally retained for manual recovery.
    closeDatabaseForProfile(id)
    const deleted = profileStore.deleteProfile(id, current.profile.id, {
      deleteState,
    })
    return NextResponse.json({ success: deleted })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete profile" },
      { status: 400 }
    )
  }
}
