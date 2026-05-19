"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Trash2,
} from "lucide-react"

import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { useSettings } from "@/components/settings/use-settings"

type FileKind = "json" | "env" | "markdown"
type FileCategory = "knowledge" | "behavior" | "integrations" | "onboarding" | "system" | "models"
type FileSurface = "editor" | "reference"
type JsonPath = Array<string | number>
type EnvQuote = "none" | "single" | "double"

type EnvLine =
  | { kind: "entry"; id: string; key: string; value: string; label?: string; quote: EnvQuote; exportPrefix: boolean }
  | { kind: "raw"; id: string; value: string }

interface WorkspaceFileSummary {
  id: string
  label: string
  relativePath: string
  kind: FileKind
  category: FileCategory
  surface: FileSurface
  description: string
  readOnly?: boolean
  exists: boolean
  size: number | null
  updatedAt: number | null
}

interface WorkspaceFilePayload extends WorkspaceFileSummary {
  content: string
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
const ENV_RESTORE_FOCUS_SUPPRESSION_MS = 2500
const LAST_SELECTED_FILE_STORAGE_KEY = "orchestrator:settings:files:last-selected-id"
const ENV_LABEL_PREFIX = "# @label "

const ENV_PRESETS = [
  {
    key: "GEMINI_API_KEY",
    label: "Gemini",
    description: "Google Gemini models and browser-agent defaults",
    placeholder: "AIza...",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI",
    description: "OpenAI models, Responses, and image generation",
    placeholder: "sk-...",
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    description: "Claude models and Anthropic calls",
    placeholder: "sk-ant-...",
  },
] as const

const CATEGORY_ORDER: FileCategory[] = ["onboarding", "knowledge", "behavior", "integrations", "system"]

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
  // On narrow viewports the list and editor share one column; this toggles
  // which one is visible (drill-in). Both panes always show from `lg` up.
  const [mobileDetailOpen, setMobileDetailOpen] = React.useState(false)
  const fetchFileRequestRef = React.useRef(0)

  const dirty = selectedFile !== null && content !== selectedFile.content

