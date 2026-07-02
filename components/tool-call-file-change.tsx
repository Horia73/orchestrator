import type { ToolCallReasoningEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

type ParsedData = Record<string, unknown> | null
type DiffLineKind = "add" | "delete" | "context" | "hunk" | "meta"

interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

interface FileChange {
  path: string
  kind: string
  diff: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

export interface FileChangeSummary {
  changes: FileChange[]
  additions: number
  deletions: number
}

export function FileChangePreview({
  summary,
  fallbackRows,
}: {
  summary: FileChangeSummary | null
  fallbackRows?: Array<[string, unknown]>
}) {
  if (!summary || summary.changes.length === 0) {
    return fallbackRows ? (
      <div className="p-3">
        <SummaryRows rows={fallbackRows} />
      </div>
    ) : (
      <TextPreview text="No file change details yet." />
    )
  }

  return (
    <div className="divide-y divide-border/70">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
        <span>
          {summary.changes.length} file
          {summary.changes.length === 1 ? "" : "s"} changed
        </span>
        <DiffStat additions={summary.additions} deletions={summary.deletions} />
      </div>
      {summary.changes.map((change, index) => (
        <div key={`${change.path}-${index}`} className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
            <div className="min-w-0">
              <div
                className="truncate font-mono text-[12px] font-medium text-foreground/85"
                title={change.path}
              >
                {change.path}
              </div>
              <div className="text-[11px] capitalize text-muted-foreground">
                {fileChangeAction(change.kind)}
              </div>
            </div>
            <DiffStat additions={change.additions} deletions={change.deletions} />
          </div>
          <DiffLines lines={change.lines} />
        </div>
      ))}
    </div>
  )
}

export function fileChangeSummary(
  entry: ToolCallReasoningEntry,
  data: ParsedData
): FileChangeSummary | null {
  if (entry.toolName === "Write") {
    const path =
      stringField(data, "path") ||
      stringArg(entry.args, "file_path") ||
      stringArg(entry.args, "path")
    const content = stringArg(entry.args, "content")
    if (!path || !content) return null
    const lines = buildDiffLines(content, "create")
    return summarizeChanges([{ path, kind: "create", diff: content, lines }])
  }

  if (entry.toolName !== "file_change") return null

  const changes = arrayRecordField(data, "changes")
    .map((change) => {
      const path =
        stringField(change, "path") ||
        stringField(change, "file") ||
        stringField(change, "file_path")
      const diff = stringField(change, "diff") || stringField(change, "patch")
      const kind = changeKind(change)
      if (!path && !diff) return null
      return {
        path: path || "Untitled file",
        kind,
        diff,
        lines: buildDiffLines(diff, kind),
      }
    })
    .filter(
      (change): change is Omit<FileChange, "additions" | "deletions"> =>
        Boolean(change)
    )

  return summarizeChanges(changes)
}

export function fileChangeTitle(summary: FileChangeSummary): string {
  const stats = diffStatText(summary.additions, summary.deletions)
  if (summary.changes.length === 1) {
    const change = summary.changes[0]
    return `${fileChangeAction(change.kind)} ${basename(change.path)}${stats}`
  }

  const kinds = new Set(
    summary.changes.map((change) => normalizeKind(change.kind))
  )
  const action =
    kinds.size === 1
      ? pluralFileChangeAction(summary.changes[0].kind)
      : "Changed"
  return `${action} ${summary.changes.length} files${stats}`
}

function DiffStat({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  if (additions === 0 && deletions === 0) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px]">
      <span className="text-emerald-700 dark:text-emerald-300">
        +{additions}
      </span>
      <span className="text-red-700 dark:text-red-300">-{deletions}</span>
    </span>
  )
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) {
    return (
      <div className="px-3 py-3 text-[12px] text-muted-foreground">
        No textual diff available.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto bg-background font-mono text-[12px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "grid min-w-[520px] max-md:min-w-full grid-cols-[44px_44px_minmax(0,1fr)] border-l-2",
            line.kind === "add" &&
              "border-l-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
            line.kind === "delete" &&
              "border-l-red-500/60 bg-red-500/10 text-red-900 dark:text-red-100",
            line.kind === "context" &&
              "border-l-transparent text-foreground/78",
            line.kind === "hunk" &&
              "border-l-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-200",
            line.kind === "meta" && "border-l-transparent text-muted-foreground"
          )}
        >
          <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
            {line.oldLine ?? ""}
          </span>
          <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
            {line.newLine ?? ""}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words px-2">
            <span className="mr-2 select-none text-current/60">
              {diffSign(line.kind)}
            </span>
            {line.text || " "}
          </span>
        </div>
      ))}
    </div>
  )
}

