import { NextResponse } from "next/server"

import {
  adminProfileView,
  createProfileInputFromBody,
  getCurrentProfileFromRequest,
  listAdminProfiles,
  listPublicProfiles,
  profileStore,
  publicProfile,
} from "@/lib/profiles/server"

export async function GET(request: Request) {
  const current = getCurrentProfileFromRequest(request)
  if (current?.isAdmin) {
    return NextResponse.json({
      profiles: listAdminProfiles(),
      isAdmin: true,
      currentProfileId: current.profile.id,
    })
  }
  return NextResponse.json({
    profiles: listPublicProfiles(),
    isAdmin: false,
    currentProfileId: current?.profile.id ?? null,
  })
}

export async function POST(request: Request) {
  try {
    const current = getCurrentProfileFromRequest(request)
    const body = await request.json()
    const input = createProfileInputFromBody(
      body,
      current?.isAdmin ? undefined : "member"
    )
    const profile = profileStore.createProfile(input, current?.profile.id ?? null)
    return NextResponse.json(
      { profile: current?.isAdmin ? adminProfileView(profile) : publicProfile(profile) },
      { status: 201 }
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create profile" },
      { status: 400 }
    )
  }
}
