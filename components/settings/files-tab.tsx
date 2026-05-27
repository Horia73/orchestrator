"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  KeyRound,
  Loader2,
  Lock,
  Search,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { EnvEditor } from "@/components/settings/files-env-editor"

type FileKind = "json" | "env" | "markdown"
type FileCategory = "knowledge" | "behavior" | "integrations" | "onboarding" | "system" | "models"
type FileSurface = "editor" | "reference"
type JsonPath = Array<string | number>

interface WorkspaceFileSummary {
  id: string
  label: string
  relativePath: string
  kind: FileKind
  category: FileCategory
  surface: FileSurface
  dynamic?: "daily"
  dailyDate?: string
  description: string
  readOnly?: boolean
  exists: boolean
  size: number | null
  updatedAt: number | null
}

interface WorkspaceFilePayload extends WorkspaceFileSummary {
  content: string
  contentRedacted?: boolean
}

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }

type JsonDiagnostics =
  | { valid: true; parsed: unknown; formatted: string; error: null }
  | { valid: false; parsed: null; formatted: null; error: string }

const AUTO_SAVE_DELAY_MS = 700
const LAST_SELECTED_FILE_STORAGE_KEY = "orchestrator:settings:files:last-selected-id"
const DAILY_MEMORY_OPEN_STORAGE_KEY = "orchestrator:settings:files:daily-memory-open"

const DAILY_MEMORY_ID_PREFIX = "memory-day:"
const DAILY_MEMORY_COLLAPSED_LIMIT = 7
const CATEGORY_ORDER: FileCategory[] = ["onboarding", "knowledge", "behavior", "system"]

const CATEGORY_META: Record<FileCategory, { label: string; badge: string }> = {
  knowledge: { label: "Knowledge & memory", badge: "Memory" },
  behavior: { label: "Behavior", badge: "Behavior" },
  integrations: { label: "Integrations", badge: "Integration" },
  onboarding: { label: "Onboarding", badge: "Onboarding" },
  system: { label: "System", badge: "System" },
  models: { label: "Models", badge: "Models" },
}

interface FileGroup {
  category: FileCategory
  label: string
  files: WorkspaceFileSummary[]
}

