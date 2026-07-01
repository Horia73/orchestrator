"use client"

import * as React from "react"
import {
  BookOpen,
  CheckCircle2,
  Edit3,
  Eye,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { ConfigInput, InlineNotice } from "@/components/settings/auth-shared"
import type { NoticeTone } from "@/components/settings/auth-types"

type SkillScope = "profile" | "global" | "bundled"
type WritableSkillScope = Exclude<SkillScope, "bundled">
type CreateMode = "starter" | "paste" | "url"

interface SkillEntry {
  id: string
  name: string
  description: string
  license: string | null
  scope: SkillScope
  source: string
  active: boolean
  shadowedBy: { scope: SkillScope; source: string } | null
  writable: boolean
}

interface SkillsResponse {
  skills: SkillEntry[]
  writableScopes: WritableSkillScope[]
  canManageProfileSkills: boolean
  canManageGlobalSkills: boolean
}

interface SkillFileResponse {
  skill: Pick<SkillEntry, "id" | "name" | "description" | "scope" | "source">
  file: {
    content: string
    truncated: boolean
    size: number
  }
}

const SCOPE_LABELS: Record<SkillScope, string> = {
  profile: "Profile",
  global: "Global",
  bundled: "Bundled",
}

export function CustomSkillsCard() {
  const [data, setData] = React.useState<SkillsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<"create" | "load" | "save" | "delete" | null>(null)
  const [notice, setNotice] = React.useState<{
    tone: NoticeTone
    text: string
  } | null>(null)
  const [showCreate, setShowCreate] = React.useState(false)
  const [createMode, setCreateMode] = React.useState<CreateMode>("starter")
  const [newName, setNewName] = React.useState("")
  const [newId, setNewId] = React.useState("")
  const [newDescription, setNewDescription] = React.useState("")
  const [newContent, setNewContent] = React.useState("")
  const [sourceUrl, setSourceUrl] = React.useState("")
  const [newScope, setNewScope] = React.useState<WritableSkillScope>("profile")
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const [editorContent, setEditorContent] = React.useState("")
  const [editorDirty, setEditorDirty] = React.useState(false)
  const [editorMode, setEditorMode] = React.useState<"preview" | "edit">(
    "preview"
  )

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/settings/skills", { cache: "no-store" })
      const json = (await res.json().catch(() => ({}))) as
        | SkillsResponse
        | { error?: string }
      if (!res.ok || !("skills" in json)) {
        throw new Error(responseError(json, `Skills load failed (${res.status})`))
      }
      setData(json)
      if (json.writableScopes.length > 0 && !json.writableScopes.includes(newScope)) {
        setNewScope(json.writableScopes[0])
      }
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not load skills.",
      })
    } finally {
      setLoading(false)
    }
  }, [newScope])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedSkill = React.useMemo(
    () => data?.skills.find((skill) => skillKey(skill) === selectedKey) ?? null,
    [data?.skills, selectedKey]
  )

  const selectSkill = React.useCallback(
    async (skill: SkillEntry) => {
      if (editorDirty) {
        const discard = window.confirm("Discard unsaved skill edits?")
        if (!discard) return
      }
      setSelectedKey(skillKey(skill))
      setEditorContent("")
      setEditorDirty(false)
      setEditorMode("preview")
      setNotice(null)

      setBusy("load")
      try {
        const res = await fetch(skillUrl(skill.scope, skill.id), {
          cache: "no-store",
        })
        const json = (await res.json().catch(() => ({}))) as
          | SkillFileResponse
          | { error?: string }
        if (!res.ok || !("file" in json)) {
          throw new Error(responseError(json, `Skill read failed (${res.status})`))
        }
        setEditorContent(json.file.content)
      } catch (err) {
        setNotice({
          tone: "error",
          text: err instanceof Error ? err.message : "Could not read skill.",
        })
      } finally {
        setBusy(null)
      }
    },
    [editorDirty]
  )

  const createSkill = async () => {
    if (
      createMode === "starter" &&
      (!newName.trim() || !newDescription.trim())
    ) {
      setNotice({
        tone: "warning",
        text: "Add a name and description before creating the skill.",
      })
      return
    }
    if (createMode === "paste" && !newContent.trim()) {
      setNotice({
        tone: "warning",
        text: "Paste SKILL.md content or choose a Markdown file.",
      })
      return
    }
    if (createMode === "url" && !sourceUrl.trim()) {
      setNotice({
        tone: "warning",
        text: "Add an HTTPS URL to a SKILL.md file.",
      })
      return
    }
    setBusy("create")
    setNotice(null)
    try {
      const res = await fetch("/api/settings/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: newScope,
          id: newId.trim() || undefined,
          name: createMode === "starter" ? newName : undefined,
          description:
            createMode === "starter" ? newDescription : undefined,
          content: createMode === "paste" ? newContent : undefined,
          sourceUrl: createMode === "url" ? sourceUrl : undefined,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        skill?: SkillEntry
        error?: string
      }
      if (!res.ok || !json.skill) {
        throw new Error(json.error || `Create failed (${res.status})`)
      }
      setNewName("")
      setNewId("")
      setNewDescription("")
      setNewContent("")
      setSourceUrl("")
      setShowCreate(false)
      setNotice({ tone: "success", text: `${json.skill.name} created.` })
      await refresh()
      await selectSkill({ ...json.skill, active: true, shadowedBy: null, writable: true })
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not create skill.",
      })
    } finally {
      setBusy(null)
    }
  }

  const saveSkill = async () => {
    if (!selectedSkill?.writable) return
    setBusy("save")
    setNotice(null)
    try {
      const res = await fetch(skillUrl(selectedSkill.scope, selectedSkill.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editorContent }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      setEditorDirty(false)
      setNotice({ tone: "success", text: "Skill saved." })
      await refresh()
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not save skill.",
      })
    } finally {
      setBusy(null)
    }
  }

  const deleteSkill = async () => {
    if (!selectedSkill?.writable) return
    const confirmed = window.confirm(
      `Delete the ${SCOPE_LABELS[selectedSkill.scope].toLowerCase()} skill "${selectedSkill.name}"?`
    )
    if (!confirmed) return
    setBusy("delete")
    setNotice(null)
    try {
      const res = await fetch(skillUrl(selectedSkill.scope, selectedSkill.id), {
        method: "DELETE",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || `Delete failed (${res.status})`)
      setSelectedKey(null)
      setEditorContent("")
      setEditorDirty(false)
      setEditorMode("preview")
      setNotice({ tone: "success", text: "Skill deleted." })
      await refresh()
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not delete skill.",
      })
    } finally {
      setBusy(null)
    }
  }

  const writableScopes = data?.writableScopes ?? []
  const canCreate = writableScopes.length > 0
  const activeCount = data?.skills.filter((skill) => skill.active).length ?? 0

  const loadMarkdownFile = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    setNewContent(text)
    setCreateMode("paste")
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <BookOpen className="size-4 shrink-0 text-foreground/55" />
            <span className="truncate">Custom Skills</span>
          </CardTitle>
          <CardDescription>
            Local workflow bundles exposed through Orchestrator&apos;s skill
            tools. Bundled skills are read-only; custom skills live in profile
            or global state.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3.5" />
            )}
            Recheck
          </Button>
          {canCreate && (
            <Button
              size="sm"
              onClick={() => setShowCreate((open) => !open)}
              disabled={busy === "create"}
            >
              <Plus className="size-3.5" />
              Add skill
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {notice && <InlineNotice tone={notice.tone} text={notice.text} />}

        {showCreate && canCreate && (
          <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex h-8 overflow-hidden rounded-lg border border-border bg-background">
                {(["starter", "paste", "url"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setCreateMode(mode)}
                    className={cn(
                      "border-l border-border px-2.5 text-[12px] font-medium capitalize first:border-l-0",
                      createMode === mode
                        ? "bg-muted text-foreground"
                        : "text-foreground/55 hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {mode === "starter"
                      ? "Starter"
                      : mode === "paste"
                        ? "Paste MD"
                        : "From URL"}
                  </button>
                ))}
              </div>
              <label className="grid w-full gap-1 sm:w-[180px]">
                <span className="text-[11.5px] font-medium text-foreground/60">
                  Scope
                </span>
                <Select
                  value={newScope}
                  onValueChange={(value) =>
                    setNewScope(value as WritableSkillScope)
                  }
                  options={writableScopes.map((scope) => ({
                    value: scope,
                    label: SCOPE_LABELS[scope],
                  }))}
                />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
              <div className="grid gap-3">
                {createMode === "starter" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ConfigInput
                      label="Name"
                      value={newName}
                      onChange={setNewName}
                      placeholder="Customer report writer"
                    />
                    <ConfigInput
                      label="Skill id (optional)"
                      value={newId}
                      onChange={setNewId}
                      placeholder="customer-report-writer"
                    />
                    <div className="sm:col-span-2">
                      <ConfigInput
                        label="Description"
                        value={newDescription}
                        onChange={setNewDescription}
                        placeholder="the user asks for recurring customer reporting workflows"
                      />
                    </div>
                  </div>
                ) : createMode === "paste" ? (
                  <div className="grid gap-3">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px]">
                      <ConfigInput
                        label="Install id (optional)"
                        value={newId}
                        onChange={setNewId}
                        placeholder="uses frontmatter if blank"
                      />
                      <label className="grid gap-1">
                        <span className="text-[11.5px] font-medium text-foreground/60">
                          Markdown file
                        </span>
                        <input
                          type="file"
                          accept=".md,text/markdown,text/plain"
                          onChange={(event) =>
                            void loadMarkdownFile(event.target.files?.[0] ?? null)
                          }
                          className="block h-8 w-full rounded-lg border border-border bg-background px-2 py-1 text-[12px] text-foreground file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-0.5 file:text-[11px] file:font-medium"
                        />
                      </label>
                    </div>
                    <textarea
                      value={newContent}
                      onChange={(event) => setNewContent(event.target.value)}
                      placeholder="Paste a SKILL.md file here..."
                      spellCheck={false}
                      className="min-h-[180px] resize-y rounded-lg border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:border-ring"
                    />
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <ConfigInput
                      label="SKILL.md URL"
                      value={sourceUrl}
                      onChange={setSourceUrl}
                      placeholder="https://github.com/owner/repo/blob/main/path/SKILL.md"
                    />
                    <ConfigInput
                      label="Install id (optional)"
                      value={newId}
                      onChange={setNewId}
                      placeholder="uses frontmatter if blank"
                    />
                  </div>
                )}
              </div>
              <div className="flex flex-col justify-end gap-2">
                {createMode !== "starter" && (
                  <p className="text-[11.5px] leading-relaxed text-foreground/45">
                    A valid skill needs a SKILL.md. If it has frontmatter with
                    id/name, the installer uses that unless you set an id here.
                  </p>
                )}
                <Button onClick={createSkill} disabled={busy === "create"}>
                  {busy === "create" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  {createMode === "url" ? "Install" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!canCreate && !loading && (
          <InlineNotice
            tone="warning"
            text="This profile can use visible skills, but it cannot manage custom skills here."
          />
        )}

        {loading && !data ? (
          <div className="h-[180px] animate-pulse rounded-xl border border-border/60 bg-muted/40" />
        ) : data ? (
          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="min-h-0 rounded-xl border border-border/70 bg-background">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium text-foreground/80">
                    Installed skills
                  </p>
                  <p className="text-[11.5px] text-foreground/45">
                    {activeCount} active · {data.skills.length} total entries
                  </p>
                </div>
              </div>
              <div className="max-h-[420px] overflow-y-auto p-1.5 [scrollbar-gutter:stable]">
                {data.skills.length === 0 ? (
                  <p className="px-2 py-6 text-center text-[13px] text-foreground/45">
                    No skills installed.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {data.skills.map((skill) => (
                      <SkillRow
                        key={`${skill.scope}:${skill.id}`}
                        skill={skill}
                        active={skillKey(skill) === selectedKey}
                        onSelect={() => void selectSkill(skill)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="min-h-[320px] rounded-xl border border-border/70 bg-background">
              {selectedSkill ? (
                <div className="flex h-full min-h-[320px] flex-col">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-[13.5px] font-semibold text-foreground/85">
                          {selectedSkill.name}
                        </p>
                        <ScopeBadge scope={selectedSkill.scope} />
                        {!selectedSkill.active && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                            Shadowed
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[12px] text-foreground/50">
                        {selectedSkill.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {editorContent && selectedSkill.writable && (
                        <div className="inline-flex h-7 overflow-hidden rounded-lg border border-border bg-background">
                          <button
                            type="button"
                            onClick={() => setEditorMode("preview")}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 text-[12px] font-medium transition-colors",
                              editorMode === "preview"
                                ? "bg-muted text-foreground"
                                : "text-foreground/55 hover:bg-muted/60 hover:text-foreground"
                            )}
                          >
                            <Eye className="size-3.5" />
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditorMode("edit")}
                            className={cn(
                              "inline-flex items-center gap-1 border-l border-border px-2 text-[12px] font-medium transition-colors",
                              editorMode === "edit"
                                ? "bg-muted text-foreground"
                                : "text-foreground/55 hover:bg-muted/60 hover:text-foreground"
                            )}
                          >
                            <Edit3 className="size-3.5" />
                            Edit
                          </button>
                        </div>
                      )}
                      {selectedSkill.writable && (
                        <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={saveSkill}
                          disabled={!editorDirty || busy === "save"}
                        >
                          {busy === "save" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Save className="size-3.5" />
                          )}
                          Save
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={deleteSkill}
                          disabled={busy === "delete"}
                        >
                          {busy === "delete" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Delete
                        </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {busy === "load" ? (
                    <div className="flex min-h-[320px] flex-1 items-center justify-center gap-2 px-5 py-10 text-[13px] text-foreground/45">
                      <Loader2 className="size-4 animate-spin" />
                      Loading SKILL.md
                    </div>
                  ) : selectedSkill.writable && editorMode === "edit" ? (
                    <textarea
                      value={editorContent}
                      onChange={(event) => {
                        setEditorContent(event.target.value)
                        setEditorDirty(true)
                      }}
                      spellCheck={false}
                      className="min-h-[320px] flex-1 resize-y rounded-b-xl bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  ) : editorContent ? (
                    <SkillMarkdownPreview content={editorContent} />
                  ) : (
                    <div className="flex min-h-[260px] items-center justify-center px-5 py-10 text-center text-[13px] text-foreground/50">
                      SKILL.md preview is not available for this entry.
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex min-h-[320px] items-center justify-center px-5 py-10 text-center text-[13px] text-foreground/45">
                  Select a writable skill to edit its SKILL.md.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function SkillRow({
  skill,
  active,
  onSelect,
}: {
  skill: SkillEntry
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group flex min-w-0 items-start gap-2 rounded-lg border px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "border-foreground/12 bg-foreground/[0.04]"
          : "border-transparent hover:border-border/70 hover:bg-muted/45"
      )}
    >
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/55">
        {skill.writable ? <Edit3 className="size-3.5" /> : <BookOpen className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/85">
            {skill.name}
          </span>
          <ScopeBadge scope={skill.scope} />
        </span>
        <span className="mt-0.5 line-clamp-2 text-[11.5px] text-foreground/45">
          {skill.description}
        </span>
        {!skill.active && skill.shadowedBy && (
          <span className="mt-1 block truncate text-[11px] text-amber-700 dark:text-amber-400">
            Shadowed by {SCOPE_LABELS[skill.shadowedBy.scope].toLowerCase()}
          </span>
        )}
      </span>
    </button>
  )
}

function ScopeBadge({ scope }: { scope: SkillScope }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-medium",
        scope === "profile"
          ? "bg-sky-500/10 text-sky-700 dark:text-sky-400"
          : scope === "global"
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-muted text-foreground/55"
      )}
    >
      {SCOPE_LABELS[scope]}
    </span>
  )
}

function SkillMarkdownPreview({ content }: { content: string }) {
  const preview = markdownPreviewContent(content)
  return (
    <div className="min-h-[320px] flex-1 overflow-y-auto rounded-b-xl bg-background px-4 py-3 [scrollbar-gutter:stable]">
      {preview.trim() ? (
        <div className="text-[13px] leading-relaxed text-foreground/85">
          <MarkdownRenderer content={preview} compact />
        </div>
      ) : (
        <div className="flex min-h-[260px] items-center justify-center text-center text-[13px] text-foreground/45">
          No Markdown body to preview.
        </div>
      )}
    </div>
  )
}

function markdownPreviewContent(content: string): string {
  if (!content.startsWith("---")) return content
  const end = content.indexOf("\n---", 3)
  if (end === -1) return content
  return content.slice(end + 4).replace(/^\s+/, "")
}

function skillKey(skill: Pick<SkillEntry, "scope" | "id">): string {
  return `${skill.scope}:${skill.id}`
}

function skillUrl(scope: SkillScope, id: string): string {
  return `/api/settings/skills/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`
}

function responseError(value: unknown, fallback: string): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error
  }
  return fallback
}
