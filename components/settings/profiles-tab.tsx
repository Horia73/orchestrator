"use client"

import * as React from "react"
import {
  Activity,
  AppWindow,
  Archive,
  Bot,
  Braces,
  Brain,
  Calendar,
  CalendarClock,
  CloudSun,
  Cpu,
  Download,
  Dumbbell,
  Eye,
  EyeOff,
  FileCog,
  FilePen,
  FileText,
  Globe,
  HardDrive,
  House,
  Inbox,
  KeyRound,
  Library,
  Lock,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Telescope,
  Terminal,
  Trash2,
  UserPlus,
  UserX,
  Users,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { profileInitials } from "@/components/profiles/use-profiles"
import type { AdminProfileView } from "@/lib/profiles/server"
import {
  INTEGRATION_PERMISSION_IDS,
  PROFILE_SURFACES,
  TOOL_PERMISSION_IDS,
  normalizeProfilePermissions,
  type IntegrationAccess,
  type IntegrationPermissionId,
  type ProfileAuditEvent,
  type ProfileRole,
  type ProfileSurface,
  type ToolPermissionId,
} from "@/lib/profiles/types"

type IconType = React.ComponentType<{ className?: string }>
type GrantAccess = "read" | "write" | "setup"

interface IntegrationConnectionView {
  id: string
  provider: "home_assistant"
  ownerProfileId: string
  displayName: string
  createdAt: number
  updatedAt: number
}

interface IntegrationConnectionGrantView {
  connectionId: string
  profileId: string
  access: GrantAccess
  createdByProfileId: string | null
  createdAt: number
  updatedAt: number
}

interface IntegrationConnectionPreferenceView {
  profileId: string
  provider: "home_assistant"
  connectionId: string
  updatedAt: number
}

const SURFACE_META: Record<
  ProfileSurface,
  { label: string; description: string; icon: IconType }
> = {
  chat: {
    label: "Chat",
    description: "Main conversation workspace",
    icon: MessageSquare,
  },
  inbox: {
    label: "Inbox",
    description: "Incoming messages and triage",
    icon: Inbox,
  },
  library: {
    label: "Library",
    description: "Saved files and artifacts",
    icon: Library,
  },
  scheduling: {
    label: "Scheduling",
    description: "Scheduled tasks and routines",
    icon: CalendarClock,
  },
  watchlist: {
    label: "Watchlist",
    description: "Tracked topics and feeds",
    icon: Telescope,
  },
  monitor: {
    label: "Smart Monitor",
    description: "Background monitoring engine",
    icon: Activity,
  },
  maps: {
    label: "Smart Maps",
    description: "Maps and location surface",
    icon: MapPin,
  },
  workouts: {
    label: "Workouts",
    description: "Fitness tracking surface",
    icon: Dumbbell,
  },
  settings: {
    label: "Settings",
    description: "Admin configuration pages",
    icon: Settings,
  },
}

const TOOL_META: Record<
  ToolPermissionId,
  { label: string; description: string; icon: IconType }
> = {
  read_files: {
    label: "Read files",
    description: "Read workspace files",
    icon: FileText,
  },
  write_files: {
    label: "Write files",
    description: "Create and edit files",
    icon: FilePen,
  },
  shell: { label: "Shell", description: "Run shell commands", icon: Terminal },
  browser_agent: {
    label: "Browser agent",
    description: "Drive a headless browser",
    icon: AppWindow,
  },
  delegate_agents: {
    label: "Delegate agents",
    description: "Spawn sub-agents",
    icon: Bot,
  },
  web_access: {
    label: "Web access",
    description: "Search and fetch the web",
    icon: Globe,
  },
  memory: {
    label: "Memory",
    description: "Read and write long-term memory",
    icon: Brain,
  },
  skills: {
    label: "Skills",
    description: "Use installed workflow skills",
    icon: Braces,
  },
  scheduling: {
    label: "Scheduling",
    description: "Create scheduled tasks",
    icon: CalendarClock,
  },
  monitoring: {
    label: "Monitoring",
    description: "Configure Smart Monitor",
    icon: Activity,
  },
  microscripts: {
    label: "Microscripts",
    description: "Run saved microscripts",
    icon: Braces,
  },
  backups: {
    label: "Backups",
    description: "Create and restore backups",
    icon: Archive,
  },
  updates: {
    label: "Updates",
    description: "Apply app updates",
    icon: Download,
  },
  models: {
    label: "Allow model changes",
    description: "Let this profile choose its own agent models",
    icon: Cpu,
  },
  settings_files: {
    label: "Settings files",
    description: "Edit raw settings files",
    icon: FileCog,
  },
}

const INTEGRATION_META: Record<
  IntegrationPermissionId,
  { label: string; icon: IconType }
> = {
  gmail: { label: "Gmail", icon: Mail },
  google_calendar: { label: "Google Calendar", icon: Calendar },
  google_drive: { label: "Google Drive", icon: HardDrive },
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  home_assistant: { label: "Home Assistant", icon: House },
  maps: { label: "Maps", icon: MapPin },
  weather: { label: "Weather", icon: CloudSun },
}

const ACCESS_OPTIONS: { value: IntegrationAccess; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read & write" },
  { value: "setup", label: "Manage" },
]

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
]