  // Env var titles come from the provider registry (single source of truth),
  // not a hardcoded preset list — so every provider key (Google/Anthropic/
  // OpenAI/…) gets its real name and unknown keys get one neutral label.
  const { data: settings } = useSettings()
  const envLabels = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const provider of Object.values(settings?.providers ?? {})) {
      if (provider.apiKeyEnv && provider.name) map[provider.apiKeyEnv] = provider.name
    }
    return map
  }, [settings?.providers])

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
      const savedFile = normalizeLoadedFile({ ...(json.file as WorkspaceFilePayload), content: contentToSave })
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
    if (flatFiles.length === 0) {
      if (selectedId) setSelectedId("")
      return
    }

    if (selectedId && flatFiles.some(file => file.id === selectedId)) return

    const rememberedId = readLastSelectedFileId()
    const nextId = rememberedId && flatFiles.some(file => file.id === rememberedId)
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
          {groups.map(group => (
            <div key={group.category} className="mb-1.5 last:mb-0">
              <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-foreground/35 first:pt-1">
                {group.label}
              </p>
              {group.files.map(file => {
                const active = selectedId === file.id
                return (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => void selectFile(file.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "text-foreground/70 hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    <FileIcon
                      kind={file.kind}
                      className={cn("size-4 shrink-0", active ? "text-foreground/70" : "text-foreground/45")}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{file.label}</span>
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
              })}
            </div>
          ))}
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
              envLabels={envLabels}
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

function EnvEditor({
  content,
  readOnly,
  envLabels,
  fileKey,
  dirty,
  saveState,
  onSave,
  onChange,
}: {
  content: string
  readOnly: boolean
  envLabels: Record<string, string>
  fileKey: string
  dirty: boolean
  saveState: SaveState
  onSave: () => void
  onChange: (content: string) => void
}) {
  // EnvEditor owns the editable row model (with stable ids) instead of
  // re-deriving it from `content` every keystroke. That's what lets a freshly
  // added, still-unnamed row exist at all: a var with no name has no
  // representation in .env text, so a content-driven model would make it
  // vanish on the next round-trip. `content` is just the serialized
  // projection we emit upward for saving.
  const toStableRows = React.useCallback(
    (text: string): EnvLine[] => parseEnvContent(text).map((line, index) => ({ ...line, id: `env-row-${fileKey}-${index}` })),
    [fileKey]
  )

  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const allowInputFocusRef = React.useRef(false)
  const allowInputFocusTimerRef = React.useRef<number | null>(null)
  const suppressInputFocusRef = React.useRef(true)
  const suppressInputFocusTimerRef = React.useRef<number | null>(null)
  const [rows, setRows] = React.useState<EnvLine[]>(() => toStableRows(content))
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({})
  const [focusId, setFocusId] = React.useState<string | null>(null)

  const allowNextInputFocus = React.useCallback(() => {
    allowInputFocusRef.current = true
    if (allowInputFocusTimerRef.current !== null) window.clearTimeout(allowInputFocusTimerRef.current)
    allowInputFocusTimerRef.current = window.setTimeout(() => {
      allowInputFocusRef.current = false
      allowInputFocusTimerRef.current = null
    }, 600)
  }, [])

  const suppressRestoredInputFocus = React.useCallback(() => {
    suppressInputFocusRef.current = true
    if (suppressInputFocusTimerRef.current !== null) window.clearTimeout(suppressInputFocusTimerRef.current)
    suppressInputFocusTimerRef.current = window.setTimeout(() => {
      suppressInputFocusRef.current = false
      suppressInputFocusTimerRef.current = null
    }, ENV_RESTORE_FOCUS_SUPPRESSION_MS)
  }, [])

  const shouldBlurEnvInput = React.useCallback((element: Element | null) => {
    const root = rootRef.current
    return Boolean(
      root &&
      element instanceof HTMLInputElement &&
      root.contains(element) &&
      !allowInputFocusRef.current &&
      suppressInputFocusRef.current
    )
  }, [])

  const blurRestoredInputFocus = React.useCallback(() => {
    const active = document.activeElement
    if (!shouldBlurEnvInput(active)) return
    if (active instanceof HTMLElement) active.blur()
  }, [shouldBlurEnvInput])

  const handleFocusCapture = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target
    if (!shouldBlurEnvInput(target instanceof Element ? target : null)) return
    window.requestAnimationFrame(() => {
      if (document.activeElement === target && target instanceof HTMLElement) target.blur()
    })
  }, [shouldBlurEnvInput])

  React.useEffect(() => {
    suppressRestoredInputFocus()
    let timeoutId: number | undefined
    const frameId = window.requestAnimationFrame(() => {
      blurRestoredInputFocus()
      timeoutId = window.setTimeout(blurRestoredInputFocus, 0)
    })
    return () => {
      window.cancelAnimationFrame(frameId)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [blurRestoredInputFocus, fileKey, suppressRestoredInputFocus])

  React.useEffect(() => {
    return () => {
      if (allowInputFocusTimerRef.current !== null) window.clearTimeout(allowInputFocusTimerRef.current)
      if (suppressInputFocusTimerRef.current !== null) window.clearTimeout(suppressInputFocusTimerRef.current)
    }
  }, [])

  // Reseed only when the file actually changes or `content` arrives from
  // outside (initial load / external save) — never on our own echoed onChange,
  // which would wipe in-progress unnamed rows and reset ids.
  const lastSerialized = React.useRef(content)
  const prevFileKey = React.useRef(fileKey)
  React.useEffect(() => {
    const fileChanged = prevFileKey.current !== fileKey
    prevFileKey.current = fileKey
    if (fileChanged || content !== lastSerialized.current) {
      setRows(toStableRows(content))
      lastSerialized.current = content
      setRevealed({})
      setFocusId(null)
      suppressRestoredInputFocus()
      window.requestAnimationFrame(blurRestoredInputFocus)
    }
  }, [blurRestoredInputFocus, content, fileKey, suppressRestoredInputFocus, toStableRows])

  const commit = React.useCallback((nextRows: EnvLine[]) => {
    setRows(nextRows)
    // A brand-new untouched row (no name AND no value) isn't a real change —
    // keep it on screen but don't write it to the file or dirty the editor.
    const serializable = nextRows.filter(
      row => !(row.kind === "entry" && !row.key.trim() && !row.value)
    )
    const text = formatEnvContent(serializable)
    lastSerialized.current = text
    onChange(text)
  }, [onChange])

  const entries = rows.filter((row): row is Extract<EnvLine, { kind: "entry" }> => row.kind === "entry")
  const keyCounts = React.useMemo(() => countEnvKeys(entries), [entries])
  const configuredCount = entries.filter(row => row.key.trim() && row.value.trim()).length

  const updateRow = React.useCallback((id: string, nextLine: EnvLine) => {
    commit(rows.map(row => (row.id === id ? nextLine : row)))
  }, [commit, rows])

  const removeRow = React.useCallback((id: string) => {
    commit(rows.filter(row => row.id !== id))
  }, [commit, rows])

  const addVariable = React.useCallback(() => {
    const id = newEnvRowId()
    allowNextInputFocus()
    commit([...rows, { kind: "entry", id, key: "", value: "", quote: "none", exportPrefix: false }])
    setFocusId(id)
  }, [allowNextInputFocus, commit, rows])

  const addPreset = React.useCallback((presetKey: string) => {
    if (entries.some(row => row.key === presetKey)) return
    const id = newEnvRowId()
    allowNextInputFocus()
    commit([...rows, { kind: "entry", id, key: presetKey, value: "", quote: "none", exportPrefix: false }])
    setFocusId(id)
  }, [allowNextInputFocus, commit, entries, rows])

  return (
    <div
      ref={rootRef}
      data-files-main-scroll
      onFocusCapture={handleFocusCapture}
      onPointerDownCapture={allowNextInputFocus}
      className="h-full min-h-0 overflow-auto rounded-lg border border-border/70 bg-background"
    >
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-[13.5px] font-semibold text-foreground">Environment variables</h3>
            <p className="mt-0.5 text-[12px] text-foreground/50">
              {entries.length} variables · {configuredCount} set
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addVariable}
              disabled={readOnly}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="size-3.5" />
              Add variable
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={readOnly || !dirty || saveState.kind === "saving"}
              className="inline-flex h-8 min-w-[104px] items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              {saveState.kind === "saving" ? (
                <><Loader2 className="size-3.5 animate-spin" /> Saving</>
              ) : saveState.kind === "saved" ? (
                <><CheckCircle2 className="size-3.5" /> Saved</>
              ) : (
                "Save changes"
              )}
            </button>
          </div>
        </div>
        {saveState.kind === "error" && (
          <p className="px-4 pb-2 text-[11.5px] text-destructive">{saveState.message}</p>
        )}
        <div className="hidden grid-cols-[minmax(120px,180px)_minmax(150px,240px)_minmax(0,1fr)_86px_32px] gap-3 border-t border-border/50 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-foreground/35 lg:grid">
          <span>Label</span>
          <span>Name</span>
          <span>Value</span>
          <span>Status</span>
          <span />
        </div>
      </div>

      <div className="divide-y divide-border/50">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-[13px] text-foreground/45">No variables yet.</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={addVariable}
                disabled={readOnly}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="size-3.5" />
                Add variable
              </button>
              {ENV_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => addPreset(preset.key)}
                  disabled={readOnly}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Plus className="size-3.5" />
                  {preset.label} key
                </button>
              ))}
            </div>
          </div>
        ) : rows.map(row => (
          row.kind === "entry" ? (
            <EnvEntryRow
              key={row.id}
              row={row}
              fallbackLabel={(row.key && envLabels[row.key]) || "Custom variable"}
              duplicate={Boolean(row.key) && (keyCounts.get(row.key) ?? 0) > 1}
              readOnly={readOnly}
              revealed={revealed[row.id] === true}
              shouldFocusLabel={focusId === row.id}
              onLabelFocused={() => setFocusId(current => current === row.id ? null : current)}
              onReveal={() => setRevealed(prev => ({ ...prev, [row.id]: !prev[row.id] }))}
              onChange={next => updateRow(row.id, next)}
              onRemove={() => removeRow(row.id)}
            />
          ) : (
            <EnvRawRow
              key={row.id}
              row={row}
              readOnly={readOnly}
              onChange={next => updateRow(row.id, next)}
              onRemove={() => removeRow(row.id)}
            />
          )
        ))}
      </div>
    </div>
  )
}

