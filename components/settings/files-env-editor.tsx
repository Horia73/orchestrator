"use client"

import * as React from "react"
import { CheckCircle2, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react"

import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import {
  ENV_PRESETS,
  countEnvKeys,
  formatEnvContent,
  isRedactedEnvValue,
  newEnvRowId,
  normalizeEnvKeyInput,
  parseEnvContent,
  parsePastedEnvEntry,
  revealEnvValue,
  type EnvLine,
  type EnvRevealState,
} from "@/components/settings/files-env-utils"

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }

const ENV_RESTORE_FOCUS_SUPPRESSION_MS = 2500

export function EnvEditor({
  content,
  readOnly,
  fileKey,
  dirty,
  saveState,
  onSave,
  onChange,
}: {
  content: string
  readOnly: boolean
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
  const rowsRef = React.useRef(rows)
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({})
  const [revealState, setRevealState] = React.useState<EnvRevealState>({})
  const [focusId, setFocusId] = React.useState<string | null>(null)

  React.useEffect(() => {
    rowsRef.current = rows
  }, [rows])

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
      setRevealState({})
      setFocusId(null)
      suppressRestoredInputFocus()
      window.requestAnimationFrame(blurRestoredInputFocus)
    }
  }, [blurRestoredInputFocus, content, fileKey, suppressRestoredInputFocus, toStableRows])

  const serializeRows = React.useCallback((nextRows: EnvLine[]) => {
    const serializable = nextRows.filter(
      row => !(row.kind === "entry" && !row.key.trim() && !row.value)
    )
    return formatEnvContent(serializable)
  }, [])

  const commit = React.useCallback((nextRows: EnvLine[]) => {
    setRows(nextRows)
    // A brand-new untouched row (no name AND no value) isn't a real change —
    // keep it on screen but don't write it to the file or dirty the editor.
    const text = serializeRows(nextRows)
    lastSerialized.current = text
    onChange(text)
  }, [onChange, serializeRows])

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

  const revealRow = React.useCallback(async (row: Extract<EnvLine, { kind: "entry" }>) => {
    if (revealed[row.id]) {
      setRevealed(prev => ({ ...prev, [row.id]: false }))
      return
    }

    if (!isRedactedEnvValue(row.value)) {
      setRevealed(prev => ({ ...prev, [row.id]: true }))
      return
    }

    const key = row.key.trim()
    if (!key) return
    const targetIndex = rowsRef.current.findIndex(candidate => candidate.id === row.id)
    const occurrence = targetIndex >= 0
      ? rowsRef.current
          .slice(0, targetIndex + 1)
          .filter(candidate => candidate.kind === "entry" && candidate.key === row.key)
          .length - 1
      : 0

    setRevealState(prev => {
      const next = { ...prev }
      delete next[row.id]
      return next
    })
    try {
      const result = await revealEnvValue(fileKey, key, occurrence)
      const currentRows = rowsRef.current
      const nextRows = currentRows.map(candidate => (
        candidate.kind === "entry" &&
        candidate.id === row.id &&
        candidate.key === row.key &&
        isRedactedEnvValue(candidate.value)
          ? { ...candidate, value: result.value, quote: result.quote }
          : candidate
      ))
      rowsRef.current = nextRows
      setRows(nextRows)
      setRevealed(prev => ({ ...prev, [row.id]: true }))
      setRevealState(prev => {
        const next = { ...prev }
        delete next[row.id]
        return next
      })
    } catch (err) {
      setRevealState(prev => ({
        ...prev,
        [row.id]: { message: err instanceof Error ? err.message : "Reveal failed" },
      }))
    }
  }, [fileKey, revealed])

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
        <div className="hidden grid-cols-[minmax(180px,260px)_minmax(0,1fr)_86px_32px] gap-3 border-t border-border/50 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-foreground/35 lg:grid">
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
        ) : rows.map(row => {
          if (row.kind !== "entry") {
            return (
              <EnvRawRow
                key={row.id}
                row={row}
                readOnly={readOnly}
                onChange={next => updateRow(row.id, next)}
                onRemove={() => removeRow(row.id)}
              />
            )
          }
          return (
            <EnvEntryRow
              key={row.id}
              row={row}
              duplicate={Boolean(row.key) && (keyCounts.get(row.key) ?? 0) > 1}
              readOnly={readOnly}
              revealed={revealed[row.id] === true}
              revealError={revealState[row.id]?.message ?? null}
              shouldFocusName={focusId === row.id}
              onNameFocused={() => setFocusId(current => current === row.id ? null : current)}
              onReveal={() => { void revealRow(row) }}
              onChange={next => updateRow(row.id, next)}
              onRemove={() => removeRow(row.id)}
            />
          )
        })}
      </div>
    </div>
  )
}

