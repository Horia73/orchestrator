"use client"

import * as React from "react"

import type {
  AdminProfileView,
  PublicProfile,
} from "@/lib/profiles/server"
import type { ProfilePermissions } from "@/lib/profiles/types"

export interface CurrentProfileResponse {
  profile: PublicProfile | null
  permissions?: ProfilePermissions
  isAdmin: boolean
}

export async function fetchCurrentProfile(): Promise<CurrentProfileResponse> {
  const res = await fetch("/api/profiles/current", { cache: "no-store" })
  if (!res.ok) return { profile: null, isAdmin: false }
  return (await res.json()) as CurrentProfileResponse
}

let currentProfileCache: CurrentProfileResponse | null = null
let currentProfileRequest: Promise<CurrentProfileResponse> | null = null

function loadCurrentProfile(): Promise<CurrentProfileResponse> {
  if (!currentProfileRequest) {
    currentProfileRequest = fetchCurrentProfile()
      .then((next) => {
        currentProfileCache = next
        return next
      })
      .finally(() => {
        currentProfileRequest = null
      })
  }

  return currentProfileRequest
}

export async function fetchProfiles(): Promise<{
  profiles: Array<AdminProfileView | PublicProfile>
  isAdmin: boolean
  currentProfileId: string | null
}> {
  const res = await fetch("/api/profiles", { cache: "no-store" })
  if (!res.ok) return { profiles: [], isAdmin: false, currentProfileId: null }
  return (await res.json()) as {
    profiles: Array<AdminProfileView | PublicProfile>
    isAdmin: boolean
    currentProfileId: string | null
  }
}

export function useCurrentProfile() {
  const [state, setState] = React.useState<CurrentProfileResponse>(
    () => currentProfileCache ?? { profile: null, isAdmin: false }
  )
  const [loading, setLoading] = React.useState(currentProfileCache === null)

  React.useEffect(() => {
    let cancelled = false
    loadCurrentProfile()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { ...state, loading }
}

export function profileInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || "P"
}