const SWATCHES = [
  "#2f6f73",
  "#7c3f58",
  "#556b2f",
  "#7b5d2a",
  "#385f8f",
  "#6f4d8f",
]

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const m = 60_000
  const h = 60 * m
  const d = 24 * h
  if (diff < m) return "just now"
  if (diff < h) return `${Math.floor(diff / m)}m ago`
  if (diff < d) return `${Math.floor(diff / h)}h ago`
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })
}

export function ProfilesTab() {
  const { confirm, dialog } = useConfirm()
  const [profiles, setProfiles] = React.useState<AdminProfileView[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AdminProfileView | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [showNewPassword, setShowNewPassword] = React.useState(false)
  const [profilePassword, setProfilePassword] = React.useState("")
  const [profilePasswordConfirm, setProfilePasswordConfirm] = React.useState("")
  const [showProfilePassword, setShowProfilePassword] = React.useState(false)
  const [clearProfilePassword, setClearProfilePassword] = React.useState(false)
  const [audit, setAudit] = React.useState<ProfileAuditEvent[]>([])
  const [connections, setConnections] = React.useState<
    IntegrationConnectionView[]
  >([])
  const [connectionGrants, setConnectionGrants] = React.useState<
    IntegrationConnectionGrantView[]
  >([])
  const [connectionPreferences, setConnectionPreferences] = React.useState<
    IntegrationConnectionPreferenceView[]
  >([])
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<AdminProfileView | null>(null)
  const [deleteConfirmName, setDeleteConfirmName] = React.useState("")
  const [deleteProfileData, setDeleteProfileData] = React.useState(true)

  const original = profiles.find((profile) => profile.id === selectedId) ?? null
  const selected = draft ?? original

  const dirty = React.useMemo(() => {
    if (!draft || !original) return false
    if (profilePassword.trim() || clearProfilePassword) return true
    return JSON.stringify(draft) !== JSON.stringify(original)
  }, [draft, original, profilePassword, clearProfilePassword])

  const passwordError = React.useMemo(() => {
    const next = profilePassword.trim()
    if (!next) return null
    if (next.length < 4) return "Password must be at least 4 characters."
    if (next !== profilePasswordConfirm.trim()) return "Passwords don't match."
    return null
  }, [profilePassword, profilePasswordConfirm])

  const load = React.useCallback(async () => {
    const [profilesRes, auditRes, connectionsRes] = await Promise.all([
      fetch("/api/profiles", { cache: "no-store" }),
      fetch("/api/profiles/audit?limit=80", { cache: "no-store" }),
      fetch("/api/integrations/connections", { cache: "no-store" }),
    ])
    const profilesData = await profilesRes.json()
    const auditData = await auditRes.json()
    const connectionsData = connectionsRes.ok
      ? await connectionsRes.json()
      : { connections: [], grants: [], preferences: [] }
    const rows = (profilesData.profiles ?? []) as AdminProfileView[]
    setProfiles(rows)
    setAudit((auditData.events ?? []) as ProfileAuditEvent[])
    setConnections(
      (connectionsData.connections ?? []) as IntegrationConnectionView[]
    )
    setConnectionGrants(
      (connectionsData.grants ?? []) as IntegrationConnectionGrantView[]
    )
    setConnectionPreferences(
      (connectionsData.preferences ??
        []) as IntegrationConnectionPreferenceView[]
    )
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
    setProfilePasswordConfirm("")
    setShowProfilePassword(false)
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
      setCreating(false)
      await load()
      setSelectedId(data.profile?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create profile")
    } finally {
      setSaving(false)
    }
  }

  async function saveProfile() {
    if (!draft || passwordError) return
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
          permissions: normalizeProfilePermissions(
            draft.permissions,
            draft.role
          ),
          ...(password ? { password } : {}),
          ...(clearProfilePassword && !password ? { clearPassword: true } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to save profile")
      setProfilePassword("")
      setProfilePasswordConfirm("")
      setShowProfilePassword(false)
      setClearProfilePassword(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile")
    } finally {
      setSaving(false)
    }
  }

  async function patchProfileStatus(
    profile: AdminProfileView,
    disabledAt: number | null,
    failureMessage: string
  ) {
    if (profile.role === "admin") return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profile.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabledAt }),
        }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? failureMessage)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : failureMessage)
    } finally {
      setSaving(false)
    }
  }

  async function deactivateProfile(profile: AdminProfileView) {
    const ok = await confirm({
      title: `Deactivate "${profile.name}"?`,
      message:
        "This removes the profile from sign-in and blocks existing sessions, but keeps its workspace, tokens, chats, and settings for restore.",
      confirmLabel: "Deactivate",
      destructive: true,
    })
    if (!ok) return
    await patchProfileStatus(
      profile,
      Date.now(),
      "Failed to deactivate profile"
    )
  }

  async function restoreProfile(profile: AdminProfileView) {
    const ok = await confirm({
      title: `Restore "${profile.name}"?`,
      message: "This profile will be selectable again on the profile screen.",
      confirmLabel: "Restore",
    })
    if (!ok) return
    await patchProfileStatus(profile, null, "Failed to restore profile")
  }

  function openPermanentDelete(profile: AdminProfileView) {
    setDeleteTarget(profile)
    setDeleteConfirmName("")
    setDeleteProfileData(true)
  }

  async function deleteProfilePermanently(profile: AdminProfileView) {
    if (profile.role === "admin") return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profile.id)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmName: deleteConfirmName.trim(),
            deleteState: deleteProfileData,
          }),
        }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(data.error ?? "Failed to permanently delete profile")
      setDeleteTarget(null)
      setDeleteConfirmName("")
      setSelectedId(null)
      await load()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to permanently delete profile"
      )
    } finally {
      setSaving(false)
    }
  }

  async function updateHomeAssistantGrant(
    profile: AdminProfileView,
    connectionId: string,
    access: IntegrationAccess
  ) {
    if (profile.role === "admin") return
    setSaving(true)
    setError(null)
    try {
      const body =
        access === "none"
          ? { action: "revoke", profileId: profile.id, connectionId }
          : { action: "grant", profileId: profile.id, connectionId, access }
      const res = await fetch("/api/integrations/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(data.error ?? "Failed to update Home Assistant access")
      await load()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update Home Assistant access"
      )
    } finally {
      setSaving(false)
    }
  }

  async function setHomeAssistantDefault(
    profile: AdminProfileView,
    connectionId: string
  ) {
    if (profile.role === "admin") return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/integrations/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "prefer",
          profileId: profile.id,
          connectionId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(data.error ?? "Failed to set default connection")
      await load()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set default connection"
      )
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

  const isAdmin = selected?.role === "admin"
  const lockRole = selected?.id === "admin_horia"

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* Left column — roster */}
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="text-[13px] font-semibold text-foreground/70">
              Profiles{" "}
              <span className="font-normal text-foreground/40">
                · {profiles.length}
              </span>
            </div>
            <Button
              size="sm"
              variant={creating ? "secondary" : "outline"}
              onClick={() => setCreating((value) => !value)}
            >
              {creating ? (
                <X className="size-3.5" />
              ) : (
                <Plus className="size-3.5" />
              )}
              {creating ? "Cancel" : "New"}
            </Button>
          </div>

          {creating && (
            <form
              onSubmit={createProfile}
              className="space-y-2 rounded-2xl border border-border/70 bg-card p-3 shadow-[0_1px_0_0_rgba(0,0,0,0.02)]"
            >
              <Input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Name"
                className="h-9"
              />
              <PasswordInput
                value={newPassword}
                onChange={setNewPassword}
                placeholder="Optional password"
                show={showNewPassword}
                onToggleShow={() => setShowNewPassword((value) => !value)}
              />
              <Button
                type="submit"
                size="lg"
                disabled={saving || !newName.trim()}
                className="w-full"
              >
                <UserPlus className="size-4" />
                Create profile
              </Button>
            </form>
          )}

          <div className="space-y-0.5 rounded-2xl border border-border/70 bg-card p-1.5 shadow-[0_1px_0_0_rgba(0,0,0,0.02)]">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => setSelectedId(profile.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                  profile.id === selectedId
                    ? "bg-[#f0ede6] dark:bg-muted"
                    : "hover:bg-[#f0ede6]/60 dark:hover:bg-muted/50",
                  profile.disabledAt && "opacity-60"
                )}
              >
                <span
                  className="grid size-9 shrink-0 place-items-center rounded-xl text-[12px] font-semibold text-white"
                  style={{ backgroundColor: profile.color }}
                >
                  {profileInitials(profile.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-foreground">
                      {profile.name}
                    </span>
                    {profile.locked && (
                      <Lock className="size-3 shrink-0 text-foreground/40" />
                    )}
                    {profile.disabledAt && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-foreground/45 uppercase">
                        Disabled
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[12px] text-foreground/45 capitalize">
                    {profile.disabledAt ? "inactive" : profile.role}
                  </span>
                </span>
              </button>
            ))}
            {profiles.length === 0 && (
              <div className="px-3 py-6 text-center text-[13px] text-foreground/45">
                No profiles yet.
              </div>
            )}
          </div>
        </div>

        {/* Right column — editor */}
        <div className="min-w-0 space-y-4">
          {error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
              {error}
            </div>
          )}

          {selected ? (
            <>
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-[0_1px_0_0_rgba(0,0,0,0.02)]">
                <div className="flex min-w-0 items-center gap-3.5">
                  <span
                    className="grid size-12 shrink-0 place-items-center rounded-2xl text-[16px] font-semibold text-white"
                    style={{ backgroundColor: selected.color }}
                  >
                    {profileInitials(selected.name || "?")}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-[17px] font-semibold tracking-tight text-foreground">
                        {selected.name || "Untitled profile"}
                      </h2>
                      <RoleBadge role={selected.role} />
                      {selected.disabledAt && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/55">
                          Disabled
                        </span>
                      )}
                      {selected.locked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/55">
                          <Lock className="size-3" />
                          Password
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-foreground/45">
                      Updated {timeAgo(selected.updatedAt)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selected.role !== "admin" && selected.disabledAt ? (
                    <>
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => void restoreProfile(selected)}
                        disabled={saving}
                      >
                        <RotateCcw className="size-4" />
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="lg"
                        onClick={() => openPermanentDelete(selected)}
                        disabled={saving}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete permanently
                      </Button>
                    </>
                  ) : selected.role !== "admin" ? (
                    <Button
                      variant="ghost"
                      size="lg"
                      onClick={() => void deactivateProfile(selected)}
                      disabled={saving}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <UserX className="size-4" />
                      Deactivate
                    </Button>
                  ) : null}
                  <Button
                    size="lg"
                    onClick={() => void saveProfile()}
                    disabled={saving || !dirty || Boolean(passwordError)}
                  >
                    <Save className="size-4" />
                    {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
                  </Button>
                </div>
              </div>

              {/* Identity */}
              <SectionCard
                icon={Users}
                title="Identity"
                description="How this profile shows up across the app."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <Input
                      value={selected.name}
                      onChange={(event) =>
                        updateDraft((p) => {
                          p.name = event.target.value
                        })
                      }
                      className="h-9"
                    />
                  </Field>
                  <Field
                    label="Role"
                    hint={
                      lockRole
                        ? "Built-in owner — role can't be changed."
                        : undefined
                    }
                  >
                    <Select
                      value={selected.role}
                      disabled={lockRole}
                      options={ROLE_OPTIONS}
                      onValueChange={(value) =>
                        updateDraft((p) => {
                          p.role = value as ProfileRole
                        })
                      }
                      className="[&>button]:h-9"
                    />
                  </Field>
                </div>

                <Field label="Color">
                  <div className="flex flex-wrap items-center gap-2">
                    {SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Use ${color}`}
                        onClick={() =>
                          updateDraft((p) => {
                            p.color = color
                          })
                        }
                        className={cn(
                          "size-7 rounded-full ring-offset-2 ring-offset-card transition-shadow",
                          selected.color.toLowerCase() === color.toLowerCase()
                            ? "ring-2 ring-foreground"
                            : "ring-1 ring-border/60 hover:ring-foreground/40"
                        )}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    <span className="mx-1 h-6 w-px bg-border/60" />
                    <input
                      type="color"
                      aria-label="Custom color"
                      value={selected.color}
                      onChange={(event) =>
                        updateDraft((p) => {
                          p.color = event.target.value
                        })
                      }
                      className="size-7 cursor-pointer rounded-md border border-border/60 bg-transparent p-0.5 [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
                    />
                    <Input
                      value={selected.color}
                      onChange={(event) =>
                        updateDraft((p) => {
                          p.color = event.target.value
                        })
                      }
                      className="h-7 w-24 font-mono text-[12px] uppercase"
                    />
                  </div>
                </Field>
              </SectionCard>

              {/* Password */}
              <SectionCard
                icon={KeyRound}
                title="Password"
                description="Profiles stay open by default. Add a password only when you need one."
              >
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-3">
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-foreground">
                      {selected.locked ? "Password protected" : "No password"}
                    </div>
                    <div className="text-[12px] text-foreground/50">
                      {selected.locked
                        ? "This profile asks for a password to sign in."
                        : "Anyone on this device can open this profile."}
                    </div>
                  </div>
                  {selected.locked &&
                    (clearProfilePassword ? (
                      <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-destructive">
                        Will be removed on save
                        <button
                          type="button"
                          onClick={() => setClearProfilePassword(false)}
                          className="rounded-md px-1.5 py-0.5 text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Undo
                        </button>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setClearProfilePassword(true)
                          setProfilePassword("")
                          setProfilePasswordConfirm("")
                        }}
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                        Remove
                      </Button>
                    ))}
                </div>

                {!clearProfilePassword && (
                  <div className="space-y-2">
                    <PasswordInput
                      value={profilePassword}
                      onChange={setProfilePassword}
                      show={showProfilePassword}
                      onToggleShow={() =>
                        setShowProfilePassword((value) => !value)
                      }
                      placeholder={
                        selected.locked
                          ? "New password (leave blank to keep current)"
                          : "Set a password"
                      }
                    />
                    {profilePassword && (
                      <PasswordInput
                        value={profilePasswordConfirm}
                        onChange={setProfilePasswordConfirm}
                        show={showProfilePassword}
                        onToggleShow={() =>
                          setShowProfilePassword((value) => !value)
                        }
                        placeholder="Confirm password"
                      />
                    )}
                    {passwordError && (
                      <p className="text-[12px] text-destructive">
                        {passwordError}
                      </p>
                    )}
                  </div>
                )}
              </SectionCard>

              {isAdmin ? (
                <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/40 px-4 py-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground/60" />
                  <div className="text-[13px] leading-relaxed text-foreground/70">
                    <span className="font-medium text-foreground">
                      Full access.
                    </span>{" "}
                    Admins bypass every permission check, so surface, tool, and
                    integration limits don&apos;t apply. Switch this profile to{" "}
                    <span className="font-medium text-foreground">Member</span>{" "}
                    to set per-area access.
                  </div>
                </div>
              ) : (
                <>
                  {/* Surfaces */}
                  <SectionCard
                    icon={AppWindow}
                    title="Surfaces"
                    description="Pages and workspaces this profile can open."
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      {PROFILE_SURFACES.map((surface) => {
                        const meta = SURFACE_META[surface]
                        return (
                          <ToggleRow
                            key={surface}
                            icon={meta.icon}
                            label={meta.label}
                            description={meta.description}
                            checked={selected.permissions.surfaces[surface]}
                            onChange={(checked) =>
                              updateDraft((p) => {
                                p.permissions.surfaces[surface] = checked
                              })
                            }
                          />
                        )
                      })}
                    </div>
                  </SectionCard>

                  {/* Tools */}
                  <SectionCard
                    icon={Terminal}
                    title="Tools"
                    description="Capabilities the assistant may use on this profile's behalf."
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      {TOOL_PERMISSION_IDS.map((tool) => {
                        const meta = TOOL_META[tool]
                        return (
                          <ToggleRow
                            key={tool}
                            icon={meta.icon}
                            label={meta.label}
                            description={meta.description}
                            checked={selected.permissions.tools[tool]}
                            onChange={(checked) =>
                              updateDraft((p) => {
                                p.permissions.tools[tool] = checked
                              })
                            }
                          />
                        )
                      })}
                    </div>
                  </SectionCard>

                  {/* Integrations */}
                  <SectionCard
                    icon={Globe}
                    title="Integrations"
                    description="Per-connection access level for external services."
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      {INTEGRATION_PERMISSION_IDS.map((integration) => {
                        const meta = INTEGRATION_META[integration]
                        const Icon = meta.icon
                        return (
                          <div
                            key={integration}
                            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-2.5"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/70 text-foreground/70">
                                <Icon className="size-4" />
                              </span>
                              <span className="truncate text-[13.5px] font-medium text-foreground">
                                {meta.label}
                              </span>
                            </div>
                            <Select
                              value={
                                selected.permissions.integrations[integration]
                              }
                              options={ACCESS_OPTIONS}
                              onValueChange={(value) =>
                                updateDraft((p) => {
                                  p.permissions.integrations[integration] =
                                    value as IntegrationAccess
                                })
                              }
                              className="w-[140px] shrink-0 [&>button]:h-8 [&>button]:text-[13px]"
                            />
                          </div>
                        )
                      })}
                    </div>

                    <div className="mt-1 border-t border-border/50 pt-3">
                      <ToggleRow
                        icon={KeyRound}
                        label="Inherit all admin API keys"
                        description="Use inherited env/API keys for models and integrations when this profile has access."
                        checked={selected.permissions.inheritAdminApiKeys}
                        onChange={(checked) =>
                          updateDraft((p) => {
                            p.permissions.inheritAdminApiKeys = checked
                          })
                        }
                      />
                    </div>

                    <HomeAssistantSharingPanel
                      profile={selected}
                      profiles={profiles}
                      connections={connections}
                      grants={connectionGrants}
                      preferences={connectionPreferences}
                      saving={saving}
                      onAccessChange={(connectionId, access) =>
                        void updateHomeAssistantGrant(
                          selected,
                          connectionId,
                          access
                        )
                      }
                      onSetDefault={(connectionId) =>
                        void setHomeAssistantDefault(selected, connectionId)
                      }
                    />
                  </SectionCard>
                </>
              )}
            </>
          ) : (
            <div className="grid place-items-center rounded-2xl border border-dashed border-border/70 bg-card/50 px-6 py-16 text-center">
              <Users className="size-6 text-foreground/30" />
              <p className="mt-3 text-[14px] font-medium text-foreground/70">
                No profile selected
              </p>
              <p className="mt-1 text-[13px] text-foreground/45">
                Pick a profile from the list, or create a new one.
              </p>
            </div>
          )}

          {/* Activity */}
          <SectionCard
            icon={Activity}
            title="Recent activity"
            description="Latest profile changes across the workspace."
          >
            {audit.length === 0 ? (
              <div className="py-2 text-[13px] text-foreground/45">
                No profile activity yet.
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto pr-1 [scrollbar-width:thin]">
                <ol className="-mt-1">
                  {audit.map((event) => (
                    <li
                      key={event.id}
                      className="flex gap-3 border-b border-border/40 py-2.5 last:border-0"
                    >
                      <span className="w-20 shrink-0 pt-px text-[12px] text-foreground/40">
                        {timeAgo(event.createdAt)}
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/75">
                        {event.summary}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
      {dialog}
      <PermanentProfileDeleteDialog
        profile={deleteTarget}
        confirmName={deleteConfirmName}
        deleteProfileData={deleteProfileData}
        saving={saving}
        onConfirmNameChange={setDeleteConfirmName}
        onDeleteProfileDataChange={setDeleteProfileData}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void deleteProfilePermanently(deleteTarget)
        }}
      />
    </>
  )
}

function PermanentProfileDeleteDialog({
  profile,
  confirmName,
  deleteProfileData,
  saving,
  onConfirmNameChange,
  onDeleteProfileDataChange,
  onCancel,
  onConfirm,
}: {
  profile: AdminProfileView | null
  confirmName: string
  deleteProfileData: boolean
  saving: boolean
  onConfirmNameChange: (value: string) => void
  onDeleteProfileDataChange: (value: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  React.useEffect(() => {
    if (!profile) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [profile, onCancel])

  if (!profile) return null

  const canConfirm = confirmName.trim() === profile.name

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-xl border border-border/60 bg-background p-5 shadow-xl">
        <div className="text-[15px] font-semibold text-foreground">
          Delete &quot;{profile.name}&quot; permanently?
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/60">
          This removes the profile record, sessions, and webhook ownership. Type
          the profile name to confirm.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Profile name">
            <Input
              autoFocus
              value={confirmName}
              onChange={(event) => onConfirmNameChange(event.target.value)}
              placeholder={profile.name}
              className="h-9"
            />
          </Field>
          <label className="flex items-start gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-[12.5px] text-foreground/65">
            <input
              type="checkbox"
              checked={deleteProfileData}
              onChange={(event) =>
                onDeleteProfileDataChange(event.target.checked)
              }
              className="mt-0.5"
            />
            <span>
              Delete this profile&apos;s local workspace, private tokens,
              uploads, artifacts, and browser state.
            </span>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-[13px] text-foreground/70 hover:bg-[#f0ede6] disabled:opacity-60 dark:hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving || !canConfirm}
            className="rounded-md bg-[#802020] px-3 py-1.5 text-[13px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Deleting..." : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  )
}

function HomeAssistantSharingPanel({
  profile,
  profiles,
  connections,
  grants,
  preferences,
  saving,
  onAccessChange,
  onSetDefault,
}: {
  profile: AdminProfileView
  profiles: AdminProfileView[]
  connections: IntegrationConnectionView[]
  grants: IntegrationConnectionGrantView[]
  preferences: IntegrationConnectionPreferenceView[]
  saving: boolean
  onAccessChange: (connectionId: string, access: IntegrationAccess) => void
  onSetDefault: (connectionId: string) => void
}) {
  if (profile.role === "admin") return null

  const profileGrants = grants.filter((grant) => grant.profileId === profile.id)
  const grantsByConnection = new Map(
    profileGrants.map((grant) => [grant.connectionId, grant])
  )
  const preferredConnectionId =
    preferences.find(
      (preference) =>
        preference.profileId === profile.id &&
        preference.provider === "home_assistant"
    )?.connectionId ?? null
  const activeConnections = connections.filter((connection) =>
    profiles.some(
      (candidate) =>
        candidate.id === connection.ownerProfileId && !candidate.disabledAt
    )
  )

  return (
    <div className="mt-1 border-t border-border/50 pt-3">
      <div className="mb-2 flex items-start gap-2">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted/70 text-foreground/70">
          <House className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-foreground">
            Home Assistant connections
          </div>
          <div className="text-[12px] text-foreground/50">
            Let this profile use its own connection or a connection shared by
            another profile. Tokens stay with the owner.
          </div>
        </div>
      </div>

      {activeConnections.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-background/60 px-3.5 py-3 text-[12.5px] text-foreground/55">
          No Home Assistant connection records yet. Connect Home Assistant from
          Integrations first, then share it here.
        </div>
      ) : (
        <div className="grid gap-2">
          {activeConnections.map((connection) => {
            const owner = profiles.find(
              (candidate) => candidate.id === connection.ownerProfileId
            )
            const owned = connection.ownerProfileId === profile.id
            const grant = grantsByConnection.get(connection.id)
            const access: IntegrationAccess = owned
              ? "setup"
              : (grant?.access ?? "none")
            const canUse = owned || access !== "none"
            const isDefault =
              preferredConnectionId === connection.id ||
              (!preferredConnectionId && owned)

            return (
              <div
                key={connection.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium text-foreground">
                      {connection.displayName}
                    </span>
                    {owned && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-foreground/50">
                        Own
                      </span>
                    )}
                    {isDefault && canUse && (
                      <span className="rounded-full bg-foreground px-2 py-0.5 text-[10.5px] font-medium text-background">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-foreground/45">
                    Owner: {owner?.name ?? connection.ownerProfileId}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={access}
                    options={ACCESS_OPTIONS}
                    disabled={saving || owned || Boolean(profile.disabledAt)}
                    onValueChange={(value) =>
                      onAccessChange(connection.id, value as IntegrationAccess)
                    }
                    className="w-[140px] shrink-0 [&>button]:h-8 [&>button]:text-[13px]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      saving ||
                      Boolean(profile.disabledAt) ||
                      !canUse ||
                      isDefault
                    }
                    onClick={() => onSetDefault(connection.id)}
                  >
                    Use default
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RoleBadge({ role }: { role: ProfileRole }) {
  if (role === "admin") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
        <ShieldCheck className="size-3" />
        Admin
      </span>
    )
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/55">
      Member
    </span>
  )
}

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: IconType
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card shadow-[0_1px_0_0_rgba(0,0,0,0.02)]">
      <header className="flex items-start gap-2.5 px-5 pt-4 pb-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted/70 text-foreground/70">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          {description && (
            <p className="text-[12.5px] text-foreground/50">{description}</p>
          )}
        </div>
      </header>
      <div className="space-y-4 px-5 pb-5">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-foreground/60">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11.5px] text-foreground/45">{hint}</p>}
    </div>
  )
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  show,
  onToggleShow,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  show: boolean
  onToggleShow: () => void
  autoFocus?: boolean
}) {
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 pr-9"
      />
      <button
        type="button"
        onClick={onToggleShow}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute top-0 right-0 grid h-9 w-9 place-items-center rounded-r-md text-foreground/40 transition-colors outline-none hover:text-foreground/70 focus-visible:text-foreground/70"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

function ToggleRow({
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: IconType
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3.5 py-2.5 transition-colors",
        !disabled && "hover:border-border"
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/70 text-foreground/70">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-foreground">
            {label}
          </div>
          {description && (
            <div className="truncate text-[12px] text-foreground/50">
              {description}
            </div>
          )}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  )
}
