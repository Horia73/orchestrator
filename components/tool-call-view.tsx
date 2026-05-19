"use client"

import * as React from "react"
import { Camera, CloudSun, Clock3, ExternalLink, ImageIcon, LineChart, Search, Trophy } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import type { ToolCallReasoningEntry } from "@/lib/types"
import type { ArtifactPayload } from "@/components/artifact-panel"
import { cn } from "@/lib/utils"

interface InlineToolCallViewProps {
    entry: ToolCallReasoningEntry
    onOpen?: (artifact: ArtifactPayload) => void
    searchDisplay?: "expanded" | "compact"
}

type ParsedData = Record<string, unknown> | null

const TOOL_CALL_PANEL_HEIGHT = "min(230px, calc(100vh - 360px))"
const TOOL_CALL_PANEL_MIN_HEIGHT = "160px"
const TOOL_CALL_PANEL_STYLE: React.CSSProperties = {
    height: TOOL_CALL_PANEL_HEIGHT,
    minHeight: TOOL_CALL_PANEL_MIN_HEIGHT,
}

export function InlineToolCallView({ entry, searchDisplay = "expanded" }: InlineToolCallViewProps) {
    const status = entry.status ?? (entry.content ? (entry.success === false ? "error" : "ok") : "running")
    const data = parseToolData(entry.content)

    if (isHiddenToolCall(entry)) return null

    if (entry.toolName === "Bash" || entry.toolName === "shell") {
        return (
            <div
                className="relative z-10 ml-7 flex max-w-[min(760px,calc(100vw-180px))] flex-col overflow-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] text-left shadow-sm"
                style={TOOL_CALL_PANEL_STYLE}
            >
                <LiveTerminal entry={entry} data={data} />
            </div>
        )
    }

    if (isSearchTool(entry.toolName)) {
        if (searchDisplay === "compact") {
            return (
                <div className="relative z-10 ml-7 max-w-[min(760px,calc(100vw-180px))] py-1 text-left">
                    <CompactSearchPreview entry={entry} status={status} data={data} />
                </div>
            )
        }
        return (
            <div className="relative z-10 ml-7 grid max-w-[min(760px,calc(100vw-180px))] content-start items-start gap-1.5 py-1 text-left">
                <div className="overflow-auto pr-1" style={TOOL_CALL_PANEL_STYLE}>
                    <SearchPreview data={data} rawText={entry.content} args={entry.args} />
                </div>
            </div>
        )
    }

    return (
        <ToolFrame>
            <ToolPreview entry={entry} data={data} />
        </ToolFrame>
    )
}

function isHiddenToolCall(entry: ToolCallReasoningEntry): boolean {
    const name = (entry.toolName ?? entry.title).trim().toLowerCase()
    return name === "todowrite" || name === "delegate_to" || name.startsWith("delegate to ")
}

function isSearchTool(toolName: string | undefined): boolean {
    return toolName === "web_search" || toolName === "WebSearch"
}

function ToolFrame({
    bodyClassName,
    children,
}: {
    bodyClassName?: string
    children: React.ReactNode
}) {
    return (
        <div className="relative z-10 ml-7 max-w-[min(760px,calc(100vw-180px))] overflow-hidden rounded-md border border-border bg-background text-left shadow-sm">
            <div
                className={cn("overflow-auto bg-background", bodyClassName)}
                style={TOOL_CALL_PANEL_STYLE}
            >
                {children}
            </div>
        </div>
    )
}

function StatusPill({ status }: { status: "running" | "ok" | "error" }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                status === "running" && "bg-blue-500/10 text-blue-600 dark:text-blue-300",
                status === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                status === "error" && "bg-destructive/10 text-destructive"
            )}
        >
            {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
            {status}
        </span>
    )
}

function CompactSearchPreview({ entry, status, data }: { entry: ToolCallReasoningEntry; status: "running" | "ok" | "error"; data: ParsedData }) {
    const queries = searchQueries(data, entry.args, entry.content)
    const websites = searchWebsites(data, entry.content)
    const requests = webRequestItems(data, entry.args, entry.content)
    const entryTitle = entry.title?.trim() ?? ""
    const genericTitle = !entryTitle || entryTitle === "Search" || entryTitle === "Search web"
    const primary = genericTitle
        ? requests[0]?.label || (queries[0] ? `Search ${queries[0]}` : "Web")
        : entryTitle
    const detail = status === "running"
        ? requests.length > 1
            ? `${requests.length} web actions in progress`
            : queries.length > 1
                ? `${queries.length} searches in progress`
                : "Web action in progress"
        : websites.length > 0
            ? `${websites.length} source${websites.length === 1 ? "" : "s"} found`
            : requests.length > 0
                ? `${requests.length} web action${requests.length === 1 ? "" : "s"} finished`
                : queries.length > 0
                ? `${queries.length} search${queries.length === 1 ? "" : "es"} finished`
                : status === "error" ? "Web action failed" : "Web action finished"

    return (
        <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2 shadow-sm">
            <span
                className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-md border",
                    status === "running" && "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300",
                    status === "ok" && "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    status === "error" && "border-destructive/20 bg-destructive/10 text-destructive"
                )}
            >
                <Search className={cn("size-3.5", status === "running" && "animate-pulse")} />
            </span>
            <span className="min-w-0">
                <span
                    className={cn(
                        "block truncate text-[13px] font-medium",
                        status === "running" ? "search-shimmer-text" : "text-foreground/78"
                    )}
                    title={primary}
                >
                    {primary}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
            </span>
            <StatusPill status={status} />
        </div>
    )
}