function EnvEntryRow({
  row,
  fallbackLabel,
  duplicate,
  readOnly,
  revealed,
  shouldFocusLabel,
  onLabelFocused,
  onReveal,
  onChange,
  onRemove,
}: {
  row: Extract<EnvLine, { kind: "entry" }>
  fallbackLabel: string
  duplicate: boolean
  readOnly: boolean
  revealed: boolean
  shouldFocusLabel: boolean
  onLabelFocused: () => void
  onReveal: () => void
  onChange: (row: Extract<EnvLine, { kind: "entry" }>) => void
  onRemove: () => void
}) {
  const labelInputRef = React.useRef<HTMLInputElement | null>(null)
  const copyResetTimerRef = React.useRef<number | null>(null)
  const [copiedField, setCopiedField] = React.useState<"label" | "name" | "value" | null>(null)
  const missingKey = row.key.trim().length === 0
  const valueSet = row.value.trim().length > 0
  // A blank just-added row isn't an error — only flag "no name" once there's
  // a value that would be silently dropped on save without a key.
  const nameError = missingKey && valueSet
  const isNew = missingKey && !valueSet
  const invalid = nameError || duplicate
  const labelValue = row.label ?? (fallbackLabel === "Custom variable" ? "" : fallbackLabel)
  const statusText = copiedField
    ? "Copied"
    : nameError
      ? "No name"
      : duplicate
        ? "Duplicate"
        : valueSet
          ? "Set"
          : isNew
            ? "New"
            : "Empty"
  const statusClassName = copiedField
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
    : invalid
      ? "bg-destructive/10 text-destructive"
      : valueSet
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
        : isNew
          ? "bg-muted text-foreground/45"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-500"

  React.useEffect(() => {
    if (!shouldFocusLabel) return
    labelInputRef.current?.focus()
    onLabelFocused()
  }, [onLabelFocused, shouldFocusLabel])

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const copyField = React.useCallback(async (field: "label" | "name" | "value", value: string) => {
    if (!value) return
    if (!await copyTextToClipboard(value)) return
    setCopiedField(field)
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedField(null)
      copyResetTimerRef.current = null
    }, 1200)
  }, [])

  return (
    <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(120px,180px)_minmax(150px,240px)_minmax(0,1fr)_86px_32px] lg:items-center">
      <div className="min-w-0">
        <input
          ref={labelInputRef}
          value={labelValue}
          readOnly={readOnly}
          onChange={event => onChange({ ...row, label: normalizeEnvLabelInput(event.target.value) })}
          onPointerDown={event => {
            if (event.button !== 0) return
            void copyField("label", labelValue)
          }}
          className={cn(fieldClassName(readOnly), "text-[12.5px]")}
          placeholder="Label"
          title={labelValue ? "Click to copy" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="min-w-0">
        <input
          value={row.key}
          readOnly={readOnly}
          aria-invalid={invalid}
          onChange={event => onChange({ ...row, key: normalizeEnvKeyInput(event.target.value) })}
          onPointerDown={event => {
            if (event.button !== 0) return
            void copyField("name", row.key)
          }}
          onPaste={event => {
            const parsed = parsePastedEnvEntry(event.clipboardData.getData("text"))
            if (!parsed) return
            event.preventDefault()
            onChange({
              ...row,
              key: normalizeEnvKeyInput(parsed.key),
              value: parsed.value,
              quote: parsed.quote,
              exportPrefix: parsed.exportPrefix,
            })
          }}
          className={cn(fieldClassName(readOnly), "font-mono text-[12.5px] aria-invalid:border-destructive/60 aria-invalid:ring-destructive/15")}
          placeholder="VARIABLE_NAME"
          title={row.key ? "Click to copy" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0">
          <input
            value={row.value}
            type={revealed ? "text" : "password"}
            readOnly={readOnly}
            onChange={event => onChange({ ...row, value: event.target.value })}
            onPointerDown={event => {
              if (event.button !== 0) return
              void copyField("value", row.value)
            }}
            onPaste={event => {
              const parsed = parsePastedEnvEntry(event.clipboardData.getData("text"))
              if (!parsed) return
              event.preventDefault()
              onChange({
                ...row,
                key: normalizeEnvKeyInput(parsed.key),
                value: parsed.value,
                quote: parsed.quote,
                exportPrefix: parsed.exportPrefix,
              })
            }}
            className={cn(fieldClassName(readOnly), "rounded-r-none border-r-0 font-mono text-[12.5px]")}
            placeholder="value"
            title={row.value ? "Click to copy" : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={onReveal}
            disabled={readOnly}
            aria-label={revealed ? "Hide value" : "Show value"}
            className="grid size-8 shrink-0 place-items-center rounded-r-lg border border-input bg-background text-foreground/45 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex items-center">
        <span
          className={cn("inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium", statusClassName)}
        >
          {statusText}
        </span>
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={readOnly}
        aria-label={`Remove ${row.key || "variable"}`}
        className="grid size-8 place-items-center rounded-lg text-foreground/35 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function EnvRawRow({
  row,
  readOnly,
  onChange,
  onRemove,
}: {
  row: Extract<EnvLine, { kind: "raw" }>
  readOnly: boolean
  onChange: (row: Extract<EnvLine, { kind: "raw" }>) => void
  onRemove: () => void
}) {
  const trimmed = row.value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith("#")) {
    // A bare comment is just a note, not a section divider — render it quietly
    // so it never reads as intentional UI chrome.
    return (
      <div className="group flex items-center justify-between gap-3 px-4 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground/30">
          {trimmed}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={readOnly}
          aria-label="Remove comment"
          className="grid size-6 shrink-0 place-items-center rounded-md text-foreground/20 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(120px,180px)_minmax(150px,240px)_minmax(0,1fr)_86px_32px] lg:items-start">
      <div className="flex h-8 items-center text-[11.5px] font-medium text-foreground/45">Raw line</div>
      <input
        value={row.value}
        readOnly={readOnly}
        onChange={event => onChange({ ...row, value: event.target.value })}
        className={cn(fieldClassName(readOnly), "font-mono text-[12.5px] text-foreground/65 lg:col-span-2")}
        placeholder="# comment"
        spellCheck={false}
      />
      <div className="hidden lg:block" />
      <button
        type="button"
        onClick={onRemove}
        disabled={readOnly}
        aria-label="Remove line"
        className="grid size-8 place-items-center rounded-lg text-foreground/35 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash2 className="size-3.5" />
      </button>
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
  return <span className="text-[11.5px] text-foreground/45">{dirty ? "Unsaved" : "Auto-save on"}</span>
}

function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  if (kind === "json") return <FileJson className={className} />
  if (kind === "env") return <KeyRound className={className} />
  return <FileText className={className} />
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

function parseEnvContent(content: string): EnvLine[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const rows: EnvLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const label = parseEnvLabelLine(lines[index] ?? "")
    const nextEntry = index + 1 < lines.length ? parseEnvEntryLine(lines[index + 1] ?? "", index + 1) : null
    if (label !== null && nextEntry) {
      rows.push({ ...nextEntry, label })
      index += 1
      continue
    }
    rows.push(parseEnvLine(lines[index] ?? "", index))
  }
  return rows
}

function parseEnvLine(line: string, index: number): EnvLine {
  return parseEnvEntryLine(line, index) ?? { kind: "raw", id: `env-line-${index}`, value: line }
}

function parseEnvEntryLine(line: string, index: number): Extract<EnvLine, { kind: "entry" }> | null {
  const match = line.match(/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
  if (!match) return null
  const parsed = parseEnvValue(match[3] ?? "")
  return {
    kind: "entry",
    id: `env-line-${index}`,
    key: match[2] ?? "",
    value: parsed.value,
    quote: parsed.quote,
    exportPrefix: Boolean(match[1]),
  }
}

function parsePastedEnvEntry(text: string): Extract<EnvLine, { kind: "entry" }> | null {
  const line = text.replace(/\r\n/g, "\n").split("\n").find(candidate => parseEnvEntryLine(candidate, 0) !== null)
  return line ? parseEnvEntryLine(line, 0) : null
}

function parseEnvLabelLine(line: string): string | null {
  const match = line.match(/^\s*#\s*@label\s+(.+?)\s*$/)
  return match ? match[1].trim() : null
}

function parseEnvValue(rawValue: string): { value: string; quote: EnvQuote } {
  const value = rawValue.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return {
      value: value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      quote: "double",
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return {
      value: value.slice(1, -1).replace(/\\'/g, "'"),
      quote: "single",
    }
  }
  return { value, quote: "none" }
}

function formatEnvContent(rows: EnvLine[]): string {
  return rows.map(formatEnvLine).join("\n").replace(/\n*$/, "") + "\n"
}

function formatEnvLine(row: EnvLine): string {
  if (row.kind === "raw") return row.value
  if (!row.key && !row.value) return ""
  const prefix = row.exportPrefix ? "export " : ""
  const envLine = `${prefix}${row.key}=${formatEnvValue(row.value, row.quote)}`
  const label = row.label?.trim()
  return label ? `${ENV_LABEL_PREFIX}${formatEnvLabel(label)}\n${envLine}` : envLine
}

function formatEnvValue(value: string, quote: EnvQuote): string {
  if (value === "") return ""
  if (quote === "single") return `'${value.replace(/'/g, "\\'")}'`
  if (quote === "double" || !/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return value
}

function countEnvKeys(entries: Array<Extract<EnvLine, { kind: "entry" }>>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of entries) {
    if (!row.key) continue
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
  }
  return counts
}

function normalizeEnvKeyInput(value: string): string {
  const withoutExport = value.replace(/^\s*export\s+/, "")
  const beforeEquals = withoutExport.includes("=") ? withoutExport.slice(0, withoutExport.indexOf("=")) : withoutExport
  return beforeEquals.trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "")
}

function normalizeEnvLabelInput(value: string): string {
  return value.replace(/[\r\n]/g, " ")
}

function formatEnvLabel(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim()
}

function newEnvRowId(): string {
  return `env-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
