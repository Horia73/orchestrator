import { NextResponse } from "next/server"

import {
  adminProfileView,
  profileStore,
  requireAdminProfile,
  updateProfileInputFromBody,
} from "@/lib/profiles/server"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const current = await requireAdminProfile()
  if (current instanceof NextResponse) return current
  try {
    const { id } = await params
    const body = await request.json()
    const profile = profileStore.updateProfile(
      id,
      updateProfileInputFromBody(body),
      current.profile.id
    )
    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 })
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
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const current = await requireAdminProfile()
  if (current instanceof NextResponse) return current
  try {
    const { id } = await params
    const deleted = profileStore.deleteProfile(id, current.profile.id)
    return NextResponse.json({ success: deleted })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete profile" },
      { status: 400 }
    )
  }
}
