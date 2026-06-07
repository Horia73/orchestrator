"use client"

import * as React from "react"
import { Plus, Save, Trash2 } from "lucide-react"

import type { AdminProfileView } from "@/lib/profiles/server"
import {
  INTEGRATION_PERMISSION_IDS,
  PROFILE_SURFACES,
  TOOL_PERMISSION_IDS,
  normalizeProfilePermissions,
  type IntegrationAccess,
  type ProfileAuditEvent,
  type ProfileRole,
} from "@/lib/profiles/types"

const ACCESS: IntegrationAccess[] = ["none", "read", "write", "setup"]

export function ProfilesTab() {
  const [profiles, setProfiles] = React.useState<AdminProfileView[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AdminProfileView | null>(null)
  const [newName, setNewName] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [profilePassword, setProfilePassword] = React.useState("")
  const [clearProfilePassword, setClearProfilePassword] = React.useState(false)
  const [audit, setAudit] = React.useState<ProfileAuditEvent[]>([])
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const selected = draft ?? profiles.find((profile) => profile.id === selectedId) ?? null

  const load = React.useCallback(async () => {
    const [profilesRes, auditRes] = await Promise.all([
      fetch("/api/profiles", { cache: "no-store" }),
      fetch("/api/profiles/audit?limit=80", { cache: "no-store" }),
    ])
    const profilesData = await profilesRes.json()
    const auditData = await auditRes.json()
    const rows = (profilesData.profiles ?? []) as AdminProfileView[]
    setProfiles(rows)
    setAudit((auditData.events ?? []) as ProfileAuditEvent[])
    setSelectedId((current) => current ?? rows[0]?.id ?? null)
  }, [])

  React.useEffect(() => {
    void load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load profiles")
    )
  }, [load])

  React.useEffect(() => {
    const profile = profiles.find((item) => item.id === selectedId) ?? null
    setDraft(profile ? structuredClone(profile) : null)
    setProfilePassword("")
    setClearProfilePassword(false)
  }, [profiles, selectedId])

  async function createProfile(event: React.FormEvent) {
    event.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          role: "member",
          password: newPassword || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to create profile")
      setNewName("")
      setNewPassword("")
      await load()
      setSelectedId(data.profile?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create profile")
    } finally {
      setSaving(false)
    }
  }

  async function saveProfile() {
    if (!draft) return
    const password = profilePassword.trim()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          role: draft.role,
          color: draft.color,
          avatar: draft.avatar,
          permissions: normalizeProfilePermissions(draft.permissions, draft.role),
          ...(password ? { password } : {}),
          ...(clearProfilePassword && !password ? { clearPassword: true } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to save profile")
      setProfilePassword("")
      setClearProfilePassword(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile")
    } finally {
      setSaving(false)
    }
  }

  async function deleteProfile(profile: AdminProfileView) {
    if (profile.role === "admin") return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profile.id)}`, {
        method: "DELETE",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to delete profile")
      setSelectedId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete profile")
    } finally {
      setSaving(false)
    }
  }

  function updateDraft(mutator: (profile: AdminProfileView) => void) {
    setDraft((current) => {
      if (!current) return current
      const next = structuredClone(current)
      mutator(next)
      return next
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-3">
        <form onSubmit={createProfile} className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-sm font-medium">Create profile</div>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Name"
            className="mb-2 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
          <input
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="Optional password"
            type="password"
            className="mb-2 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
          <button
            type="submit"
            disabled={saving || !newName.trim()}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
          >
            <Plus className="size-4" />
            Add profile
          </button>
        </form>

        <div className="rounded-md border border-border bg-card p-1">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => setSelectedId(profile.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${
                profile.id === selectedId ? "bg-muted text-foreground" : "text-foreground/70 hover:bg-muted/60"
              }`}
            >
              <span
                className="size-3 rounded-sm"
                style={{ backgroundColor: profile.color }}
              />
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              <span className="text-[11px] text-muted-foreground">{profile.role}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {selected ? (
          <div className="rounded-md border border-border bg-card p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">{selected.name}</h2>
                <p className="text-xs text-muted-foreground">
                  Access applies to UI, API routes, model tool exposure, and tool execution.
                </p>
              </div>
              <div className="flex gap-2">
                {selected.role !== "admin" && (
                  <button
                    type="button"
                    onClick={() => void deleteProfile(selected)}
                    disabled={saving}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm"
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void saveProfile()}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
                >
                  <Save className="size-4" />
                  Save
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Name
                <input
                  value={selected.name}
                  onChange={(event) => updateDraft((p) => { p.name = event.target.value })}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Role
                <select
                  value={selected.role}
                  disabled={selected.id === "admin_horia"}
                  onChange={(event) =>
                    updateDraft((p) => { p.role = event.target.value as ProfileRole })
                  }
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Color
                <input
                  value={selected.color}
                  onChange={(event) => updateDraft((p) => { p.color = event.target.value })}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                />
              </label>
            </div>

            <Section title="Password">
              <div className="space-y-3 rounded-md border border-border bg-background p-3 sm:col-span-2 lg:col-span-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {selected.locked ? "Password enabled" : "No password"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Profiles can stay open by default. Set a password here only when needed.
                    </div>
                  </div>
                  {selected.locked && (
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearProfilePassword}
                        disabled={Boolean(profilePassword)}
                        onChange={(event) => setClearProfilePassword(event.target.checked)}
                      />
                      Remove password
                    </label>
                  )}
                </div>
                <input
                  value={profilePassword}
                  onChange={(event) => {
                    setProfilePassword(event.target.value)
                    if (event.target.value) setClearProfilePassword(false)
                  }}
                  placeholder={
                    selected.locked
                      ? "New password (leave blank to keep current)"
                      : "New password"
                  }
                  type="password"
                  className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
                />
              </div>
            </Section>

            <Section title="Surfaces">
              {PROFILE_SURFACES.map((surface) => (
                <Toggle
                  key={surface}
                  label={surface}
                  checked={selected.permissions.surfaces[surface]}
                  disabled={selected.role === "admin"}
                  onChange={(checked) =>
                    updateDraft((p) => { p.permissions.surfaces[surface] = checked })
                  }
                />
              ))}
            </Section>

            <Section title="Tools">
              {TOOL_PERMISSION_IDS.map((tool) => (
                <Toggle
                  key={tool}
                  label={tool}
                  checked={selected.permissions.tools[tool]}
                  disabled={selected.role === "admin"}
                  onChange={(checked) =>
                    updateDraft((p) => { p.permissions.tools[tool] = checked })
                  }
                />
              ))}
            </Section>

            <Section title="Integrations">
              <div className="grid gap-2 sm:grid-cols-2">
                {INTEGRATION_PERMISSION_IDS.map((integration) => (
                  <label
                    key={integration}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <span>{integration}</span>
                    <select
                      value={selected.permissions.integrations[integration]}
                      disabled={selected.role === "admin"}
                      onChange={(event) =>
                        updateDraft((p) => {
                          p.permissions.integrations[integration] = event.target.value as IntegrationAccess
                        })
                      }
                      className="h-8 rounded-md border border-border bg-card px-2 text-xs"
                    >
                      {ACCESS.map((access) => (
                        <option key={access} value={access}>{access}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <Toggle
                label="inherit admin API keys"
                checked={selected.permissions.inheritAdminApiKeys}
                disabled={selected.role === "admin"}
                onChange={(checked) =>
                  updateDraft((p) => { p.permissions.inheritAdminApiKeys = checked })
                }
              />
            </Section>
          </div>
        ) : null}

        <div className="rounded-md border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">Recent profile activity</h2>
          <div className="space-y-2">
            {audit.map((event) => (
              <div key={event.id} className="flex gap-3 text-xs">
                <span className="w-36 shrink-0 text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
                <span className="min-w-0 flex-1">{event.summary}</span>
              </div>
            ))}
            {audit.length === 0 && (
              <div className="text-sm text-muted-foreground">No profile activity yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  )
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  )
}
