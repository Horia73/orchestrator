"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { LockKeyhole, Plus, UserRound } from "lucide-react"

import { profileInitials, fetchProfiles } from "./use-profiles"
import type { PublicProfile } from "@/lib/profiles/server"

const COLORS = ["#2f6f73", "#7c3f58", "#556b2f", "#7b5d2a", "#385f8f", "#6f4d8f"]

export function ProfilePicker() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [profiles, setProfiles] = React.useState<PublicProfile[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<PublicProfile | null>(null)
  const [password, setPassword] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const next = sanitizeNext(searchParams.get("next"))

  React.useEffect(() => {
    let cancelled = false
    fetchProfiles()
      .then(({ profiles }) => {
        if (!cancelled) setProfiles(profiles as PublicProfile[])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function openCreateProfile() {
    if (busy) return
    setCreating(true)
    setSelected(null)
    setPassword("")
    setNewName("")
    setError(null)
  }

  async function selectProfile(profile: PublicProfile) {
    if (busy) return
    setCreating(false)
    setNewName("")
    setError(null)
    setPassword("")
    if (profile.locked) {
      setSelected(profile)
      return
    }
    setSelected(null)
    await submitSelection(profile, "")
  }

  async function submitSelection(profile = selected, directPassword = password) {
    if (!profile) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/profiles/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: profile.id,
          password: directPassword,
          deviceLabel: navigator.userAgent,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not select profile.")
        return
      }
      router.replace(next)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function createProfile(event: React.FormEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          role: "member",
          color: COLORS[profiles.length % COLORS.length],
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not create profile.")
        return
      }
      const created = data.profile as PublicProfile
      setProfiles((items) => [...items, created])
      setCreating(false)
      setNewName("")
      await submitSelection(created, "")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="relative flex min-h-dvh w-full flex-1 items-center justify-center overflow-hidden bg-background px-5 py-8 text-foreground sm:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0)_42%,rgba(0,0,0,0.035))] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0)_42%,rgba(0,0,0,0.22))]" />
      <div className="relative flex w-full max-w-6xl flex-col items-center justify-center text-center">
        <div className="mb-12 sm:mb-14">
          <div className="mb-4 text-xs font-medium tracking-[0.22em] text-foreground/40 uppercase">
            Orchestrator
          </div>
          <h1 className="text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
            Who&apos;s using Orchestrator?
          </h1>
        </div>

        {loading ? (
          <div className="text-center text-sm text-muted-foreground">Loading profiles...</div>
        ) : (
          <div className="flex w-full flex-wrap items-start justify-center gap-x-6 gap-y-8 sm:gap-x-9 sm:gap-y-10">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                disabled={busy}
                onClick={() => selectProfile(profile)}
                className="group flex w-36 min-w-0 flex-col items-center gap-4 rounded-md p-2 text-center outline-none transition duration-200 ease-out hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:pointer-events-none disabled:opacity-60 sm:w-44 md:w-48"
              >
                <div
                  className="relative grid size-32 place-items-center overflow-hidden rounded-md text-5xl font-semibold text-white shadow-[0_18px_48px_-28px_rgba(0,0,0,0.65)] ring-1 ring-black/10 transition duration-200 group-hover:shadow-[0_24px_60px_-30px_rgba(0,0,0,0.72)] group-hover:ring-4 group-hover:ring-foreground/20 sm:size-40 sm:text-6xl md:size-44"
                  style={{ backgroundColor: profile.color }}
                >
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(145deg,rgba(255,255,255,0.22),rgba(255,255,255,0)_42%,rgba(0,0,0,0.16))]" />
                  {profile.avatar ? (
                    <span className="relative text-6xl sm:text-7xl">{profile.avatar}</span>
                  ) : (
                    <span className="relative">{profileInitials(profile.name)}</span>
                  )}
                  {profile.locked && (
                    <span className="absolute top-3 right-3 rounded-full bg-black/25 p-1.5">
                      <LockKeyhole className="size-4" />
                    </span>
                  )}
                </div>
                <span className="w-full truncate text-base font-medium text-foreground/70 group-hover:text-foreground sm:text-lg">
                  {profile.name}
                </span>
              </button>
            ))}

            <button
              type="button"
              disabled={busy}
              onClick={openCreateProfile}
              className="group flex w-36 min-w-0 flex-col items-center gap-4 rounded-md p-2 text-center outline-none transition duration-200 ease-out hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:pointer-events-none disabled:opacity-60 sm:w-44 md:w-48"
            >
              <div className="grid size-32 place-items-center rounded-md border border-dashed border-foreground/25 bg-muted/35 text-foreground/45 shadow-[0_18px_48px_-34px_rgba(0,0,0,0.45)] transition duration-200 group-hover:border-foreground/45 group-hover:bg-muted/55 group-hover:text-foreground sm:size-40 md:size-44">
                <Plus className="size-12 sm:size-14" />
              </div>
              <span className="text-base font-medium text-foreground/55 group-hover:text-foreground sm:text-lg">
                Add profile
              </span>
            </button>
          </div>
        )}

        {(selected || creating || error) && (
          <div className="mx-auto mt-12 w-full max-w-md rounded-md border border-border/80 bg-card/95 p-5 text-left shadow-[0_24px_70px_-40px_rgba(0,0,0,0.65)] backdrop-blur">
            {selected && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitSelection()
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="grid size-12 place-items-center rounded-md text-base font-semibold text-white"
                    style={{ backgroundColor: selected.color }}
                  >
                    <UserRound className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-base font-medium">{selected.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Enter password
                    </div>
                  </div>
                </div>
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                  className="h-12 w-full rounded-md border border-border bg-background px-3 text-base outline-none focus:border-foreground/30"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !password}
                    className="h-11 flex-1 rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null)
                      setPassword("")
                      setError(null)
                    }}
                    className="h-11 rounded-md border border-border px-4 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {creating && (
              <form className="space-y-4" onSubmit={createProfile}>
                <div>
                  <div className="text-base font-medium">New profile</div>
                  <div className="text-xs text-muted-foreground">
                    It starts with its own workspace and data.
                  </div>
                </div>
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Profile name"
                  className="h-12 w-full rounded-md border border-border bg-background px-3 text-base outline-none focus:border-foreground/30"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !newName.trim()}
                    className="h-11 flex-1 rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false)
                      setNewName("")
                      setError(null)
                    }}
                    className="h-11 rounded-md border border-border px-4 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </div>
        )}
      </div>
    </main>
  )
}

function sanitizeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/"
  if (value.startsWith("/profiles")) return "/"
  return value
}