function TextPreview({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed text-foreground/85">
      {text || "No output yet."}
    </pre>
  )
}

function SummaryRows({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <div className="grid gap-1 text-[12px]">
      {rows
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([label, value]) => (
          <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate font-mono text-foreground/85">
              {String(value)}
            </span>
          </div>
        ))}
    </div>
  )
}

function summarizeChanges(
  changes: Array<Omit<FileChange, "additions" | "deletions">>
): FileChangeSummary | null {
  if (changes.length === 0) return null
  const withStats = changes.map((change) => {
    const additions = change.lines.filter((line) => line.kind === "add").length
    const deletions = change.lines.filter(
      (line) => line.kind === "delete"
    ).length
    return { ...change, additions, deletions }
  })
  return {
    changes: withStats,
    additions: withStats.reduce((sum, change) => sum + change.additions, 0),
    deletions: withStats.reduce((sum, change) => sum + change.deletions, 0),
  }
}

function buildDiffLines(diff: string, kind: string): DiffLine[] {
  if (!diff) return []
  const rawLines = splitDiffLines(diff)
  const lowerKind = kind.toLowerCase()
  const unified = rawLines.some((line) => line.startsWith("@@"))

  if (!unified) {
    const lineKind: DiffLineKind = isCreateKind(lowerKind)
      ? "add"
      : isDeleteKind(lowerKind)
        ? "delete"
        : "context"
    return rawLines.map((text, index) => ({
      kind: lineKind,
      text,
      oldLine:
        lineKind === "delete" || lineKind === "context"
          ? index + 1
          : undefined,
      newLine:
        lineKind === "add" || lineKind === "context" ? index + 1 : undefined,
    }))
  }

  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of rawLines) {
    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      lines.push({
        kind: "hunk",
        text: `${lineRangeLabel(oldLine, numberFromMatch(hunk[2]))} -> ${lineRangeLabel(newLine, numberFromMatch(hunk[4]))}`,
      })
      continue
    }

    if (raw === "\\ No newline at end of file") {
      lines.push({ kind: "meta", text: raw })
      continue
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.push({ kind: "add", text: raw.slice(1), newLine })
      newLine += 1
      continue
    }

    if (raw.startsWith("-") && !raw.startsWith("---")) {
      lines.push({ kind: "delete", text: raw.slice(1), oldLine })
      oldLine += 1
      continue
    }

    if (raw.startsWith(" ")) {
      lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
      continue
    }

    lines.push({ kind: "meta", text: raw })
  }

  return lines
}

function splitDiffLines(diff: string): string[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

function numberFromMatch(value: string | undefined): number {
  return value ? Number(value) : 1
}

function lineRangeLabel(start: number, count: number): string {
  if (count <= 1) return `L${start}`
  return `L${start}-L${start + count - 1}`
}

function diffStatText(additions: number, deletions: number): string {
  return additions || deletions ? ` +${additions} -${deletions}` : ""
}

function fileChangeAction(kind: string): string {
  const normalized = normalizeKind(kind)
  if (isCreateKind(normalized)) return "Created"
  if (isDeleteKind(normalized)) return "Deleted"
  if (normalized === "rename" || normalized === "move") return "Moved"
  return "Edited"
}

function pluralFileChangeAction(kind: string): string {
  const normalized = normalizeKind(kind)
  if (isCreateKind(normalized)) return "Created"
  if (isDeleteKind(normalized)) return "Deleted"
  if (normalized === "rename" || normalized === "move") return "Moved"
  return "Edited"
}

function changeKind(change: Record<string, unknown>): string {
  const direct = stringField(change, "kind") || stringField(change, "type")
  if (direct) return direct
  const kind = objectRecord(change.kind)
  return stringField(kind, "type") || "update"
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase()
}

function isCreateKind(kind: string): boolean {
  return kind === "create" || kind === "add" || kind === "new"
}

function isDeleteKind(kind: string): boolean {
  return kind === "delete" || kind === "remove" || kind === "deleted"
}

function diffSign(kind: DiffLineKind): string {
  if (kind === "add") return "+"
  if (kind === "delete") return "-"
  return " "
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  return normalized.split("/").filter(Boolean).pop() || normalized || "file"
}

function stringArg(
  args: Record<string, unknown> | undefined,
  key: string
): string {
  const value = args?.[key]
  return typeof value === "string" ? value : ""
}

function stringField(data: unknown, key: string): string {
  const record = objectRecord(data)
  const value = record?.[key]
  return typeof value === "string" ? value : ""
}

function arrayRecordField(
  data: unknown,
  key: string
): Record<string, unknown>[] {
  const value = objectRecord(data)?.[key]
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(objectRecord(item))
      )
    : []
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