function LiveTerminal({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const containerRef = React.useRef<HTMLDivElement>(null)
    const termRef = React.useRef<Terminal | null>(null)
    const fitRef = React.useRef<FitAddon | null>(null)
    const writtenRef = React.useRef(0)
    const streamText = React.useMemo(() => terminalText(entry, data), [entry, data])

    React.useEffect(() => {
        if (!containerRef.current) return
        const term = new Terminal({
            convertEol: true,
            cursorBlink: false,
            cursorStyle: "block",
            disableStdin: true,
            fontFamily: '"SF Mono", Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.22,
            scrollback: 8000,
            theme: {
                background: "#0c0c0e",
                foreground: "#e4e4e7",
                cursor: "#e4e4e7",
                black: "#1f1f23",
                red: "#f87171",
                green: "#34d399",
                yellow: "#fbbf24",
                blue: "#60a5fa",
                magenta: "#c084fc",
                cyan: "#22d3ee",
                white: "#e4e4e7",
                brightBlack: "#52525b",
                brightRed: "#fca5a5",
                brightGreen: "#86efac",
                brightYellow: "#fcd34d",
                brightBlue: "#93c5fd",
                brightMagenta: "#d8b4fe",
                brightCyan: "#67e8f9",
                brightWhite: "#fafafa",
            },
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.loadAddon(new WebLinksAddon())
        term.open(containerRef.current)
        termRef.current = term
        fitRef.current = fit
        try { fit.fit() } catch {}
        return () => {
            term.dispose()
            termRef.current = null
            fitRef.current = null
            writtenRef.current = 0
        }
    }, [])

    React.useEffect(() => {
        const term = termRef.current
        if (!term) return
        term.options.cursorBlink = entry.status === "running"
    }, [entry.status])

    React.useEffect(() => {
        const term = termRef.current
        if (!term) return
        const next = streamText.slice(writtenRef.current)
        if (next) {
            term.write(next)
            writtenRef.current = streamText.length
        }
    }, [streamText])

    React.useEffect(() => {
        const el = containerRef.current
        const fit = fitRef.current
        if (!el || !fit) return
        const ro = new ResizeObserver(() => {
            try { fit.fit() } catch {}
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    return (
        <div
            ref={containerRef}
            className="min-h-0 flex-1 px-2 py-2"
        />
    )
}

function ToolPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    if (entry.success === false) {
        return <ErrorPreview entry={entry} data={data} />
    }

    switch (entry.toolName) {
        case "Read":
        case "read_file":
            return <ReadPreview entry={entry} data={data} />
        case "Write":
            return <FileChangePreview summary={fileChangeSummary(entry, data)} fallbackRows={[
                ["Path", stringField(data, "path") || stringArg(entry.args, "file_path")],
                ["Bytes", numberField(data, "bytes")],
            ]} />
        case "Edit":
            return <EditPreview entry={entry} data={data} />
        case "file_change":
            return <FileChangePreview summary={fileChangeSummary(entry, data)} />
        case "Glob":
            return <GlobPreview entry={entry} data={data} />
        case "Grep":
            return <GrepPreview entry={entry} data={data} />
        case "WebFetch":
            return <TextPreview text={stringField(data, "content") || entry.content} />
        case "WebSearch":
        case "web_search":
            return <SearchPreview data={data} rawText={entry.content} args={entry.args} />
        default:
            return <TextPreview text={entry.content || "No output yet."} />
    }
}

function TextPreview({ text }: { text: string }) {
    return <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed text-foreground/85">{text || "No output yet."}</pre>
}

function ErrorPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const raw = entry.content.replace(/^Error:\s*/, "").trim()
    const message = stringField(data, "message") || stringField(data, "error") || raw || "Tool call failed."
    const path = stringArg(entry.args, "path") || stringArg(entry.args, "file_path") || stringField(data, "path")
    const detail = raw && raw !== message ? raw : ""

    return (
        <div className="grid gap-2 border-l-2 border-l-destructive bg-destructive/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-destructive">Tool failed</span>
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px] text-destructive">
                    {entry.toolName ?? entry.title}
                </span>
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-destructive">
                {message}
            </div>
            {path && <div className="truncate font-mono text-[11px] text-destructive/75">{path}</div>}
            {detail && (
                <details className="text-[12px] text-destructive/80">
                    <summary className="cursor-pointer select-none">Details</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{detail}</pre>
                </details>
            )}
        </div>
    )
}

function ReadPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const text = stringField(data, "content") || entry.content
    const path = stringField(data, "path") || stringArg(entry.args, "path") || stringArg(entry.args, "file_path")
    const rows = readRows(text, numberField(data, "startLine") ?? numberArg(entry.args, "offset") ?? 1)
    const totalLines = numberField(data, "totalLines")
    const returned = numberField(data, "linesReturned") ?? rows.length
    const language = languageFromPath(path)

    return (
        <div className="divide-y divide-border/60">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] font-medium text-foreground/85" title={path}>
                        {path || "Read file"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                        {returned} line{returned === 1 ? "" : "s"}{totalLines ? ` of ${totalLines}` : ""}
                    </div>
                </div>
                {language && (
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px]", languageClass(language))}>
                        {language}
                    </span>
                )}
            </div>
            <CodeRows rows={rows} />
        </div>
    )
}

interface CodeRow {
    lineNumber: number
    text: string
}

function CodeRows({ rows }: { rows: CodeRow[] }) {
    if (rows.length === 0) return <div className="px-3 py-3 text-[13px] text-muted-foreground">No content.</div>
    return (
        <div className="overflow-x-auto bg-background font-mono text-[12px] leading-5">
            {rows.map((row, index) => (
                <div key={`${row.lineNumber}-${index}`} className="grid min-w-[520px] grid-cols-[56px_minmax(0,1fr)]">
                    <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
                        {row.lineNumber}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words px-2 text-foreground/82">
                        {row.text || " "}
                    </span>
                </div>
            ))}
        </div>
    )
}

function GlobPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const matches = arrayField(data, "matches")
    const count = numberField(data, "count") ?? matches.length
    const pattern = stringField(data, "pattern") || stringArg(entry.args, "pattern")

    if (matches.length === 0) {
        return (
            <div className="grid gap-1 p-3 text-[13px]">
                <div className="font-medium text-foreground/80">No matching files</div>
                {pattern && <div className="font-mono text-[12px] text-muted-foreground">{pattern}</div>}
            </div>
        )
    }

    return (
        <div className="divide-y divide-border/60">
            <ToolSummaryLine
                primary={`${count} file${count === 1 ? "" : "s"}`}
                secondary={pattern}
                trailing={booleanField(data, "truncated") ? "truncated" : undefined}
            />
            <PathList paths={matches} empty="No matching files." />
        </div>
    )
}

function GrepPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const pattern = stringField(data, "pattern") || stringArg(entry.args, "pattern")
    const mode = stringField(data, "output_mode") || stringArg(entry.args, "output_mode") || "content"
    const fileMatches = mode === "files_with_matches" ? arrayField(data, "matches") : []
    const rows = grepRows(data, entry.content)
    const count = numberField(data, "count") ?? (mode === "files_with_matches" ? fileMatches.length : rows.length)

    if (mode === "files_with_matches") {
        return (
            <div className="divide-y divide-border/60">
                <ToolSummaryLine primary={`${fileMatches.length} file${fileMatches.length === 1 ? "" : "s"} with matches`} secondary={pattern} />
                <PathList paths={fileMatches} empty="No files matched." />
            </div>
        )
    }

    if (rows.length === 0) {
        return (
            <div className="grid gap-1 p-3 text-[13px]">
                <div className="font-medium text-foreground/80">No matches</div>
                {pattern && <div className="font-mono text-[12px] text-muted-foreground">{pattern}</div>}
            </div>
        )
    }

    const groups = groupGrepRows(rows)
    return (
        <div className="divide-y divide-border/60">
            <ToolSummaryLine
                primary={`${count} match${count === 1 ? "" : "es"}`}
                secondary={pattern}
                trailing={booleanField(data, "truncated") ? "truncated" : undefined}
            />
            <div className="divide-y divide-border/50">
                {groups.map(group => (
                    <div key={group.file} className="min-w-0">
                        <div className="flex items-center justify-between gap-2 bg-muted/20 px-3 py-1.5">
                            <span className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground/85" title={group.file}>
                                {group.file}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                {group.rows.length}
                            </span>
                        </div>
                        <div className="overflow-x-auto font-mono text-[12px] leading-5">
                            {group.rows.map((row, index) => (
                                <div key={`${row.line}-${row.column}-${index}`} className="grid min-w-[520px] grid-cols-[56px_minmax(0,1fr)]">
                                    <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
                                        {row.line || ""}
                                    </span>
                                    <span className="min-w-0 whitespace-pre-wrap break-words px-2 text-foreground/82">
                                        <HighlightedText text={row.text} needle={pattern} />
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function ToolSummaryLine({ primary, secondary, trailing }: { primary: string; secondary?: string; trailing?: string }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12px]">
            <div className="min-w-0">
                <div className="font-medium text-foreground/80">{primary}</div>
                {secondary && <div className="truncate font-mono text-[11px] text-muted-foreground" title={secondary}>{secondary}</div>}
            </div>
            {trailing && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{trailing}</span>}
        </div>
    )
}

function PathList({ paths, empty }: { paths: string[]; empty: string }) {
    const groups = groupPaths(paths)
    if (paths.length === 0) return <div className="p-3 text-[13px] text-muted-foreground">{empty}</div>
    return (
        <div className="divide-y divide-border/50">
            {groups.map(group => (
                <div key={group.dir} className="grid gap-1 px-3 py-2">
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={group.dir}>{group.dir}</div>
                    <div className="grid gap-0.5">
                        {group.items.map(item => (
                            <div key={item.full} className="flex min-w-0 items-center gap-2 font-mono text-[12px] text-foreground/85">
                                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", extensionDotClass(item.name))} />
                                <span className="truncate" title={item.full}>{item.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

export function shouldExpandToolCallByDefault(entry: ToolCallReasoningEntry): boolean {
    return !isHiddenToolCall(entry)
}

export function getToolCallDisplayTitle(entry: ToolCallReasoningEntry, parsedData: ParsedData = parseToolData(entry.content)): string {
    if (entry.success === false) return `Failed ${entry.toolName ?? entry.title}`
    if (entry.toolName === "Read" || entry.toolName === "read_file") {
        const path = stringField(parsedData, "path") || stringArg(entry.args, "path") || stringArg(entry.args, "file_path")
        const lines = numberField(parsedData, "linesReturned")
        return path ? `Read ${basename(path)}${lines ? ` (${lines} lines)` : ""}` : entry.title
    }
    if (entry.toolName === "Glob") {
        const count = numberField(parsedData, "count") ?? arrayField(parsedData, "matches").length
        return count > 0 ? `Found ${count} file${count === 1 ? "" : "s"}` : entry.title
    }
    if (entry.toolName === "Grep") {
        const count = numberField(parsedData, "count")
        return typeof count === "number" ? `Found ${count} match${count === 1 ? "" : "es"}` : entry.title
    }
    if (isSearchTool(entry.toolName)) {
        const requests = webRequestItems(parsedData, entry.args, entry.content)
        if (requests.length > 1) return `${requests.length} web actions`
        if (requests.length === 1) return requests[0].label
    }
    const summary = fileChangeSummary(entry, parsedData)
    if (summary) return fileChangeTitle(summary)
    return entry.title
}

function EditPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const oldText = stringArg(entry.args, "old_string")
    const newText = stringArg(entry.args, "new_string")
    return (
        <div className="grid gap-2 p-3">
            <SummaryRows rows={[
                ["Path", stringField(data, "path") || stringArg(entry.args, "file_path")],
                ["Replacements", numberField(data, "replacements")],
            ]} />
            {(oldText || newText) && (
                <div className="grid gap-1 font-mono text-[12px]">
                    <pre className="overflow-auto rounded border border-red-500/20 bg-red-500/5 p-2 text-red-700 dark:text-red-300">- {oldText}</pre>
                    <pre className="overflow-auto rounded border border-emerald-500/20 bg-emerald-500/5 p-2 text-emerald-700 dark:text-emerald-300">+ {newText}</pre>
                </div>
            )}
        </div>
    )
}

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

interface FileChangeSummary {
    changes: FileChange[]
    additions: number
    deletions: number
}

function FileChangePreview({
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
                <span>{summary.changes.length} file{summary.changes.length === 1 ? "" : "s"} changed</span>
                <DiffStat additions={summary.additions} deletions={summary.deletions} />
            </div>
            {summary.changes.map((change, index) => (
                <div key={`${change.path}-${index}`} className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
                        <div className="min-w-0">
                            <div className="truncate font-mono text-[12px] font-medium text-foreground/85" title={change.path}>
                                {change.path}
                            </div>
                            <div className="text-[11px] capitalize text-muted-foreground">{fileChangeAction(change.kind)}</div>
                        </div>
                        <DiffStat additions={change.additions} deletions={change.deletions} />
                    </div>
                    <DiffLines lines={change.lines} />
                </div>
            ))}
        </div>
    )
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
    if (additions === 0 && deletions === 0) return null
    return (
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px]">
            <span className="text-emerald-700 dark:text-emerald-300">+{additions}</span>
            <span className="text-red-700 dark:text-red-300">-{deletions}</span>
        </span>
    )
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
    if (lines.length === 0) {
        return <div className="px-3 py-3 text-[12px] text-muted-foreground">No textual diff available.</div>
    }

    return (
        <div className="overflow-x-auto bg-background font-mono text-[12px] leading-5">
            {lines.map((line, index) => (
                <div
                    key={index}
                    className={cn(
                        "grid min-w-[520px] grid-cols-[44px_44px_minmax(0,1fr)] border-l-2",
                        line.kind === "add" && "border-l-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
                        line.kind === "delete" && "border-l-red-500/60 bg-red-500/10 text-red-900 dark:text-red-100",
                        line.kind === "context" && "border-l-transparent text-foreground/78",
                        line.kind === "hunk" && "border-l-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-200",
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
                        <span className="mr-2 select-none text-current/60">{diffSign(line.kind)}</span>
                        {line.text || " "}
                    </span>
                </div>
            ))}
        </div>
    )
}

function fileChangeSummary(entry: ToolCallReasoningEntry, data: ParsedData): FileChangeSummary | null {
    if (entry.toolName === "Write") {
        const path = stringField(data, "path") || stringArg(entry.args, "file_path") || stringArg(entry.args, "path")
        const content = stringArg(entry.args, "content")
        if (!path || !content) return null
        const lines = buildDiffLines(content, "create")
        return summarizeChanges([{ path, kind: "create", diff: content, lines }])
    }

    if (entry.toolName !== "file_change") return null

    const changes = arrayRecordField(data, "changes")
        .map(change => {
            const path = stringField(change, "path") || stringField(change, "file") || stringField(change, "file_path")
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
        .filter((change): change is Omit<FileChange, "additions" | "deletions"> => Boolean(change))

    return summarizeChanges(changes)
}

function summarizeChanges(changes: Array<Omit<FileChange, "additions" | "deletions">>): FileChangeSummary | null {
    if (changes.length === 0) return null
    const withStats = changes.map(change => {
        const additions = change.lines.filter(line => line.kind === "add").length
        const deletions = change.lines.filter(line => line.kind === "delete").length
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
    const unified = rawLines.some(line => line.startsWith("@@"))

    if (!unified) {
        const lineKind: DiffLineKind = isCreateKind(lowerKind) ? "add" : isDeleteKind(lowerKind) ? "delete" : "context"
        return rawLines.map((text, index) => ({
            kind: lineKind,
            text,
            oldLine: lineKind === "delete" || lineKind === "context" ? index + 1 : undefined,
            newLine: lineKind === "add" || lineKind === "context" ? index + 1 : undefined,
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

function fileChangeTitle(summary: FileChangeSummary): string {
    const stats = diffStatText(summary.additions, summary.deletions)
    if (summary.changes.length === 1) {
        const change = summary.changes[0]
        return `${fileChangeAction(change.kind)} ${basename(change.path)}${stats}`
    }

    const kinds = new Set(summary.changes.map(change => normalizeKind(change.kind)))
    const action = kinds.size === 1
        ? pluralFileChangeAction(summary.changes[0].kind)
        : "Changed"
    return `${action} ${summary.changes.length} files${stats}`
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

function dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/")
    const parts = normalized.split("/").filter(Boolean)
    if (parts.length <= 1) return "."
    const hasLeadingSlash = normalized.startsWith("/")
    return `${hasLeadingSlash ? "/" : ""}${parts.slice(0, -1).join("/")}`
}

function readRows(text: string, startLine: number): CodeRow[] {
    if (!text.trim()) return []
    return splitDiffLines(text).map((line, index) => {
        const numbered = line.match(/^\s*(\d+)\s{2}(.*)$/)
        if (numbered) {
            return { lineNumber: Number(numbered[1]), text: numbered[2] }
        }
        return { lineNumber: startLine + index, text: line }
    })
}

interface PathGroup {
    dir: string
    items: Array<{ name: string; full: string }>
}

function groupPaths(paths: string[]): PathGroup[] {
    const groups = new Map<string, Array<{ name: string; full: string }>>()
    for (const full of paths) {
        const dir = dirname(full)
        const items = groups.get(dir) ?? []
        items.push({ name: basename(full), full })
        groups.set(dir, items)
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, items]) => ({ dir, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
}

interface GrepRow {
    file: string
    line: number | null
    column: number | null
    text: string
}

function grepRows(data: ParsedData, rawText: string): GrepRow[] {
    const content = stringField(data, "content") || rawText
    const lines = splitDiffLines(content).filter(Boolean)
    return lines.map(parseGrepLine).filter((row): row is GrepRow => Boolean(row))
}

function parseGrepLine(line: string): GrepRow | null {
    const contentMatch = line.match(/^(.+?)([:-])(\d+)\2(\d+)\2(.*)$/)
    if (contentMatch) {
        return {
            file: contentMatch[1],
            line: Number(contentMatch[3]),
            column: Number(contentMatch[4]),
            text: contentMatch[5],
        }
    }

    const countMatch = line.match(/^(.+?):(\d+)$/)
    if (countMatch) {
        return {
            file: countMatch[1],
            line: null,
            column: null,
            text: `${countMatch[2]} matches`,
        }
    }

    return line.trim() ? { file: ".", line: null, column: null, text: line } : null
}

function groupGrepRows(rows: GrepRow[]): Array<{ file: string; rows: GrepRow[] }> {
    const groups = new Map<string, GrepRow[]>()
    for (const row of rows) {
        const current = groups.get(row.file) ?? []
        current.push(row)
        groups.set(row.file, current)
    }
    return [...groups.entries()].map(([file, groupRows]) => ({ file, rows: groupRows }))
}

function HighlightedText({ text, needle }: { text: string; needle: string }) {
    const cleanNeedle = literalSearchNeedle(needle)
    if (!cleanNeedle) return <>{text}</>
    const lower = text.toLowerCase()
    const lowerNeedle = cleanNeedle.toLowerCase()
    const index = lower.indexOf(lowerNeedle)
    if (index === -1) return <>{text}</>
    return (
        <>
            {text.slice(0, index)}
            <mark className="rounded bg-yellow-300/35 px-0.5 text-inherit dark:bg-yellow-300/25">
                {text.slice(index, index + cleanNeedle.length)}
            </mark>
            {text.slice(index + cleanNeedle.length)}
        </>
    )
}

function literalSearchNeedle(pattern: string): string {
    const trimmed = pattern.trim()
    if (!trimmed || /[\\^$.*+?()[\]{}|]/.test(trimmed)) return ""
    return trimmed
}

function languageFromPath(path: string): string {
    const ext = basename(path).split(".").pop()?.toLowerCase() ?? ""
    const map: Record<string, string> = {
        ts: "ts",
        tsx: "tsx",
        js: "js",
        jsx: "jsx",
        json: "json",
        md: "md",
        css: "css",
        scss: "scss",
        html: "html",
        mjs: "mjs",
        cjs: "cjs",
        py: "py",
        sh: "sh",
        yml: "yaml",
        yaml: "yaml",
        toml: "toml",
        sql: "sql",
    }
    return map[ext] ?? ext
}

function languageClass(language: string): string {
    if (language === "tsx" || language === "ts") return "bg-sky-500/10 text-sky-700 dark:text-sky-300"
    if (language === "jsx" || language === "js" || language === "mjs") return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
    if (language === "json") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    if (language === "md") return "bg-violet-500/10 text-violet-700 dark:text-violet-300"
    return "bg-muted text-muted-foreground"
}

function extensionDotClass(path: string): string {
    const language = languageFromPath(path)
    if (language === "tsx" || language === "ts") return "bg-sky-500"
    if (language === "jsx" || language === "js" || language === "mjs") return "bg-yellow-500"
    if (language === "json") return "bg-emerald-500"
    if (language === "md") return "bg-violet-500"
    return "bg-muted-foreground/45"
}

interface SearchWebsite {
    host: string
    url: string
    title: string
}

interface WebRequestItem {
    kind: "search" | "image" | "weather" | "finance" | "sports" | "time" | "open" | "click" | "find" | "screenshot"
    label: string
    href?: string
}

function SearchPreview({
    data,
    rawText,
    args,
}: {
    data: ParsedData
    rawText: string
    args: Record<string, unknown> | undefined
}) {
    const websites = searchWebsites(data, rawText)
    const requests = webRequestItems(data, args, rawText)
    if (!websites.length && !requests.length) {
        return null
    }
    return (
        <ul className="grid content-start items-start gap-1.5">
            {requests.slice(0, 12).map((request, index) => (
                <WebRequestRow key={`${request.kind}-${request.label}-${index}`} request={request} />
            ))}
            {websites.slice(0, 12).map((website, index) => {
                const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(website.host)}&sz=32`
                return (
                    <li key={`source-${website.host}-${index}`} className="min-w-0">
                        <a
                            href={website.url}
                            target="_blank"
                            rel="noreferrer"
                            title={website.title}
                            className="inline-flex max-w-full items-start gap-2 text-[14px] leading-5 text-muted-foreground transition-colors hover:text-foreground hover:underline"
                        >
                            <span className="relative mt-0.5 grid size-4 shrink-0 place-items-center overflow-hidden rounded-sm bg-background text-[10px] font-semibold uppercase text-muted-foreground">
                                {website.host[0]}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={faviconUrl}
                                    alt=""
                                    className="absolute inset-0 size-full bg-background object-contain"
                                    onError={event => { event.currentTarget.remove() }}
                                />
                            </span>
                            <span className="min-w-0 break-all">{website.url}</span>
                        </a>
                    </li>
                )
            })}
        </ul>
    )
}

function WebRequestRow({ request }: { request: WebRequestItem }) {
    const body = (
        <>
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">
                <WebRequestIcon kind={request.kind} />
            </span>
            <span className="min-w-0 break-words">{request.label}</span>
        </>
    )

    if (request.href) {
        return (
            <li className="min-w-0">
                <a
                    href={request.href}
                    target="_blank"
                    rel="noreferrer"
                    title={request.label}
                    className="inline-flex max-w-full items-start gap-2 text-[14px] leading-5 text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                    {body}
                </a>
            </li>
        )
    }

    return (
        <li className="inline-flex min-w-0 max-w-full items-start gap-2 text-[14px] leading-5 text-muted-foreground">
            {body}
        </li>
    )
}

function WebRequestIcon({ kind }: { kind: WebRequestItem["kind"] }) {
    if (kind === "weather") return <CloudSun className="size-3" />
    if (kind === "finance") return <LineChart className="size-3" />
    if (kind === "sports") return <Trophy className="size-3" />
    if (kind === "time") return <Clock3 className="size-3" />
    if (kind === "image") return <ImageIcon className="size-3" />
    if (kind === "screenshot") return <Camera className="size-3" />
    if (kind === "open" || kind === "click") return <ExternalLink className="size-3" />
    if (kind === "find") return <Search className="size-3" />
    return <Search className="size-3" />
}

function searchWebsites(data: ParsedData, rawText: string): SearchWebsite[] {
    const seen = new Set<string>()
    const websites: SearchWebsite[] = []

    for (const source of searchSources(data, rawText)) {
        const host = hostFromUrl(source.url)
        if (!host || seen.has(host)) continue
        seen.add(host)
        websites.push({
            host,
            url: normalizeUrl(source.url),
            title: source.title || host,
        })
    }

    return websites
}

function searchSources(data: ParsedData, rawText: string): SearchWebsite[] {
    const sources: SearchWebsite[] = []
    collectSearchSources(data, sources)
    for (const url of urlsFromText(rawText)) {
        sources.push({ url, host: "", title: hostFromUrl(url) || url })
    }
    return sources
}

function collectSearchSources(value: unknown, out: SearchWebsite[], depth = 0) {
    if (depth > 5 || value == null) return
    if (Array.isArray(value)) {
        value.forEach(item => collectSearchSources(item, out, depth + 1))
        return
    }
    if (typeof value === "string") {
        for (const url of urlsFromText(value)) {
            out.push({ url, host: "", title: hostFromUrl(url) || url })
        }
        return
    }
    const record = objectRecord(value)
    if (!record) return

    const directUrl = sourceUrl(record)
    if (directUrl) {
        out.push({
            url: directUrl,
            host: "",
            title: stringField(record, "title") || stringField(record, "name") || hostFromUrl(directUrl) || directUrl,
        })
    }

    Object.values(record).forEach(item => collectSearchSources(item, out, depth + 1))
}

function sourceUrl(item: Record<string, unknown>): string {
    return stringField(item, "url")
        || stringField(item, "uri")
        || stringField(item, "link")
        || stringField(item, "source_url")
        || stringField(item, "sourceUrl")
}

function webRequestItems(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): WebRequestItem[] {
    const items: WebRequestItem[] = [
        ...searchQueries(data, args, rawText).map(query => ({
            kind: "search" as const,
            label: `Search ${query}`,
            href: searchEngineUrl(query),
        })),
        ...imageSearchQueries(data, args, rawText).map(query => ({
            kind: "image" as const,
            label: `Image search ${query}`,
            href: searchEngineUrl(`${query} images`),
        })),
    ]

    for (const record of webDataRecords(data, args, rawText)) {
        collectWebActionItems(record, items)
    }

    const seen = new Set<string>()
    return items.filter(item => {
        const key = `${item.kind}:${item.label}:${item.href ?? ""}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function webDataRecords(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = []
    const addRecord = (value: unknown) => {
        const record = objectRecord(value)
        if (!record || records.includes(record)) return
        records.push(record)
        const action = objectRecord(record.action)
        if (action && !records.includes(action)) records.push(action)
    }

    addRecord(args)
    addRecord(data)
    addRecord(tryParseJson(rawText))
    return records
}

function collectWebActionItems(record: Record<string, unknown>, out: WebRequestItem[]) {
    collectWebCollection(record.weather, weatherRequestItem, out)
    collectWebCollection(record.finance, financeRequestItem, out)
    collectWebCollection(record.sports, sportsRequestItem, out)
    collectWebCollection(record.time, timeRequestItem, out)
    collectWebCollection(record.open, openRequestItem, out)
    collectWebCollection(record.click, clickRequestItem, out)
    collectWebCollection(record.find, findRequestItem, out)
    collectWebCollection(record.screenshot, screenshotRequestItem, out)

    const typed = typedWebActionItem(record)
    if (typed) out.push(typed)
}

function collectWebCollection(
    value: unknown,
    build: (value: unknown) => WebRequestItem | null,
    out: WebRequestItem[]
) {
    if (value === undefined || value === null) return
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
        const built = build(item)
        if (built) out.push(built)
    }
}

function typedWebActionItem(record: Record<string, unknown>): WebRequestItem | null {
    const type = normalizeWebActionType(stringField(record, "type") || stringField(record, "action"))
    if (type === "weather") return weatherRequestItem(record)
    if (type === "finance") return financeRequestItem(record)
    if (type === "sports") return sportsRequestItem(record)
    if (type === "time") return timeRequestItem(record)
    if (type === "open" || type === "openpage") return openRequestItem(record)
    if (type === "click") return clickRequestItem(record)
    if (type === "find" || type === "findinpage") return findRequestItem(record)
    if (type === "screenshot") return screenshotRequestItem(record)
    return null
}

function weatherRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const location = typeof value === "string"
        ? value
        : firstText(record?.location, record?.city, record?.place)
    if (!location) return null
    const start = firstText(record?.start, record?.date)
    const label = `Weather ${location}${start ? ` ${start}` : ""}`
    return { kind: "weather", label, href: searchEngineUrl(label) }
}

function financeRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const ticker = typeof value === "string"
        ? value
        : firstText(record?.ticker, record?.symbol)
    if (!ticker) return null
    const market = firstText(record?.market)
    const label = `Finance ${ticker}${market ? ` ${market}` : ""}`
    return { kind: "finance", label, href: searchEngineUrl(`${ticker} price ${market}`.trim()) }
}

function sportsRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record && typeof value !== "string") return null
    const league = typeof value === "string" ? value : firstText(record?.league)
    const fn = record ? firstText(record.fn, record.function, record.type) : ""
    const team = record ? firstText(record.team) : ""
    const opponent = record ? firstText(record.opponent) : ""
    const date = record ? firstText(record.date_from, record.dateFrom, record.date) : ""
    const parts = [league ? league.toUpperCase() : "", fn, team, opponent ? `vs ${opponent}` : "", date].filter(Boolean)
    if (!parts.length) return null
    const label = `Sports ${parts.join(" ")}`
    return { kind: "sports", label, href: searchEngineUrl(parts.join(" ")) }
}

function timeRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const target = typeof value === "string"
        ? value
        : firstText(record?.location, record?.utc_offset, record?.utcOffset, record?.timezone, record?.time_zone)
    if (!target) return null
    const label = `Time ${target}`
    return { kind: "time", label }
}

function openRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const target = typeof value === "string"
        ? value
        : firstText(record?.url, record?.ref_id, record?.refId)
    if (!target) return null
    return { kind: "open", label: `Open ${target}`, href: urlHref(target) }
}

function clickRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const target = firstText(record.ref_id, record.refId, record.url)
    const id = typeof record.id === "number" || typeof record.id === "string" ? String(record.id) : ""
    if (!target && !id) return null
    return { kind: "click", label: `Click ${[target, id ? `#${id}` : ""].filter(Boolean).join(" ")}`, href: urlHref(target) }
}

function findRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const pattern = firstText(record.pattern, record.query, record.text)
    const target = firstText(record.ref_id, record.refId, record.url)
    if (!pattern && !target) return null
    return { kind: "find", label: `Find ${pattern || "text"}${target ? ` in ${target}` : ""}`, href: urlHref(target) }
}

function screenshotRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const target = firstText(record.ref_id, record.refId, record.url)
    const page = typeof record.pageno === "number" || typeof record.pageno === "string" ? ` page ${record.pageno}` : ""
    if (!target && !page) return null
    return { kind: "screenshot", label: `Screenshot ${target}${page}`, href: urlHref(target) }
}

function normalizeWebActionType(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function urlHref(value: string): string | undefined {
    if (!value) return undefined
    return /^(https?:\/\/|www\.)/i.test(value) ? normalizeUrl(value) : undefined
}

function searchQueries(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): string[] {
    const root = objectRecord(data)
    const action = objectRecord(root?.action)
    const queries = [
        ...searchQueryValues(args),
        ...searchQueryValues(root),
        ...searchQueryValues(action),
    ]
    if (!queries.some(Boolean)) {
        const parsed = objectRecord(tryParseJson(rawText))
        queries.push(...searchQueryValues(parsed))
    }

    const seen = new Set<string>()
    return queries.map(cleanSearchQuery).filter(query => {
        if (!query || seen.has(query)) return false
        seen.add(query)
        return true
    })
}

function imageSearchQueries(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): string[] {
    const root = objectRecord(data)
    const action = objectRecord(root?.action)
    const queries = [
        ...imageQueryValues(args),
        ...imageQueryValues(root),
        ...imageQueryValues(action),
    ]
    if (!queries.some(Boolean)) {
        const parsed = objectRecord(tryParseJson(rawText))
        queries.push(...imageQueryValues(parsed))
    }

    const seen = new Set<string>()
    return queries.map(cleanSearchQuery).filter(query => {
        if (!query || seen.has(query)) return false
        seen.add(query)
        return true
    })
}

function searchQueryValues(value: unknown): string[] {
    const record = objectRecord(value)
    if (!record) return []

    const queries: string[] = []
    collectSearchQueryValue(record.q, queries)
    collectSearchQueryValue(record.query, queries)
    collectSearchQueryValue(record.queries, queries)
    collectSearchQueryValue(record.search_query, queries)
    collectSearchQueryValue(record.searchQuery, queries)

    const action = objectRecord(record.action)
    if (action) {
        collectSearchQueryValue(action.q, queries)
        collectSearchQueryValue(action.query, queries)
        collectSearchQueryValue(action.queries, queries)
        collectSearchQueryValue(action.search_query, queries)
        collectSearchQueryValue(action.searchQuery, queries)
    }

    return queries
}

function imageQueryValues(value: unknown): string[] {
    const record = objectRecord(value)
    if (!record) return []

    const queries: string[] = []
    collectSearchQueryValue(record.image_query, queries)
    collectSearchQueryValue(record.imageQuery, queries)

    const action = objectRecord(record.action)
    if (action) {
        collectSearchQueryValue(action.image_query, queries)
        collectSearchQueryValue(action.imageQuery, queries)
    }

    return queries
}

function collectSearchQueryValue(value: unknown, out: string[], depth = 0) {
    if (depth > 4 || value == null) return
    if (typeof value === "string") {
        out.push(value)
        return
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectSearchQueryValue(item, out, depth + 1))
        return
    }

    const record = objectRecord(value)
    if (!record) return

    const direct = stringField(record, "q") || stringField(record, "query")
    if (direct) out.push(direct)
    collectSearchQueryValue(record.queries, out, depth + 1)
    collectSearchQueryValue(record.search_query, out, depth + 1)
    collectSearchQueryValue(record.searchQuery, out, depth + 1)
}

function cleanSearchQuery(value: string): string {
    return value.replace(/\\"/g, "\"").replace(/\s+/g, " ").trim()
}

function urlsFromText(value: string): string[] {
    return Array.from(value.matchAll(/(?:https?:\/\/|www\.)[^\s"'<>)\]]+/g), match => (
        match[0].replace(/[.,;:!?]+$/, "")
    ))
}

function normalizeUrl(value: string): string {
    const trimmed = value.trim()
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
}

function hostFromUrl(value: string): string {
    try {
        return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
        return ""
    }
}

function searchEngineUrl(query: string): string {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

function SummaryRows({ rows }: { rows: Array<[string, unknown]> }) {
    return (
        <div className="grid gap-1 text-[12px]">
            {rows.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => (
                <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate font-mono text-foreground/85">{String(value)}</span>
                </div>
            ))}
        </div>
    )
}

function parseToolData(content: string): ParsedData {
    const raw = content.startsWith("Error: ") ? content.slice(7) : content
    if (!raw.trim()) return null
    try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function terminalText(entry: ToolCallReasoningEntry, data: ParsedData): string {
    const streamed = (entry.deltas ?? []).map(delta => delta.text).join("")
    const command = stringArg(entry.args, "command")
    const commandPrefix = command && !terminalTextContainsCommand(streamed, command)
        ? `\x1b[2m$ ${command}\x1b[0m\r\n`
        : ""
    const output = stringField(data, "output") || stringField(data, "stdout")
    const stderr = stringField(data, "stderr")
    const exitCode = numberField(data, "exitCode") ?? numberField(data, "exit_code")
    const fallback = data ? "" : entry.content.replace(/^Error:\s*/, "")
    const finalText = `${output || fallback}${stderr ? `\r\n\x1b[31m${stderr}\x1b[0m` : ""}`
    const exitText = typeof exitCode === "number" && exitCode !== 0 ? `\r\n\x1b[2m(exit ${exitCode})\x1b[0m` : ""
    const tail = `${finalText}${exitText}`
    if (!streamed) return `${commandPrefix}${tail}`
    if (!tail.trim()) return `${commandPrefix}${streamed}`
    if (terminalTextIncludes(streamed, tail)) return `${commandPrefix}${streamed}`
    const appendedTail = finalText.trim() && terminalTextIncludes(streamed, finalText)
        ? exitText
        : tail
    if (!appendedTail.trim() || terminalTextIncludes(streamed, appendedTail)) {
        return `${commandPrefix}${streamed}`
    }
    return `${commandPrefix}${streamed}${streamed.endsWith("\n") || streamed.endsWith("\r") ? "" : "\r\n"}${appendedTail}`
}

function terminalTextContainsCommand(text: string, command: string): boolean {
    if (!text || !command) return false
    const normalized = normalizeTerminalText(text)
    return normalized.includes(`$ ${command}`) || normalized.includes(command)
}

function terminalTextIncludes(haystack: string, needle: string): boolean {
    const normalizedHaystack = normalizeTerminalText(haystack)
    const normalizedNeedle = normalizeTerminalText(needle).trim()
    if (!normalizedNeedle) return true
    return normalizedHaystack.includes(normalizedNeedle)
}

function normalizeTerminalText(text: string): string {
    return text
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
    const value = args?.[key]
    return typeof value === "string" ? value : ""
}

function stringField(data: unknown, key: string): string {
    if (!data || typeof data !== "object" || Array.isArray(data)) return ""
    const value = (data as Record<string, unknown>)[key]
    return typeof value === "string" ? value : ""
}

function firstText(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== "string") continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return ""
}

function numberField(data: unknown, key: string): number | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
    const value = (data as Record<string, unknown>)[key]
    return typeof value === "number" ? value : undefined
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = args?.[key]
    return typeof value === "number" ? value : undefined
}

function booleanField(data: unknown, key: string): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false
    return (data as Record<string, unknown>)[key] === true
}

function arrayField(data: unknown, key: string): string[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) return []
    const value = (data as Record<string, unknown>)[key]
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function arrayRecordField(data: unknown, key: string): Record<string, unknown>[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) return []
    const value = (data as Record<string, unknown>)[key]
    return Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(objectRecord(item)))
        : []
}

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function tryParseJson(raw: string): unknown {
    const trimmed = raw.startsWith("Error: ") ? raw.slice(7).trim() : raw.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return null
    }
}