export function FilesTab() {
  const [files, setFiles] = React.useState<WorkspaceFileSummary[]>([])
  const [selectedId, setSelectedId] = React.useState("")
  const [selectedFile, setSelectedFile] = React.useState<WorkspaceFilePayload | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = React.useState("")
  const [content, setContent] = React.useState("")
  const [loadingList, setLoadingList] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saveState, setSaveState] = React.useState<SaveState>({ kind: "idle" })
  const [dailyMemoryOpen, setDailyMemoryOpen] = React.useState(true)
  // On narrow viewports the list and editor share one column; this toggles
  // which one is visible (drill-in). Both panes always show from `lg` up.
  const [mobileDetailOpen, setMobileDetailOpen] = React.useState(false)
  const fetchFileRequestRef = React.useRef(0)

  const dirty = selectedFile !== null && content !== selectedFile.content

  const jsonDiagnostics = React.useMemo(
    () => selectedFile?.kind === "json" ? parseJson(content) : null,
    [content, selectedFile?.kind]
  )
  const jsonInvalid = jsonDiagnostics?.valid === false
  const groups = React.useMemo(() => groupEditorFiles(files), [files])
  const flatFiles = React.useMemo(() => groups.flatMap(group => group.files), [groups])

  const fetchList = React.useCallback(async () => {
    setLoadingList(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/files", { cache: "no-store" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `Failed to load files (${res.status})`)
      const nextFiles = (json.files ?? []) as WorkspaceFileSummary[]
      setFiles(nextFiles)
      if (typeof json.workspaceRoot === "string") setWorkspaceRoot(json.workspaceRoot)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files")
    } finally {
      setLoadingList(false)
    }
  }, [])

  const fetchFile = React.useCallback(async (id: string, signal?: AbortSignal) => {
    if (!id) return
    const requestId = ++fetchFileRequestRef.current
    const isStale = () => signal?.aborted || requestId !== fetchFileRequestRef.current
    setLoadingFile(true)
    setError(null)
    setSaveState({ kind: "idle" })
    try {
      const res = await fetch(`/api/settings/files/${encodeURIComponent(id)}`, { cache: "no-store", signal })
      const json = await res.json().catch(() => ({}))
      if (isStale()) return
      if (!res.ok) throw new Error(json.error || `Failed to load file (${res.status})`)
      const file = normalizeLoadedFile(json.file as WorkspaceFilePayload)
      if (isStale()) return
      setSelectedFile(file)
      setContent(file.content)
      setFiles(prev => prev.map(item => item.id === file.id ? toSummary(file) : item))
    } catch (err) {
      if (isStale() || (err instanceof Error && err.name === "AbortError")) return
      setSelectedFile(null)
      setContent("")
      setError(err instanceof Error ? err.message : "Failed to load file")
    } finally {
      if (!isStale()) setLoadingFile(false)
    }
  }, [])

  const saveCurrent = React.useCallback(async () => {
    if (!selectedFile || selectedFile.readOnly || !dirty || jsonInvalid) return false
    const contentToSave = selectedFile.kind === "json" ? normalizeJsonText(content) : content
    setSaveState({ kind: "saving" })
    try {
      const res = await fetch(`/api/settings/files/${encodeURIComponent(selectedFile.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: contentToSave }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      const savedFile = normalizeLoadedFile(json.file as WorkspaceFilePayload)
      setSelectedFile(savedFile)
      setContent(savedFile.content)
      setFiles(prev => prev.map(item => item.id === savedFile.id ? toSummary(savedFile) : item))
      setSaveState({ kind: "saved" })
      return true
    } catch (err) {
      setSaveState({ kind: "error", message: err instanceof Error ? err.message : "Save failed" })
      return false
    }
  }, [content, dirty, jsonInvalid, selectedFile])

  React.useEffect(() => {
    void fetchList()
  }, [fetchList])

  React.useEffect(() => {
    setDailyMemoryOpen(readDailyMemoryOpen())
  }, [])

  React.useEffect(() => {
    if (flatFiles.length === 0) {
      if (selectedId) setSelectedId("")
      return
    }

    if (selectedId && flatFiles.some(file => file.id === selectedId)) return

    const rememberedId = resolveRememberedFileId(readLastSelectedFileId(), flatFiles)
    const nextId = rememberedId
      ? rememberedId
      : flatFiles[0].id

    if (nextId !== selectedId) setSelectedId(nextId)
  }, [flatFiles, selectedId])

  React.useEffect(() => {
    if (!selectedId || !flatFiles.some(file => file.id === selectedId)) return
    rememberLastSelectedFileId(selectedId)
  }, [flatFiles, selectedId])

  React.useEffect(() => {
    if (!selectedId) {
      fetchFileRequestRef.current += 1
      setLoadingFile(false)
      setSelectedFile(null)
      setContent("")
      return
    }
    const controller = new AbortController()
    void fetchFile(selectedId, controller.signal)
    return () => controller.abort()
  }, [fetchFile, selectedId])

  React.useEffect(() => {
    // Secrets use explicit save (like Vercel) — never autosave .env.local.
    if (!selectedFile || selectedFile.readOnly || !dirty || loadingFile || jsonInvalid) return
    if (selectedFile.kind === "env") return
    setSaveState({ kind: "pending" })
    const timer = window.setTimeout(() => {
      void saveCurrent()
    }, AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [dirty, jsonInvalid, loadingFile, saveCurrent, selectedFile])

  React.useEffect(() => {
    if (saveState.kind !== "saved") return
    const timer = window.setTimeout(() => setSaveState({ kind: "idle" }), 1800)
    return () => window.clearTimeout(timer)
  }, [saveState.kind])

  const selectFile = async (id: string) => {
    if (id === selectedId) {
      setMobileDetailOpen(true)
      return
    }
    if (dirty && !jsonInvalid && !selectedFile?.readOnly) {
      const saved = await saveCurrent()
      if (!saved) return
    }
    if (dirty && jsonInvalid && !window.confirm("This JSON is invalid and cannot be auto-saved. Switch files anyway?")) return
    setSelectedId(id)
    setMobileDetailOpen(true)
  }

  const replaceJsonValue = React.useCallback((path: JsonPath, value: unknown) => {
    if (!jsonDiagnostics?.valid || selectedFile?.readOnly) return
    setContent(formatJsonText(setJsonValue(jsonDiagnostics.parsed, path, value)))
    if (saveState.kind !== "idle") setSaveState({ kind: "idle" })
  }, [jsonDiagnostics, saveState.kind, selectedFile?.readOnly])

  if (loadingList) {
    return (
      <div className="grid h-full min-h-0 gap-0 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-4">
        <div className="h-full min-h-[360px] animate-pulse rounded-xl border border-border/60 bg-muted/35" />
        <div className="hidden h-full min-h-[360px] animate-pulse rounded-xl border border-border/60 bg-muted/35 lg:block" />
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 gap-0 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-4">
      <aside
        className={cn(
          "min-h-0 flex-col rounded-xl border border-border/70 bg-card",
          mobileDetailOpen ? "hidden lg:flex" : "flex"
        )}
      >
        <div className="shrink-0 border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-foreground/85">Workspace files</h2>
          <p className="mt-0.5 truncate text-[12px] text-foreground/50">
            {workspaceRoot || "Workspace root"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.map(group => {
            const dailyFiles = group.files.filter(isDailyMemoryFile)
            let dailyFolderRendered = false
            return (
              <div key={group.category} className="mb-1.5 last:mb-0">
                <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-foreground/35 first:pt-1">
                  {group.label}
                </p>
                {group.files.map(file => {
                  if (isDailyMemoryFile(file)) {
                    if (dailyFolderRendered) return null
                    dailyFolderRendered = true
                    return (
                      <DailyMemoryFolder
                        key="daily-memory-folder"
                        files={dailyFiles}
                        open={dailyMemoryOpen}
                        selectedId={selectedId}
                        onToggle={() => {
                          setDailyMemoryOpen(open => {
                            const next = !open
                            rememberDailyMemoryOpen(next)
                            return next
                          })
                        }}
                        onSelect={id => { void selectFile(id) }}
                      />
                    )
                  }

                  return (
                    <FileSidebarButton
                      key={file.id}
                      file={file}
                      active={selectedId === file.id}
                      onSelect={id => { void selectFile(id) }}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </aside>

      <section
        className={cn(
          "min-h-0 min-w-0 flex-col rounded-xl border border-border/70 bg-card",
          mobileDetailOpen ? "flex" : "hidden lg:flex"
        )}
      >
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border/60 px-3 py-3 md:px-4 md:py-3.5">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={() => setMobileDetailOpen(false)}
              aria-label="Back to file list"
              className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-muted/60 hover:text-foreground lg:hidden"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {selectedFile && <FileIcon kind={selectedFile.kind} className="size-4 text-foreground/55" />}
                <h2 className="truncate text-[15px] font-semibold text-foreground">
                  {selectedFile?.label ?? "Select a file"}
                </h2>
                {selectedFile && <FileRoleBadge file={selectedFile} />}
                {selectedFile?.readOnly && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground/55">
                    <Lock className="size-3" />
                    Read-only
                  </span>
                )}
              </div>
              {selectedFile && (
                <>
                  <p className="mt-1 text-[12.5px] leading-5 text-foreground/55">{selectedFile.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] text-foreground/45">
                    <span>{selectedFile.relativePath}</span>
                    {selectedFile.exists ? (
                      <>
                        <span>{formatBytes(selectedFile.size ?? 0)}</span>
                        {selectedFile.updatedAt && <span>Updated {formatDateTime(selectedFile.updatedAt)}</span>}
                      </>
                    ) : (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-sans text-amber-700 dark:text-amber-500">
                        Not created — saving creates it from a template
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <StatusBadge
            state={saveState}
            invalidJson={jsonInvalid}
            readOnly={selectedFile?.readOnly === true}
            dirty={dirty}
            explicitSave={selectedFile?.kind === "env"}
          />
        </div>

        {error && (
          <div className="m-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden p-3 md:p-4">
          {loadingFile ? (
            <div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-[13px] text-foreground/50">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading file
            </div>
          ) : selectedFile?.kind === "json" ? (
            <JsonEditor diagnostics={jsonDiagnostics} readOnly={selectedFile.readOnly === true} onChange={replaceJsonValue} />
          ) : selectedFile?.kind === "env" ? (
            <EnvEditor
              content={content}
              readOnly={selectedFile.readOnly === true}
              fileKey={selectedFile.id}
              dirty={dirty}
              saveState={saveState}
              onSave={() => { void saveCurrent() }}
              onChange={next => {
                setContent(next)
                if (saveState.kind !== "idle") setSaveState({ kind: "idle" })
              }}
            />
          ) : selectedFile ? (
            <textarea
              data-files-main-scroll
              value={content}
              onChange={event => {
                setContent(event.target.value)
                if (saveState.kind !== "idle") setSaveState({ kind: "idle" })
              }}
              readOnly={selectedFile.readOnly}
              spellCheck={selectedFile.kind === "markdown"}
              className={cn(
                "h-full min-h-0 w-full resize-none overflow-auto rounded-lg border border-border/70 bg-background px-3.5 py-3 text-[13px] leading-6 text-foreground outline-none transition-colors",
                selectedFile.kind === "markdown" ? "font-sans" : "font-mono text-[12.5px] leading-5",
                "focus:border-ring focus:ring-3 focus:ring-ring/30",
                selectedFile.readOnly && "bg-muted/20 text-foreground/70"
              )}
            />
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-[13px] text-foreground/45">
              Select a file from the sidebar.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function JsonEditor({
  diagnostics,
  readOnly,
  onChange,
}: {
  diagnostics: JsonDiagnostics | null
  readOnly: boolean
  onChange: (path: JsonPath, value: unknown) => void
}) {
  if (!diagnostics) return null

  if (!diagnostics.valid) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
        Invalid JSON: {diagnostics.error}
      </div>
    )
  }

  return (
    <div data-files-main-scroll className="h-full min-h-0 overflow-auto rounded-lg border border-border/70 bg-background">
      <JsonNode label="root" value={diagnostics.parsed} path={[]} depth={0} readOnly={readOnly} onChange={onChange} />
    </div>
  )
}

function JsonNode({
  label,
  value,
  path,
  depth,
  readOnly,
  onChange,
}: {
  label: string
  value: unknown
  path: JsonPath
  depth: number
  readOnly: boolean
  onChange: (path: JsonPath, value: unknown) => void
}) {
  if (Array.isArray(value)) {
    return (
      <JsonBranch label={label} depth={depth} meta={`${value.length} items`}>
        {value.length === 0 ? (
          <EmptyRow label="Empty array" depth={depth + 1} />
        ) : value.map((item, index) => (
          <JsonNode
            key={index}
            label={String(index)}
            value={item}
            path={[...path, index]}
            depth={depth + 1}
            readOnly={readOnly}
            onChange={onChange}
          />
        ))}
      </JsonBranch>
    )
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    return (
      <JsonBranch label={label} depth={depth} meta={`${entries.length} fields`}>
        {entries.length === 0 ? (
          <EmptyRow label="Empty object" depth={depth + 1} />
        ) : entries.map(([key, item]) => (
          <JsonNode
            key={key}
            label={key}
            value={item}
            path={[...path, key]}
            depth={depth + 1}
            readOnly={readOnly}
            onChange={onChange}
          />
        ))}
      </JsonBranch>
    )
  }

  return (
    <PrimitiveRow
      label={label}
      value={value}
      path={path}
      depth={depth}
      readOnly={readOnly}
      onChange={onChange}
    />
  )
}

function JsonBranch({
  label,
  meta,
  depth,
  children,
}: {
  label: string
  meta: string
  depth: number
  children: React.ReactNode
}) {
  return (
    <div className={cn("border-b border-border/50 last:border-b-0", depth > 0 && "border-l border-l-border/60")}>
      <div
        className={cn("flex items-center justify-between gap-3 bg-muted/25 px-3 py-2.5", depth > 0 && "bg-muted/15")}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground/75">{humanizeKey(label)}</span>
        <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[11px] text-foreground/45">{meta}</span>
      </div>
      <div>{children}</div>
    </div>
  )
}

function PrimitiveRow({
  label,
  value,
  path,
  depth,
  readOnly,
  onChange,
}: {
  label: string
  value: unknown
  path: JsonPath
  depth: number
  readOnly: boolean
  onChange: (path: JsonPath, value: unknown) => void
}) {
  const kind = primitiveKind(label, value)

  return (
    <div
      className="grid gap-2 border-b border-border/40 px-3 py-2.5 last:border-b-0 md:grid-cols-[220px_minmax(0,1fr)_88px]"
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <label className="min-w-0 truncate pt-1 text-[12.5px] font-medium text-foreground/60" title={label}>
        {displayJsonLabel(label)}
      </label>
      <PrimitiveInput label={label} value={value} readOnly={readOnly} onChange={next => onChange(path, next)} />
      <span className="pt-1 text-left text-[11px] text-foreground/35 md:text-right">{kind}</span>
    </div>
  )
}

function PrimitiveInput({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string
  value: unknown
  readOnly: boolean
  onChange: (value: unknown) => void
}) {
  if (typeof value === "boolean") {
    const archivedFlag = label.toLowerCase() === "archived"
    const text = archivedFlag
      ? value ? "Archived" : "Live"
      : value ? "True" : "False"

    return (
      <label className="inline-flex h-8 items-center gap-2 text-[13px] text-foreground/70">
        <input
          type="checkbox"
          checked={value}
          disabled={readOnly}
          onChange={event => onChange(event.target.checked)}
          className="size-4 rounded border-border"
        />
        <span
          className={cn(
            archivedFlag && !value && "text-emerald-700 dark:text-emerald-500",
            archivedFlag && value && "text-amber-700 dark:text-amber-500"
          )}
        >
          {text}
        </span>
      </label>
    )
  }

  if (typeof value === "number" && isDateNumber(label, value)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          value={toDateTimeLocal(value)}
          readOnly={readOnly}
          onChange={event => {
            if (!event.target.value) return
            onChange(fromDateTimeLocal(event.target.value, value))
          }}
          className={fieldClassName(readOnly)}
        />
        <span className="text-[11.5px] text-foreground/40">{formatDateTime(value)}</span>
      </div>
    )
  }

  if (typeof value === "number") {
    return (
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        readOnly={readOnly}
        onChange={event => onChange(event.target.value === "" ? 0 : Number(event.target.value))}
        className={fieldClassName(readOnly)}
      />
    )
  }

  if (typeof value === "string") {
    const multiline = value.length > 100 || value.includes("\n")
    if (multiline) {
      return (
        <textarea
          value={value}
          readOnly={readOnly}
          onChange={event => onChange(event.target.value)}
          className={cn(fieldClassName(readOnly), "min-h-20 resize-y py-2 leading-5")}
        />
      )
    }

    return (
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        onChange={event => onChange(event.target.value)}
        className={fieldClassName(readOnly)}
      />
    )
  }

  return (
    <div className="flex h-8 items-center rounded-lg border border-border/60 bg-muted/20 px-2.5 text-[13px] text-foreground/45">
      null
    </div>
  )
}

function StatusBadge({
  state,
  invalidJson,
  readOnly,
  dirty,
  explicitSave = false,
}: {
  state: SaveState
  invalidJson: boolean
  readOnly: boolean
  dirty: boolean
  explicitSave?: boolean
}) {
  if (readOnly) return <span className="text-[11.5px] text-foreground/45">Read-only</span>
  if (invalidJson) return <span className="text-[11.5px] text-destructive">Invalid JSON</span>
  if (state.kind === "pending") return <span className="text-[11.5px] text-foreground/50">Auto-saving</span>
  if (state.kind === "saving") return <span className="text-[11.5px] text-foreground/50">Saving</span>
  if (state.kind === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-500">
        <CheckCircle2 className="size-3.5" />
        Saved
      </span>
    )
  }
  if (state.kind === "error") {
    return <span className="max-w-[260px] truncate text-[11.5px] text-destructive" title={state.message}>{state.message}</span>
  }
  if (explicitSave) {
    if (!dirty) return null
    return <span className="text-[11.5px] text-amber-700 dark:text-amber-500">Unsaved changes</span>
  }
  if (!dirty) return null
  return <span className="text-[11.5px] text-foreground/45">Unsaved</span>
}

function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  if (kind === "json") return <FileJson className={className} />
  if (kind === "env") return <KeyRound className={className} />
  return <FileText className={className} />
}

function FileSidebarButton({
  file,
  active,
  nested = false,
  onSelect,
}: {
  file: WorkspaceFileSummary
  active: boolean
  nested?: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(file.id)}
      aria-current={active ? "true" : undefined}
      title={file.relativePath}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg text-left transition-colors",
        nested ? "px-2 py-1.5" : "px-2.5 py-2",
        active
          ? "bg-muted text-foreground"
          : "text-foreground/70 hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <FileIcon
        kind={file.kind}
        className={cn(
          "size-4 shrink-0",
          nested && "size-3.5",
          active ? "text-foreground/70" : "text-foreground/45"
        )}
      />
      <span className={cn("min-w-0 flex-1 truncate font-medium", nested ? "text-[12.5px]" : "text-[13px]")}>
        {file.label}
      </span>
      {file.readOnly && <Lock className="size-3 shrink-0 text-foreground/35" />}
      {!file.exists && (
        <span
          title="Not created yet"
          aria-label="Not created yet"
          className="size-1.5 shrink-0 rounded-full bg-amber-500/70"
        />
      )}
    </button>
  )
}

function DailyMemoryFolder({
  files,
  open,
  selectedId,
  onToggle,
  onSelect,
}: {
  files: WorkspaceFileSummary[]
  open: boolean
  selectedId: string
  onToggle: () => void
  onSelect: (id: string) => void
}) {
  const active = files.some(file => file.id === selectedId)
  const [query, setQuery] = React.useState("")
  const [expanded, setExpanded] = React.useState(false)
  const showSearch = files.length > DAILY_MEMORY_COLLAPSED_LIMIT

  const haystackMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const file of files) map.set(file.id, buildDailyFileHaystack(file))
    return map
  }, [files])

  const trimmedQuery = query.trim().toLowerCase()
  const filteredFiles = React.useMemo(() => {
    if (!trimmedQuery) return files
    return files.filter(file => (haystackMap.get(file.id) ?? "").includes(trimmedQuery))
  }, [files, haystackMap, trimmedQuery])

  const collapseList = !expanded && !trimmedQuery && filteredFiles.length > DAILY_MEMORY_COLLAPSED_LIMIT
  const visibleFiles = collapseList ? filteredFiles.slice(0, DAILY_MEMORY_COLLAPSED_LIMIT) : filteredFiles
  const hiddenCount = filteredFiles.length - visibleFiles.length
  const canCollapse = expanded && !trimmedQuery && filteredFiles.length > DAILY_MEMORY_COLLAPSED_LIMIT

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
          active
            ? "bg-muted/80 text-foreground"
            : "text-foreground/70 hover:bg-muted/60 hover:text-foreground"
        )}
      >
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-foreground/45 transition-transform", !open && "-rotate-90")}
        />
        {open ? (
          <FolderOpen className={cn("size-4 shrink-0", active ? "text-foreground/70" : "text-foreground/45")} />
        ) : (
          <Folder className={cn("size-4 shrink-0", active ? "text-foreground/70" : "text-foreground/45")} />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">Daily memory</span>
        <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[11px] text-foreground/45">
          {files.length}
        </span>
      </button>

      {open && (
        <div className="ml-4 mt-1 border-l border-border/60 pl-2">
          {showSearch && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground/40" />
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Caută dată (ex. 21 mai)"
                aria-label="Caută în daily memory"
                className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-[12px] outline-none placeholder:text-foreground/35 focus:border-ring focus:ring-3 focus:ring-ring/30"
              />
            </div>
          )}

          {visibleFiles.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-foreground/45">Nicio potrivire</p>
          ) : (
            <div className="space-y-0.5">
              {visibleFiles.map(file => (
                <FileSidebarButton
                  key={file.id}
                  file={file}
                  active={file.id === selectedId}
                  nested
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-[12px] text-foreground/55 transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Show {hiddenCount} more
            </button>
          )}
          {canCollapse && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-[12px] text-foreground/55 transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function buildDailyFileHaystack(file: WorkspaceFileSummary): string {
  const stamp = file.dailyDate ?? file.label
  const parts = new Set<string>([stamp.toLowerCase(), file.label.toLowerCase()])
  const date = new Date(`${stamp}T00:00:00.000Z`)
  if (!Number.isNaN(date.getTime())) {
    const day = date.getUTCDate()
    const month = date.getUTCMonth() + 1
    const year = date.getUTCFullYear()
    parts.add(String(year))
    parts.add(String(month))
    parts.add(String(month).padStart(2, "0"))
    parts.add(String(day))
    parts.add(String(day).padStart(2, "0"))

    const locales: Array<string | undefined> = [undefined, "ro-RO", "en-US"]
    const formats: Intl.DateTimeFormatOptions[] = [
      { year: "numeric", month: "long", day: "numeric" },
      { year: "numeric", month: "short", day: "numeric" },
      { month: "long", day: "numeric" },
      { month: "short", day: "numeric" },
      { month: "long" },
      { month: "short" },
    ]
    for (const locale of locales) {
      for (const opt of formats) {
        try {
          parts.add(new Intl.DateTimeFormat(locale, opt).format(date).toLowerCase())
        } catch {
          // Skip unsupported locale/option combinations.
        }
      }
    }
  }
  return Array.from(parts).join(" ")
}

function FileRoleBadge({ file }: { file: WorkspaceFileSummary }) {
  const label = file.kind === "env" ? "Secrets" : CATEGORY_META[file.category]?.badge ?? "File"

  return (
    <span className="inline-flex shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground/50">
      {label}
    </span>
  )
}

function EmptyRow({ label, depth }: { label: string; depth: number }) {
  return (
    <div className="px-3 py-3 text-[12px] text-foreground/40" style={{ paddingLeft: `${12 + depth * 16}px` }}>
      {label}
    </div>
  )
}

function groupEditorFiles(files: WorkspaceFileSummary[]): FileGroup[] {
  const byCategory = new Map<FileCategory, WorkspaceFileSummary[]>()
  for (const file of files) {
    if (file.surface !== "editor") continue
    if (file.category === "integrations") continue
    const bucket = byCategory.get(file.category)
    if (bucket) bucket.push(file)
    else byCategory.set(file.category, [file])
  }

  const ordered: FileGroup[] = []
  const seen = new Set<FileCategory>()
  for (const category of CATEGORY_ORDER) {
    const groupFiles = byCategory.get(category)
    if (!groupFiles || groupFiles.length === 0) continue
    ordered.push({ category, label: CATEGORY_META[category].label, files: groupFiles })
    seen.add(category)
  }
  // Defensive: surface any categories not in the explicit order so a new
  // category never silently disappears from the editor.
  for (const [category, groupFiles] of byCategory) {
    if (seen.has(category) || groupFiles.length === 0) continue
    ordered.push({ category, label: CATEGORY_META[category]?.label ?? category, files: groupFiles })
  }
  return ordered
}

function isDailyMemoryFile(file: WorkspaceFileSummary): boolean {
  return file.dynamic === "daily" || isDailyMemoryFileId(file.id)
}

function isDailyMemoryFileId(id: string): boolean {
  return id.startsWith(DAILY_MEMORY_ID_PREFIX)
}

function resolveRememberedFileId(id: string | null, files: WorkspaceFileSummary[]): string | null {
  if (!id) return null
  if (files.some(file => file.id === id)) return id
  if (id === "memory-day") return files.find(isDailyMemoryFile)?.id ?? null
  return null
}

function normalizeLoadedFile(file: WorkspaceFilePayload): WorkspaceFilePayload {
  if (file.kind !== "json") return file
  const diagnostics = parseJson(file.content)
  if (!diagnostics.valid) return file
  return { ...file, content: diagnostics.formatted + "\n" }
}

function parseJson(value: string): JsonDiagnostics {
  try {
    const parsed = JSON.parse(value)
    return { valid: true, parsed, formatted: JSON.stringify(parsed, null, 2), error: null }
  } catch (err) {
    return { valid: false, parsed: null, formatted: null, error: err instanceof Error ? err.message : "Invalid JSON" }
  }
}

function normalizeJsonText(value: string): string {
  return formatJsonText(JSON.parse(value))
}

function formatJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}

function setJsonValue(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...tail] = path
  if (Array.isArray(root)) {
    const next = [...root]
    const index = typeof head === "number" ? head : Number(head)
    next[index] = setJsonValue(next[index], tail, value)
    return next
  }
  if (isRecord(root)) {
    return {
      ...root,
      [head]: setJsonValue(root[String(head)], tail, value),
    }
  }
  return root
}

function toSummary(file: WorkspaceFilePayload): WorkspaceFileSummary {
  return {
    id: file.id,
    label: file.label,
    relativePath: file.relativePath,
    kind: file.kind,
    category: file.category,
    surface: file.surface,
    description: file.description,
    readOnly: file.readOnly,
    exists: file.exists,
    size: file.size,
    updatedAt: file.updatedAt,
  }
}

function readLastSelectedFileId(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(LAST_SELECTED_FILE_STORAGE_KEY)
  } catch {
    return null
  }
}

function rememberLastSelectedFileId(id: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_SELECTED_FILE_STORAGE_KEY, id)
  } catch {
    // localStorage may be unavailable in hardened browser modes.
  }
}

function readDailyMemoryOpen(): boolean {
  if (typeof window === "undefined") return true
  try {
    const value = window.localStorage.getItem(DAILY_MEMORY_OPEN_STORAGE_KEY)
    return value === null ? true : value === "true"
  } catch {
    return true
  }
}

function rememberDailyMemoryOpen(open: boolean) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(DAILY_MEMORY_OPEN_STORAGE_KEY, open ? "true" : "false")
  } catch {
    // localStorage may be unavailable in hardened browser modes.
  }
}

function fieldClassName(readOnly: boolean): string {
  return cn(
    "min-h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] outline-none transition-colors",
    "focus:border-ring focus:ring-3 focus:ring-ring/30",
    readOnly && "cursor-default bg-muted/20 text-foreground/60"
  )
}

function primitiveKind(label: string, value: unknown): string {
  if (typeof value === "boolean" && label.toLowerCase() === "archived") return "status"
  if (typeof value === "number" && isDateNumber(label, value)) return "date"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function isDateNumber(label: string, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false
  const key = label.toLowerCase()
  const dateLikeKey =
    key === "timestamp" ||
    key === "date" ||
    key.endsWith("date") ||
    key.endsWith("at") ||
    key.includes("updated") ||
    key.includes("created") ||
    key.includes("started") ||
    key.includes("ended") ||
    key.includes("scheduled") ||
    key.includes("researched")
  if (!dateLikeKey) return false

  const ms = value > 1_000_000_000_000 ? value : value * 1000
  const year = new Date(ms).getFullYear()
  return year >= 2000 && year <= 2100
}

function toDateTimeLocal(value: number): string {
  const ms = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(ms)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function fromDateTimeLocal(value: string, original: number): number {
  const ms = new Date(value).getTime()
  if (!Number.isFinite(ms)) return original
  return original > 1_000_000_000_000 ? ms : Math.floor(ms / 1000)
}

function formatDateTime(value: number): string {
  const ms = value > 1_000_000_000_000 ? value : value * 1000
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function humanizeKey(key: string): string {
  if (/^\d+$/.test(key)) return `Item ${Number(key) + 1}`
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, char => char.toUpperCase())
}

function displayJsonLabel(key: string): string {
  if (key.toLowerCase() === "archived") return "Availability"
  return humanizeKey(key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