function EnvEntryRow({
  row,
  duplicate,
  readOnly,
  revealed,
  revealError,
  shouldFocusName,
  onNameFocused,
  onReveal,
  onChange,
  onRemove,
}: {
  row: Extract<EnvLine, { kind: "entry" }>
  duplicate: boolean
  readOnly: boolean
  revealed: boolean
  revealError: string | null
  shouldFocusName: boolean
  onNameFocused: () => void
  onReveal: () => void
  onChange: (row: Extract<EnvLine, { kind: "entry" }>) => void
  onRemove: () => void
}) {
  const nameInputRef = React.useRef<HTMLInputElement | null>(null)
  const copyResetTimerRef = React.useRef<number | null>(null)
  const [copiedField, setCopiedField] = React.useState<"name" | "value" | null>(null)
  const missingKey = row.key.trim().length === 0
  const valueSet = row.value.trim().length > 0
  // A blank just-added row isn't an error — only flag "no name" once there's
  // a value that would be silently dropped on save without a key.
  const nameError = missingKey && valueSet
  const isNew = missingKey && !valueSet
  const invalid = nameError || duplicate
  const statusText = copiedField
    ? "Copied"
    : revealError
        ? "Reveal failed"
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
    : revealError
      ? "bg-destructive/10 text-destructive"
      : invalid
      ? "bg-destructive/10 text-destructive"
      : valueSet
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
        : isNew
          ? "bg-muted text-foreground/45"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-500"

  React.useEffect(() => {
    if (!shouldFocusName) return
    nameInputRef.current?.focus()
    onNameFocused()
  }, [onNameFocused, shouldFocusName])

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const copyField = React.useCallback(async (field: "name" | "value", value: string) => {
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
    <div
      data-env-entry-row
      data-env-key={row.key || undefined}
      className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(180px,260px)_minmax(0,1fr)_86px_32px] lg:items-center"
    >
      <div className="min-w-0">
        <input
          ref={nameInputRef}
          value={row.key}
          readOnly={readOnly}
          aria-invalid={invalid}
          onChange={event => onChange({ ...row, key: normalizeEnvKeyInput(event.target.value) })}
          onDoubleClick={event => {
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
          title={row.key ? "Double-click to copy" : undefined}
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
            onDoubleClick={event => {
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
            title={row.value ? "Double-click to copy" : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            data-env-reveal-button
            onClick={onReveal}
            disabled={readOnly}
            aria-label={revealed ? "Hide value" : "Show value"}
            title={revealError ?? undefined}
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
        data-env-remove-button
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
          className="grid size-6 shrink-0 place-items-center rounded-md text-foreground/20 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 pointer-coarse:opacity-100 disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(180px,260px)_minmax(0,1fr)_86px_32px] lg:items-start">
      <div className="flex h-8 items-center text-[11.5px] font-medium text-foreground/45">Raw line</div>
      <input
        value={row.value}
        readOnly={readOnly}
        onChange={event => onChange({ ...row, value: event.target.value })}
        className={cn(fieldClassName(readOnly), "font-mono text-[12.5px] text-foreground/65 lg:col-span-2")}
        placeholder="# comment"
        spellCheck={false}
      />
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

function fieldClassName(readOnly: boolean): string {
  return cn(
    "min-w-0 rounded-lg border border-input bg-background px-2.5 text-[16px] md:text-[12px] text-foreground outline-none transition-colors placeholder:text-foreground/35 focus:border-ring focus:ring-3 focus:ring-ring/20",
    readOnly && "bg-muted/30 text-foreground/60"
  )
}
